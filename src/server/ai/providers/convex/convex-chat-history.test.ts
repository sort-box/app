import { describe, expect, it, vi } from "vitest"

import { ConvexChatHistory } from "./convex-chat-history.server"

type FetchCall = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>

const context = {
  authToken: "auth-token",
  convexSiteUrl: "https://example.convex.site/",
  serviceSecret: "s".repeat(32),
}

describe("ConvexChatHistory", () => {
  it("refreshes the auth token for each history request", async () => {
    const getAuthToken = vi.fn(async () => "fresh-token")
    const fetchMock = vi.fn<FetchCall>(async () =>
      Response.json({ conversationId: "chat-1", messages: [] })
    )
    const history = new ConvexChatHistory(
      { ...context, getAuthToken },
      fetchMock as typeof fetch
    )

    await history.startTurn({ conversationId: null, content: "Hello" })

    expect(getAuthToken).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer fresh-token",
    })
  })

  it("sends the start contract and decodes stored tool calls", async () => {
    const fetchMock = vi.fn<FetchCall>(async () =>
      Response.json({
        conversationId: "chat-1",
        messages: [
          { role: "user", content: "Find it" },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call-1",
                name: "search_files",
                argumentsJson: '{"query":"term"}',
              },
            ],
          },
        ],
      })
    )
    const history = new ConvexChatHistory(context, fetchMock as typeof fetch)

    const result = await history.startTurn({
      conversationId: null,
      content: "Find it",
    })

    expect(result._unsafeUnwrap()).toEqual({
      conversationId: "chat-1",
      messages: [
        { role: "user", content: "Find it" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-1",
              name: "search_files",
              arguments: { query: "term" },
            },
          ],
        },
      ],
    })
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.convex.site/internal/ai/chat-history",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer auth-token",
          "Content-Type": "application/json",
          "x-file-service-secret": "s".repeat(32),
        },
        body: JSON.stringify({
          operation: "start",
          conversationId: null,
          content: "Find it",
        }),
      })
    )
  })

  it("serializes assistant tool-call arguments when appending", async () => {
    const fetchMock = vi.fn<FetchCall>(async () => Response.json(null))
    const history = new ConvexChatHistory(context, fetchMock as typeof fetch)

    const result = await history.appendMessages({
      conversationId: "chat-1",
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-1",
              name: "read_file",
              arguments: { file_id: "file-1" },
            },
          ],
        },
      ],
    })

    expect(result.isOk()).toBe(true)
    const init = fetchMock.mock.calls[0]?.[1]
    expect(JSON.parse(String(init?.body))).toEqual({
      operation: "append",
      conversationId: "chat-1",
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-1",
              name: "read_file",
              argumentsJson: '{"file_id":"file-1"}',
            },
          ],
        },
      ],
    })
  })

  it.each([
    [404, "NOT_FOUND"],
    [500, "UNAVAILABLE"],
  ] as const)("maps HTTP %s to %s", async (status, code) => {
    const history = new ConvexChatHistory(
      context,
      vi.fn(async () => new Response(null, { status })) as typeof fetch
    )

    const result = await history.startTurn({
      conversationId: "chat-1",
      content: "Again",
    })

    expect(result.isErr() && result.error.code).toBe(code)
  })

  it("rejects malformed successful responses", async () => {
    const history = new ConvexChatHistory(
      context,
      vi.fn(async () => Response.json({ conversationId: 1 })) as typeof fetch
    )

    const result = await history.startTurn({
      conversationId: null,
      content: "Hello",
    })

    expect(result.isErr() && result.error).toEqual({
      code: "UNAVAILABLE",
      retryable: true,
    })
  })
})
