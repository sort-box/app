import { ConvexError, v } from "convex/values"

import {
  MAX_STORED_MESSAGE_BYTES,
  storedMessageSchema,
  utf8ByteLength,
} from "../src/server/ai/chat-history-contract"
import { storedAiMessage } from "./chatSchemas"
import { internalMutation, query } from "./_generated/server"

const MAX_CONTEXT_MESSAGES = 80
const MAX_APPEND_MESSAGES = 10
const MAX_LISTED_CONVERSATIONS = 50
const MAX_TITLE_LENGTH = 80

function conversationTitle(content: string): string {
  return content.replaceAll(/\s+/g, " ").trim().slice(0, MAX_TITLE_LENGTH)
}

export const startTurn = internalMutation({
  args: {
    ownerTokenIdentifier: v.string(),
    conversationId: v.union(v.string(), v.null()),
    content: v.string(),
  },
  returns: v.object({
    conversationId: v.id("chatConversations"),
    messages: v.array(storedAiMessage),
  }),
  handler: async (ctx, args) => {
    if (
      args.content.length === 0 ||
      utf8ByteLength(args.content) > MAX_STORED_MESSAGE_BYTES
    ) {
      throw new ConvexError("INVALID_CHAT_MESSAGES")
    }
    const normalizedId = args.conversationId
      ? ctx.db.normalizeId("chatConversations", args.conversationId)
      : null
    const existing = normalizedId ? await ctx.db.get(normalizedId) : null
    if (
      args.conversationId !== null &&
      (!existing || existing.ownerTokenIdentifier !== args.ownerTokenIdentifier)
    ) {
      throw new ConvexError("CHAT_NOT_FOUND")
    }

    const now = Date.now()
    const conversationId =
      existing?._id ??
      (await ctx.db.insert("chatConversations", {
        ownerTokenIdentifier: args.ownerTokenIdentifier,
        title: conversationTitle(args.content),
        nextSequence: 0,
        updatedAt: now,
      }))
    const sequence = existing?.nextSequence ?? 0
    await ctx.db.insert("chatMessages", {
      conversationId,
      sequence,
      payload: { role: "user", content: args.content },
    })
    await ctx.db.patch(conversationId, {
      nextSequence: sequence + 1,
      updatedAt: now,
    })

    const newest = await ctx.db
      .query("chatMessages")
      .withIndex("by_conversationId_and_sequence", (q) =>
        q.eq("conversationId", conversationId)
      )
      .order("desc")
      .take(MAX_CONTEXT_MESSAGES)
    const messages = newest.reverse().map((message) => message.payload)
    const firstUser = messages.findIndex((message) => message.role === "user")
    return {
      conversationId,
      messages: firstUser === -1 ? [] : messages.slice(firstUser),
    }
  },
})

export const appendMessages = internalMutation({
  args: {
    ownerTokenIdentifier: v.string(),
    conversationId: v.string(),
    messages: v.array(storedAiMessage),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (
      args.messages.length === 0 ||
      args.messages.length > MAX_APPEND_MESSAGES ||
      args.messages.some(
        (message) => !storedMessageSchema.safeParse(message).success
      )
    ) {
      throw new ConvexError("INVALID_CHAT_MESSAGES")
    }
    const conversationId = ctx.db.normalizeId(
      "chatConversations",
      args.conversationId
    )
    const conversation = conversationId
      ? await ctx.db.get(conversationId)
      : null
    if (
      !conversation ||
      conversation.ownerTokenIdentifier !== args.ownerTokenIdentifier
    ) {
      throw new ConvexError("CHAT_NOT_FOUND")
    }

    for (const [offset, message] of args.messages.entries()) {
      await ctx.db.insert("chatMessages", {
        conversationId: conversation._id,
        sequence: conversation.nextSequence + offset,
        payload: message,
      })
    }
    await ctx.db.patch(conversation._id, {
      nextSequence: conversation.nextSequence + args.messages.length,
      updatedAt: Date.now(),
    })
    return null
  },
})

export const listConversations = query({
  args: {},
  returns: v.array(
    v.object({
      conversationId: v.id("chatConversations"),
      title: v.union(v.string(), v.null()),
      updatedAt: v.number(),
    })
  ),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) return []
    const conversations = await ctx.db
      .query("chatConversations")
      .withIndex("by_ownerTokenIdentifier_and_updatedAt", (q) =>
        q.eq("ownerTokenIdentifier", identity.tokenIdentifier)
      )
      .order("desc")
      .take(MAX_LISTED_CONVERSATIONS)
    return conversations.map((conversation) => ({
      conversationId: conversation._id,
      title: conversation.title ?? null,
      updatedAt: conversation.updatedAt,
    }))
  },
})

export const listMessages = query({
  args: { conversationId: v.id("chatConversations") },
  returns: v.union(
    v.null(),
    v.array(
      v.object({
        role: v.union(v.literal("user"), v.literal("assistant")),
        content: v.string(),
      })
    )
  ),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity()
    const conversation = identity ? await ctx.db.get(args.conversationId) : null
    if (
      !identity ||
      !conversation ||
      conversation.ownerTokenIdentifier !== identity.tokenIdentifier
    ) {
      return null
    }
    const newest = await ctx.db
      .query("chatMessages")
      .withIndex("by_conversationId_and_sequence", (q) =>
        q.eq("conversationId", conversation._id)
      )
      .order("desc")
      .take(MAX_CONTEXT_MESSAGES)
    const messages: Array<{ role: "user" | "assistant"; content: string }> = []
    for (const { payload } of newest.reverse()) {
      if (payload.role === "tool") continue
      if (payload.role === "assistant" && payload.content.length === 0) continue
      messages.push({ role: payload.role, content: payload.content })
    }
    return messages
  },
})
