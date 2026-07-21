/// <reference types="vite/client" />
import { convexTest } from "convex-test"
import { afterEach, describe, expect, it, vi } from "vitest"

import { api, internal } from "./_generated/api"
import schema from "./schema"

const ragTestModule = "@convex-dev/rag/" + "test"
const { default: ragTest } = (await import(ragTestModule)) as {
  default: { register: (test: ReturnType<typeof convexTest>) => void }
}
const migrationsTestModule = "@convex-dev/migrations/" + "test"
const { default: migrationsTest } = (await import(migrationsTestModule)) as {
  default: { register: (test: ReturnType<typeof convexTest>) => void }
}

const modules = import.meta.glob("./**/*.ts")
function testBackend() {
  const t = convexTest(schema, modules)
  ragTest.register(t)
  migrationsTest.register(t)
  return t
}

describe("chat history", () => {
  it("reconstructs user, assistant tool-call, and tool-result history", async () => {
    const t = testBackend()
    const first = await t.mutation(internal.chatHistory.startTurn, {
      ownerTokenIdentifier: "issuer|owner",
      conversationId: null,
      content: "Check my files",
    })
    await t.mutation(internal.chatHistory.appendMessages, {
      ownerTokenIdentifier: "issuer|owner",
      conversationId: first.conversationId,
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-1",
              name: "list_files",
              argumentsJson: "{}",
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call-1",
          content: '{"ok":true,"value":{"entries":[]}}',
        },
        { role: "assistant", content: "I checked your files." },
      ],
    })

    const second = await t.mutation(internal.chatHistory.startTurn, {
      ownerTokenIdentifier: "issuer|owner",
      conversationId: first.conversationId,
      content: "What did you find?",
    })

    expect(second.messages).toEqual([
      { role: "user", content: "Check my files" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "list_files", argumentsJson: "{}" }],
      },
      {
        role: "tool",
        toolCallId: "call-1",
        content: '{"ok":true,"value":{"entries":[]}}',
      },
      { role: "assistant", content: "I checked your files." },
      { role: "user", content: "What did you find?" },
    ])
  })

  it("does not expose or append another owner's conversation", async () => {
    const t = testBackend()
    const created = await t.mutation(internal.chatHistory.startTurn, {
      ownerTokenIdentifier: "issuer|owner",
      conversationId: null,
      content: "Private",
    })

    await expect(
      t.mutation(internal.chatHistory.startTurn, {
        ownerTokenIdentifier: "issuer|other",
        conversationId: created.conversationId,
        content: "Read it",
      })
    ).rejects.toThrow(/CHAT_NOT_FOUND/)
    await expect(
      t.mutation(internal.chatHistory.appendMessages, {
        ownerTokenIdentifier: "issuer|other",
        conversationId: created.conversationId,
        messages: [{ role: "assistant", content: "Stolen" }],
      })
    ).rejects.toThrow(/CHAT_NOT_FOUND/)
  })
})

describe("chat list", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("lists the owner's conversations, most recently updated first", async () => {
    vi.useFakeTimers()
    const t = testBackend()
    vi.setSystemTime(1_000)
    const first = await t.mutation(internal.chatHistory.startTurn, {
      ownerTokenIdentifier: "issuer|owner",
      conversationId: null,
      content: "  Improve   conversation\n capabilities  ",
    })
    vi.setSystemTime(2_000)
    await t.mutation(internal.chatHistory.startTurn, {
      ownerTokenIdentifier: "issuer|owner",
      conversationId: null,
      content: "Fix UIUC Essay file lookup",
    })
    vi.setSystemTime(3_000)
    await t.mutation(internal.chatHistory.startTurn, {
      ownerTokenIdentifier: "issuer|owner",
      conversationId: first.conversationId,
      content: "Keep going",
    })

    const asOwner = t.withIdentity({ tokenIdentifier: "issuer|owner" })
    const conversations = await asOwner.query(
      api.chatHistory.listConversations,
      {}
    )

    expect(conversations).toEqual([
      {
        conversationId: first.conversationId,
        title: "Improve conversation capabilities",
        updatedAt: 3_000,
      },
      {
        conversationId: expect.any(String),
        title: "Fix UIUC Essay file lookup",
        updatedAt: 2_000,
      },
    ])
  })

  it("truncates long titles", async () => {
    const t = testBackend()
    await t.mutation(internal.chatHistory.startTurn, {
      ownerTokenIdentifier: "issuer|owner",
      conversationId: null,
      content: "x".repeat(200),
    })

    const asOwner = t.withIdentity({ tokenIdentifier: "issuer|owner" })
    const [conversation] = await asOwner.query(
      api.chatHistory.listConversations,
      {}
    )

    expect(conversation.title).toBe("x".repeat(80))
  })

  it("does not list other owners' or unauthenticated conversations", async () => {
    const t = testBackend()
    await t.mutation(internal.chatHistory.startTurn, {
      ownerTokenIdentifier: "issuer|owner",
      conversationId: null,
      content: "Private",
    })

    const asOther = t.withIdentity({ tokenIdentifier: "issuer|other" })
    expect(await asOther.query(api.chatHistory.listConversations, {})).toEqual(
      []
    )
    expect(await t.query(api.chatHistory.listConversations, {})).toEqual([])
  })

  it("returns only displayable messages to the conversation owner", async () => {
    const t = testBackend()
    const created = await t.mutation(internal.chatHistory.startTurn, {
      ownerTokenIdentifier: "issuer|owner",
      conversationId: null,
      content: "Check my files",
    })
    await t.mutation(internal.chatHistory.appendMessages, {
      ownerTokenIdentifier: "issuer|owner",
      conversationId: created.conversationId,
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call-1", name: "list_files", argumentsJson: "{}" },
          ],
        },
        { role: "tool", toolCallId: "call-1", content: "{}" },
        { role: "assistant", content: "I checked your files." },
      ],
    })

    const asOwner = t.withIdentity({ tokenIdentifier: "issuer|owner" })
    expect(
      await asOwner.query(api.chatHistory.listMessages, {
        conversationId: created.conversationId,
      })
    ).toEqual([
      { role: "user", content: "Check my files" },
      { role: "assistant", content: "I checked your files." },
    ])

    const asOther = t.withIdentity({ tokenIdentifier: "issuer|other" })
    expect(
      await asOther.query(api.chatHistory.listMessages, {
        conversationId: created.conversationId,
      })
    ).toBeNull()
    expect(
      await t.query(api.chatHistory.listMessages, {
        conversationId: created.conversationId,
      })
    ).toBeNull()
  })
})
