import { err, ok } from "neverthrow"
import { describe, expect, it, vi } from "vitest"

import type { AiStream } from "@/server/ai/ai-provider"
import { sseResponse } from "./api.chat"

function parseEvents(response: Response) {
  return response.text().then((body) =>
    body
      .split("\n\n")
      .filter(Boolean)
      .map((block) => JSON.parse(block.replace(/^data: /u, "")))
  )
}

describe("chat SSE response", () => {
  it("sends the accepted conversation before a provider pre-stream error", async () => {
    async function* stream(): AiStream {
      yield err({
        code: "UNAVAILABLE",
        message: "Provider unavailable.",
        retryable: true,
      })
    }

    const events = await parseEvents(sseResponse(stream(), "chat-1", "req-1"))

    expect(events).toEqual([
      { type: "conversation-id", conversationId: "chat-1" },
      {
        type: "error",
        error: { code: "UNAVAILABLE", message: "Provider unavailable." },
      },
    ])
  })

  it("logs unexpected iterator failures and sends a generic terminal error", async () => {
    const cause = new Error("internal details")
    async function* stream(): AiStream {
      yield ok({ type: "text-delta", text: "partial" })
      throw cause
    }
    const log = vi.spyOn(console, "error").mockImplementation(() => {})

    const events = await parseEvents(sseResponse(stream(), "chat-1", "req-7"))

    expect(events).toEqual([
      { type: "conversation-id", conversationId: "chat-1" },
      { type: "text-delta", text: "partial" },
      {
        type: "error",
        error: {
          code: "UNAVAILABLE",
          message: "The assistant is temporarily unavailable.",
        },
      },
    ])
    expect(log).toHaveBeenCalledWith("Chat stream failed unexpectedly.", {
      requestId: "req-7",
      cause,
    })
    log.mockRestore()
  })

  it("turns a missing finish into a terminal error", async () => {
    async function* stream(): AiStream {
      yield ok({ type: "text-delta", text: "partial" })
    }

    const events = await parseEvents(sseResponse(stream(), "chat-1", "req-1"))

    expect(events.at(-1)).toEqual({
      type: "error",
      error: {
        code: "INVALID_RESPONSE",
        message: "The AI provider stream ended unexpectedly.",
      },
    })
  })

  it("does not classify response enqueue failures as server failures", async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let cleanedUp = false
    async function* stream(): AiStream {
      try {
        await gate
        yield ok({ type: "text-delta", text: "too late" })
      } finally {
        cleanedUp = true
      }
    }
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const response = sseResponse(stream(), "chat-1", "req-1")
    const reader = response.body!.getReader()

    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain("conversation-id")
    await reader.cancel()
    release?.()
    await vi.waitFor(() => expect(cleanedUp).toBe(true))

    expect(log).not.toHaveBeenCalled()
    log.mockRestore()
  })
})
