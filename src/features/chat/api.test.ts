import { afterEach, describe, expect, it, vi } from "vitest"

import { ChatApiError, streamChat } from "./api"
import type { ChatStreamEvent } from "./chat-transport"

function sseResponse(blocks: readonly string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const block of blocks) controller.enqueue(encoder.encode(block))
      controller.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("streamChat", () => {
  it("parses streamed events across chunk boundaries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          'data: {"type":"conversation-id","conversationId":"chat-1"}\n\ndata: {"type":"text-delta","text":"Hel',
          'lo"}\n\ndata: {"type":"tool-call","name":"search_files"}\n\n',
          'data: {"type":"done"}\n\n',
        ])
      )
    )

    const events: ChatStreamEvent[] = []
    await streamChat({
      conversationId: null,
      message: "Hi",
      onEvent: (event) => events.push(event),
    })

    expect(events).toEqual([
      { type: "conversation-id", conversationId: "chat-1" },
      { type: "text-delta", text: "Hello" },
      { type: "tool-call", name: "search_files" },
      { type: "done" },
    ])
  })

  it("rejects a stream that ends without a terminal event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          'data: {"type":"conversation-id","conversationId":"chat-1"}\n\n',
          'data: {"type":"text-delta","text":"partial"}\n\n',
        ])
      )
    )

    await expect(
      streamChat({
        conversationId: null,
        message: "Hi",
        onEvent: () => {},
      })
    ).rejects.toMatchObject({ code: "UNAVAILABLE" })
  })

  it("rejects duplicate terminal events", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          'data: {"type":"conversation-id","conversationId":"chat-1"}\n\n',
          'data: {"type":"done"}\n\ndata: {"type":"done"}\n\n',
        ])
      )
    )

    await expect(
      streamChat({
        conversationId: null,
        message: "Hi",
        onEvent: () => {},
      })
    ).rejects.toMatchObject({ code: "UNAVAILABLE" })
  })

  it("rejects a stream whose first event does not accept the turn", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          'data: {"type":"text-delta","text":"orphan"}\n\n',
          'data: {"type":"done"}\n\n',
        ])
      )
    )

    await expect(
      streamChat({
        conversationId: null,
        message: "Hi",
        onEvent: () => {},
      })
    ).rejects.toMatchObject({ code: "UNAVAILABLE" })
  })

  it("throws a typed error when the request is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: "USAGE_LIMIT_EXCEEDED",
              message: "The AI usage limit has been reached.",
            },
            requestId: "req-1",
          },
          { status: 429 }
        )
      )
    )

    await expect(
      streamChat({
        conversationId: null,
        message: "Hi",
        onEvent: () => {},
      })
    ).rejects.toMatchObject(
      new ChatApiError(
        "USAGE_LIMIT_EXCEEDED",
        "The AI usage limit has been reached."
      )
    )
  })
})
