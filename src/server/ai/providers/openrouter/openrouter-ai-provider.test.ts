import { describe, expect, it, vi } from "vitest"

import type { AiStream, AiStreamEvent } from "../../ai-provider"
import {
  OPENROUTER_MODEL,
  OpenRouterAiProvider,
} from "./openrouter-ai-provider.server"

const encoder = new TextEncoder()

function streamResponse(...chunks: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } }
  )
}

function sse(...data: unknown[]): Response {
  return streamResponse(
    ...data.map((item) =>
      item === "[DONE]"
        ? "data: [DONE]\n\n"
        : `data: ${JSON.stringify(item)}\n\n`
    )
  )
}

async function collect(stream: AiStream) {
  const events: AiStreamEvent[] = []
  for await (const result of stream) {
    if (result.isErr()) return { events, error: result.error }
    events.push(result.value)
  }
  return { events }
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>) {
  const init = fetchMock.mock.calls[0][1] as RequestInit
  return JSON.parse(init.body as string)
}

describe("OpenRouterAiProvider requests", () => {
  it("translates conversation history and tool definitions", async () => {
    const fetchMock = vi.fn(async () =>
      sse(
        {
          choices: [{ delta: { content: "Done" }, finish_reason: "stop" }],
        },
        "[DONE]"
      )
    )
    const abortController = new AbortController()
    const provider = new OpenRouterAiProvider("test-api-key", fetchMock)

    const result = await provider.streamConversation({
      systemPrompt: "Be concise.",
      messages: [
        { role: "user", content: "Find the file" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-1",
              name: "find_file",
              arguments: { name: "notes.txt" },
            },
          ],
        },
        { role: "tool", toolCallId: "call-1", content: "Found it" },
      ],
      tools: [
        {
          name: "find_file",
          description: "Find a file by name.",
          inputSchema: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
        },
      ],
      abortSignal: abortController.signal,
    })

    expect(result.isOk()).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer test-api-key",
          "Content-Type": "application/json",
        },
        signal: abortController.signal,
      })
    )
    expect(requestBody(fetchMock)).toEqual({
      model: OPENROUTER_MODEL,
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Find the file" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "find_file",
                arguments: '{"name":"notes.txt"}',
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "call-1", content: "Found it" },
      ],
      stream: true,
      stream_options: { include_usage: true },
      tools: [
        {
          type: "function",
          function: {
            name: "find_file",
            description: "Find a file by name.",
            parameters: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            },
          },
        },
      ],
    })
  })

  it("rejects missing configuration and invalid input without a request", async () => {
    const fetchMock = vi.fn()

    const missingKey = await new OpenRouterAiProvider(
      "",
      fetchMock
    ).streamConversation({ messages: [{ role: "user", content: "Hello" }] })
    const invalidInput = await new OpenRouterAiProvider(
      "test-key",
      fetchMock
    ).streamConversation({ messages: [] })

    expect(missingKey.isErr() && missingKey.error.code).toBe(
      "CONFIGURATION_ERROR"
    )
    expect(invalidInput.isErr() && invalidInput.error.code).toBe(
      "INVALID_INPUT"
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("OpenRouterAiProvider streams", () => {
  it("parses text split across network chunks and includes final usage", async () => {
    const first =
      'data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\n\n'
    const second =
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n'
    const usage =
      'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\n'
    const fetchMock = vi.fn(async () =>
      streamResponse(
        ": OPENROUTER PROCESSING\n\n" + first.slice(0, 21),
        first.slice(21) + second + usage.slice(0, 17),
        usage.slice(17) + "data: [DONE]\n\n"
      )
    )
    const result = await new OpenRouterAiProvider(
      "test-key",
      fetchMock
    ).streamConversation({ messages: [{ role: "user", content: "Hello" }] })

    expect(result.isOk()).toBe(true)
    if (result.isErr()) return
    await expect(collect(result.value)).resolves.toEqual({
      events: [
        { type: "text-delta", text: "Hel" },
        { type: "text-delta", text: "lo" },
        {
          type: "finish",
          reason: "stop",
          usage: { inputTokens: 12, outputTokens: 3 },
        },
      ],
    })
  })

  it("assembles fragmented parallel tool calls in index order", async () => {
    const fetchMock = vi.fn(async () =>
      sse(
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 1,
                    id: "call-2",
                    function: { name: "second", arguments: '{"b"' },
                  },
                  {
                    index: 0,
                    id: "call-1",
                    function: { name: "first", arguments: '{"a":' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: "1}" } },
                  { index: 1, function: { arguments: ":true}" } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
        "[DONE]"
      )
    )
    const result = await new OpenRouterAiProvider(
      "test-key",
      fetchMock
    ).streamConversation({ messages: [{ role: "user", content: "Run both" }] })

    expect(result.isOk()).toBe(true)
    if (result.isErr()) return
    await expect(collect(result.value)).resolves.toEqual({
      events: [
        {
          type: "tool-call",
          call: { id: "call-1", name: "first", arguments: { a: 1 } },
        },
        {
          type: "tool-call",
          call: { id: "call-2", name: "second", arguments: { b: true } },
        },
        { type: "finish", reason: "tool-calls" },
      ],
    })
  })

  it("returns a sanitized error for a malformed tool call", async () => {
    const fetchMock = vi.fn(async () =>
      sse(
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    function: { name: "broken", arguments: "not-json" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
        "[DONE]"
      )
    )
    const result = await new OpenRouterAiProvider(
      "test-key",
      fetchMock
    ).streamConversation({ messages: [{ role: "user", content: "Run" }] })

    expect(result.isOk()).toBe(true)
    if (result.isErr()) return
    const collected = await collect(result.value)
    expect(collected).toMatchObject({ error: { code: "INVALID_RESPONSE" } })
  })
})

describe("OpenRouterAiProvider failures", () => {
  it.each([
    { status: 400, code: "INVALID_INPUT" },
    { status: 401, code: "AUTHENTICATION_FAILED" },
    { status: 402, code: "CONFIGURATION_ERROR" },
    { status: 403, code: "CONFIGURATION_ERROR" },
    { status: 429, code: "RATE_LIMITED" },
    { status: 503, code: "UNAVAILABLE" },
    { status: 418, code: "INVALID_RESPONSE" },
  ])(
    "maps HTTP $status without exposing its body",
    async ({ status, code }) => {
      const fetchMock = vi.fn(async () =>
        Response.json({ error: "secret provider detail" }, { status })
      )
      const result = await new OpenRouterAiProvider(
        "test-key",
        fetchMock
      ).streamConversation({ messages: [{ role: "user", content: "Hello" }] })

      expect(result.isErr()).toBe(true)
      if (result.isOk()) return
      expect(result.error.code).toBe(code)
      expect(result.error.message).not.toContain("secret provider detail")
    }
  )

  it("maps a mid-stream provider error without exposing its message", async () => {
    const fetchMock = vi.fn(async () =>
      sse({
        error: { code: "server_error", message: "secret upstream detail" },
        choices: [{ delta: {}, finish_reason: "error" }],
      })
    )
    const result = await new OpenRouterAiProvider(
      "test-key",
      fetchMock
    ).streamConversation({ messages: [{ role: "user", content: "Hello" }] })

    expect(result.isOk()).toBe(true)
    if (result.isErr()) return
    const collected = await collect(result.value)
    expect(collected).toMatchObject({ error: { code: "UNAVAILABLE" } })
    expect(collected.error?.message).not.toContain("secret upstream detail")
  })

  it("maps an aborted request to cancellation", async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException("Aborted", "AbortError")
    })
    const result = await new OpenRouterAiProvider(
      "test-key",
      fetchMock
    ).streamConversation({ messages: [{ role: "user", content: "Hello" }] })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.code).toBe("CANCELLED")
  })
})
