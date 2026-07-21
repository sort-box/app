import { err, errAsync, ok, okAsync } from "neverthrow"
import { describe, expect, it, vi } from "vitest"

import type {
  AiMessage,
  AiProvider,
  AiStream,
  AiStreamEvent,
  StreamConversationInput,
} from "./ai-provider"
import {
  MAX_STORED_MESSAGE_BYTES,
  MAX_TOOL_RESULT_OUTPUT_BYTES,
  utf8ByteLength,
} from "./chat-history-contract"
import { FileToolConversationService } from "./file-tool-conversation"
import type { FileToolExecutor } from "./file-tools"
import type { AiMessageRecorder } from "./message-recorder"

async function* events(values: readonly AiStreamEvent[]): AiStream {
  for (const value of values) yield ok(value)
}

async function collect(stream: AiStream) {
  const results = []
  for await (const result of stream) results.push(result)
  return results
}

function provider(streams: readonly AiStream[]) {
  let index = 0
  return {
    streamConversation: vi.fn((_input: StreamConversationInput) =>
      okAsync(streams[index++]!)
    ),
  } satisfies AiProvider
}

function executor(): FileToolExecutor {
  return {
    listFiles: vi.fn(() =>
      okAsync({
        entries: [{ path: "/reports", kind: "directory" as const }],
      })
    ),
    searchFiles: vi.fn(() =>
      okAsync({
        matches: [
          {
            file_id: "file-1",
            path: "/reports/revenue.pdf",
            excerpt: "Revenue increased.",
            heading_path: ["Financials"],
            location: { kind: "page" as const, page: 3 },
          },
        ],
        incomplete: false,
      })
    ),
    findExactReferences: vi.fn(() =>
      okAsync({
        matches: [],
        scanned_ready_files: 1,
        scanned_indexed_files: 1,
        unsearchable_ready_files: 0,
        complete: true,
      })
    ),
    readFile: vi.fn(() =>
      okAsync({
        file: {
          file_id: "file-1",
          path: "/reports/revenue.pdf",
          content_type: "application/pdf",
        },
        chunks: [],
      })
    ),
    proposeFileOrganization: vi.fn(() =>
      okAsync({ plan_id: "plan-1", revision: 1 })
    ),
  }
}

describe("FileToolConversationService", () => {
  it("continues beyond six tool rounds until the model finishes", async () => {
    const toolRounds = Array.from({ length: 7 }, (_, index) =>
      events([
        {
          type: "tool-call",
          call: {
            id: `call-${index}`,
            name: "list_files",
            arguments: { path: "/" },
          },
        },
        {
          type: "finish",
          reason: "tool-calls",
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      ])
    )
    const finalRound = events([
      { type: "text-delta", text: "Proposal ready." },
      {
        type: "finish",
        reason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ])
    const inner = provider([...toolRounds, finalRound])
    const service = new FileToolConversationService(inner, executor())
    const started = await service.streamConversation(
      { messages: [{ role: "user", content: "Organize everything" }] },
      undefined,
      "chat-1"
    )
    if (started.isErr()) throw new Error("conversation failed")

    const results = await collect(started.value)

    expect(inner.streamConversation).toHaveBeenCalledTimes(8)
    expect(
      results.some(
        (result) =>
          result.isOk() &&
          result.value.type === "text-delta" &&
          result.value.text.includes("file-operation limit")
      )
    ).toBe(false)
    expect(results.at(-1)?._unsafeUnwrap()).toMatchObject({
      type: "finish",
      reason: "stop",
    })
  })

  it("retries a transient tool failure before returning it to the model", async () => {
    const first = events([
      {
        type: "tool-call",
        call: {
          id: "call-retry",
          name: "search_files",
          arguments: { query: "admissions" },
        },
      },
      {
        type: "finish",
        reason: "tool-calls",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ])
    const second = events([
      { type: "text-delta", text: "Done." },
      {
        type: "finish",
        reason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ])
    const inner = provider([first, second])
    const tools = executor()
    tools.searchFiles = vi
      .fn()
      .mockReturnValueOnce(
        errAsync({
          code: "UNAVAILABLE" as const,
          message: "Temporarily unavailable.",
          retryable: true as const,
        })
      )
      .mockReturnValueOnce(okAsync({ matches: [], incomplete: false as const }))
    const service = new FileToolConversationService(inner, tools)
    const started = await service.streamConversation(
      { messages: [{ role: "user", content: "Organize my files" }] },
      undefined,
      "chat-1"
    )
    if (started.isErr()) throw new Error("conversation failed")

    await collect(started.value)

    expect(tools.searchFiles).toHaveBeenCalledTimes(2)
    const continuation = inner.streamConversation.mock.calls[1][0]
    expect(continuation.messages.at(-1)).toMatchObject({
      role: "tool",
      content: expect.stringContaining('"ok":true'),
    })
  })

  it("executes a validated tool call and continues the conversation", async () => {
    const first = events([
      {
        type: "tool-call",
        call: {
          id: "call-1",
          name: "search_files",
          arguments: { query: "revenue", limit: 5 },
        },
      },
      {
        type: "finish",
        reason: "tool-calls",
        usage: { inputTokens: 10, outputTokens: 2 },
      },
    ])
    const second = events([
      { type: "text-delta", text: "Revenue increased." },
      {
        type: "finish",
        reason: "stop",
        usage: { inputTokens: 20, outputTokens: 4 },
      },
    ])
    const inner = provider([first, second])
    const tools = executor()
    const recorder = {
      recordMessages: vi.fn((_messages: readonly AiMessage[]) =>
        okAsync(undefined)
      ),
    } satisfies AiMessageRecorder
    const result = await new FileToolConversationService(
      inner,
      tools
    ).streamConversation(
      { messages: [{ role: "user", content: "Find it" }] },
      recorder
    )

    expect(result.isOk()).toBe(true)
    if (result.isErr()) return
    const output = await collect(result.value)

    expect(tools.searchFiles).toHaveBeenCalledWith({
      query: "revenue",
      limit: 5,
    })
    expect(inner.streamConversation).toHaveBeenCalledTimes(2)
    const continuation = inner.streamConversation.mock.calls[1][0]
    expect(continuation.tools?.map((tool) => tool.name)).toEqual([
      "list_files",
      "search_files",
      "find_exact_references",
      "read_file",
      "propose_file_organization",
    ])
    expect(continuation.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "call-1",
    })
    const toolMessage = continuation.messages.at(-1) as Extract<
      AiMessage,
      { role: "tool" }
    >
    expect(JSON.parse(toolMessage.content)).toMatchObject({
      ok: true,
      value: {
        matches: [{ file_id: "file-1", excerpt: "Revenue increased." }],
      },
    })
    expect(recorder.recordMessages).toHaveBeenNthCalledWith(1, [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "search_files",
            arguments: { query: "revenue", limit: 5 },
          },
        ],
      },
      expect.objectContaining({ role: "tool", toolCallId: "call-1" }),
    ])
    expect(recorder.recordMessages).toHaveBeenNthCalledWith(2, [
      { role: "assistant", content: "Revenue increased." },
    ])
    expect(recorder.recordMessages).toHaveBeenCalledTimes(2)
    expect(recorder.recordMessages.mock.calls[0]?.[0]?.[1]).toEqual(toolMessage)
    expect(output.map((item) => item._unsafeUnwrap())).toEqual([
      {
        type: "tool-call",
        call: {
          id: "call-1",
          name: "search_files",
          arguments: { query: "revenue", limit: 5 },
        },
      },
      { type: "text-delta", text: "Revenue increased." },
      {
        type: "finish",
        reason: "stop",
        usage: { inputTokens: 30, outputTokens: 6 },
      },
    ])
  })

  it("returns invalid arguments to the model without calling the executor", async () => {
    const inner = provider([
      events([
        {
          type: "tool-call",
          call: {
            id: "call-1",
            name: "search_files",
            arguments: { query: " " },
          },
        },
        { type: "finish", reason: "tool-calls" },
      ]),
      events([
        { type: "text-delta", text: "I could not search." },
        { type: "finish", reason: "stop" },
      ]),
    ])
    const tools = executor()
    const result = await new FileToolConversationService(
      inner,
      tools
    ).streamConversation({ messages: [{ role: "user", content: "Search" }] })

    expect(result.isOk()).toBe(true)
    if (result.isErr()) return
    await collect(result.value)

    expect(tools.searchFiles).not.toHaveBeenCalled()
    const toolMessage = inner.streamConversation.mock.calls[1][0].messages.at(
      -1
    ) as Extract<AiMessage, { role: "tool" }>
    expect(JSON.parse(toolMessage.content)).toEqual({
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "The file tool call was invalid.",
        retryable: false,
      },
    })
  })

  it("rejects an incomplete proposal and lets the model repair it in the same turn", async () => {
    const listRound = events([
      {
        type: "tool-call",
        call: { id: "list-1", name: "list_files", arguments: { path: "/" } },
      },
      { type: "finish", reason: "tool-calls" },
    ])
    const incompleteRound = events([
      {
        type: "tool-call",
        call: {
          id: "proposal-1",
          name: "propose_file_organization",
          arguments: {
            summary: "Organize the workspace.",
            operations: [
              { before_path: "/resume.pdf", after_path: "/Career/resume.pdf" },
            ],
          },
        },
      },
      { type: "finish", reason: "tool-calls" },
    ])
    const repairedRound = events([
      {
        type: "tool-call",
        call: {
          id: "proposal-2",
          name: "propose_file_organization",
          arguments: {
            summary: "Organize the workspace.",
            unchanged_paths: ["/notes.txt"],
            operations: [
              { before_path: "/resume.pdf", after_path: "/Career/resume.pdf" },
            ],
          },
        },
      },
      { type: "finish", reason: "tool-calls" },
    ])
    const inner = provider([
      listRound,
      incompleteRound,
      repairedRound,
      events([{ type: "finish", reason: "stop" }]),
    ])
    const tools = executor()
    tools.listFiles = vi.fn(() =>
      okAsync({
        entries: [
          { path: "/resume.pdf", kind: "file" as const },
          { path: "/notes.txt", kind: "file" as const },
        ],
      })
    )
    const result = await new FileToolConversationService(
      inner,
      tools
    ).streamConversation(
      { messages: [{ role: "user", content: "Organize everything" }] },
      undefined,
      "chat-1"
    )

    expect(result.isOk()).toBe(true)
    if (result.isErr()) return
    await collect(result.value)

    expect(tools.proposeFileOrganization).toHaveBeenCalledOnce()
    const repairMessage =
      inner.streamConversation.mock.calls[2][0].messages.find(
        (message): message is Extract<AiMessage, { role: "tool" }> =>
          message.role === "tool" && message.toolCallId === "proposal-1"
      )
    expect(repairMessage).toBeDefined()
    if (!repairMessage) return
    expect(JSON.parse(repairMessage.content)).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: expect.stringContaining("/notes.txt"),
      },
    })
  })

  it("returns typed executor failures to the model", async () => {
    const inner = provider([
      events([
        {
          type: "tool-call",
          call: {
            id: "call-1",
            name: "read_file",
            arguments: { file_id: "missing" },
          },
        },
        { type: "finish", reason: "tool-calls" },
      ]),
      events([{ type: "finish", reason: "stop" }]),
    ])
    const tools = executor()
    tools.readFile = vi.fn(() =>
      errAsync({
        code: "FILE_NOT_FOUND" as const,
        message: "The file was not found.",
        retryable: false,
      })
    )
    const result = await new FileToolConversationService(
      inner,
      tools
    ).streamConversation({ messages: [{ role: "user", content: "Read it" }] })

    expect(result.isOk()).toBe(true)
    if (result.isErr()) return
    await collect(result.value)

    const toolMessage = inner.streamConversation.mock.calls[1][0].messages.at(
      -1
    ) as Extract<AiMessage, { role: "tool" }>
    expect(JSON.parse(toolMessage.content)).toEqual({
      ok: false,
      error: {
        code: "FILE_NOT_FOUND",
        message: "The file was not found.",
        retryable: false,
      },
    })
  })

  it("rejects caller-supplied tools", async () => {
    const inner = provider([])
    const result = await new FileToolConversationService(
      inner,
      executor()
    ).streamConversation({
      messages: [{ role: "user", content: "Hello" }],
      tools: [
        {
          name: "other_tool",
          description: "Not supported.",
          inputSchema: { type: "object" },
        },
      ],
    })

    expect(result.isErr() && result.error.code).toBe("INVALID_INPUT")
    expect(inner.streamConversation).not.toHaveBeenCalled()
  })

  it("bounds excessive parallel tool calls instead of failing the turn", async () => {
    const calls = Array.from({ length: 9 }, (_, index) => ({
      id: `call-${index}`,
      name: "list_files",
      arguments: {},
    }))
    const inner = provider([
      events([
        ...calls.map((call): AiStreamEvent => ({ type: "tool-call", call })),
        { type: "finish", reason: "tool-calls" },
      ]),
      events([
        { type: "text-delta", text: "I checked the first batch." },
        { type: "finish", reason: "stop" },
      ]),
    ])
    const tools = executor()
    const result = await new FileToolConversationService(
      inner,
      tools
    ).streamConversation({ messages: [{ role: "user", content: "List" }] })

    expect(result.isOk()).toBe(true)
    if (result.isErr()) return
    const output = await collect(result.value)

    expect(tools.listFiles).toHaveBeenCalledTimes(8)
    expect(output.at(-1)?._unsafeUnwrap()).toMatchObject({
      type: "finish",
      reason: "stop",
    })
  })

  it.each(["UNAVAILABLE", "CANCELLED"] as const)(
    "persists partial text before propagating %s",
    async (code) => {
      async function* interrupted(): AiStream {
        yield ok({ type: "text-delta", text: "A partial answer" })
        yield err(
          code === "CANCELLED"
            ? { code, message: "Cancelled." }
            : { code, message: "Unavailable.", retryable: true }
        )
      }
      const recorder = {
        recordMessages: vi.fn(() => okAsync(undefined)),
      } satisfies AiMessageRecorder
      const result = await new FileToolConversationService(
        provider([interrupted()]),
        executor()
      ).streamConversation(
        { messages: [{ role: "user", content: "Hello" }] },
        recorder
      )

      expect(result.isOk()).toBe(true)
      if (result.isErr()) return
      const output = await collect(result.value)

      expect(output.at(-1)?.isErr()).toBe(true)
      expect(recorder.recordMessages).toHaveBeenCalledOnce()
      expect(recorder.recordMessages).toHaveBeenCalledWith([
        { role: "assistant", content: "A partial answer" },
      ])
    }
  )

  it("persists partial text when the consumer disconnects", async () => {
    const recorder = {
      recordMessages: vi.fn(() => okAsync(undefined)),
    } satisfies AiMessageRecorder
    const result = await new FileToolConversationService(
      provider([
        events([
          { type: "text-delta", text: "Visible before disconnect" },
          { type: "finish", reason: "stop" },
        ]),
      ]),
      executor()
    ).streamConversation(
      { messages: [{ role: "user", content: "Hello" }] },
      recorder
    )

    expect(result.isOk()).toBe(true)
    if (result.isErr()) return
    const iterator = result.value[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.return?.()

    expect(recorder.recordMessages).toHaveBeenCalledOnce()
    expect(recorder.recordMessages).toHaveBeenCalledWith([
      { role: "assistant", content: "Visible before disconnect" },
    ])
  })

  it("persists partial text exactly once when the finish event is missing", async () => {
    const recorder = {
      recordMessages: vi.fn(() => okAsync(undefined)),
    } satisfies AiMessageRecorder
    const result = await new FileToolConversationService(
      provider([events([{ type: "text-delta", text: "Unfinished" }])]),
      executor()
    ).streamConversation(
      { messages: [{ role: "user", content: "Hello" }] },
      recorder
    )

    expect(result.isOk()).toBe(true)
    if (result.isErr()) return
    const output = await collect(result.value)

    expect(output.at(-1)?.isErr()).toBe(true)
    expect(recorder.recordMessages).toHaveBeenCalledOnce()
    expect(recorder.recordMessages).toHaveBeenCalledWith([
      { role: "assistant", content: "Unfinished" },
    ])
  })

  it("does not retry an uncertain partial-history write", async () => {
    async function* interrupted(): AiStream {
      yield ok({ type: "text-delta", text: "Possibly stored" })
      yield err({
        code: "UNAVAILABLE",
        message: "Provider unavailable.",
        retryable: true,
      })
    }
    const recorder = {
      recordMessages: vi.fn(() =>
        errAsync({
          code: "UNAVAILABLE" as const,
          message: "History response was uncertain.",
          retryable: true as const,
        })
      ),
    } satisfies AiMessageRecorder
    const result = await new FileToolConversationService(
      provider([interrupted()]),
      executor()
    ).streamConversation(
      { messages: [{ role: "user", content: "Hello" }] },
      recorder
    )

    expect(result.isOk()).toBe(true)
    if (result.isErr()) return
    await collect(result.value)

    expect(recorder.recordMessages).toHaveBeenCalledOnce()
  })

  it("stops before emitting assistant text that cannot be persisted", async () => {
    const fits = "a".repeat(MAX_STORED_MESSAGE_BYTES)
    const recorder = {
      recordMessages: vi.fn(() => okAsync(undefined)),
    } satisfies AiMessageRecorder
    const result = await new FileToolConversationService(
      provider([
        events([
          { type: "text-delta", text: fits },
          { type: "text-delta", text: "b" },
          { type: "finish", reason: "stop" },
        ]),
      ]),
      executor()
    ).streamConversation(
      { messages: [{ role: "user", content: "Hello" }] },
      recorder
    )

    expect(result.isOk()).toBe(true)
    if (result.isErr()) return
    const output = await collect(result.value)

    expect(output[0]?._unsafeUnwrap()).toEqual({
      type: "text-delta",
      text: fits,
    })
    expect(output).toHaveLength(2)
    expect(output[1]?.isErr()).toBe(true)
    expect(recorder.recordMessages).toHaveBeenCalledOnce()
    expect(recorder.recordMessages).toHaveBeenCalledWith([
      { role: "assistant", content: fits },
    ])
  })

  it("turns an oversized serialized tool result into a bounded tool failure", async () => {
    const inner = provider([
      events([
        {
          type: "tool-call",
          call: { id: "call-1", name: "list_files", arguments: {} },
        },
        { type: "finish", reason: "tool-calls" },
      ]),
      events([{ type: "finish", reason: "stop" }]),
    ])
    const tools = executor()
    tools.listFiles = vi.fn(() =>
      okAsync({
        entries: Array.from({ length: 2_000 }, (_, index) => ({
          path: `/files/${index}-${"x".repeat(80)}`,
          kind: "file" as const,
          index_status: "ready" as const,
        })),
      })
    )
    const result = await new FileToolConversationService(
      inner,
      tools
    ).streamConversation({ messages: [{ role: "user", content: "List" }] })

    expect(result.isOk()).toBe(true)
    if (result.isErr()) return
    await collect(result.value)
    const toolMessage = inner.streamConversation.mock.calls[1][0].messages.at(
      -1
    ) as Extract<AiMessage, { role: "tool" }>

    expect(utf8ByteLength(toolMessage.content)).toBeLessThanOrEqual(
      MAX_TOOL_RESULT_OUTPUT_BYTES
    )
    expect(JSON.parse(toolMessage.content)).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE" },
    })
  })
})
