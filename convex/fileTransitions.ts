import { ConvexError, v } from "convex/values"

import type { Id } from "./_generated/dataModel"
import { internalMutation, type MutationCtx } from "./_generated/server"

async function ownedFile(
  ctx: MutationCtx,
  fileId: Id<"files">,
  ownerTokenIdentifier: string
) {
  const file = await ctx.db.get("files", fileId)
  if (!file || file.ownerTokenIdentifier !== ownerTokenIdentifier) {
    throw new ConvexError("File not found")
  }
  return file
}

export const markReady = internalMutation({
  args: {
    fileId: v.id("files"),
    ownerTokenIdentifier: v.string(),
    verifiedContentType: v.string(),
    verifiedSize: v.number(),
    etag: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const file = await ownedFile(ctx, args.fileId, args.ownerTokenIdentifier)
    if (file.status === "ready") return file
    if (file.status !== "pending" && file.status !== "failed") {
      throw new ConvexError("Invalid file state")
    }
    await ctx.db.patch("files", args.fileId, {
      verifiedContentType: args.verifiedContentType,
      verifiedSize: args.verifiedSize,
      etag: args.etag,
      status: "ready",
      completedAt: Date.now(),
      failedAt: undefined,
      failureCode: undefined,
    })
    return await ctx.db.get("files", args.fileId)
  },
})

export const beginDelete = internalMutation({
  args: {
    fileId: v.id("files"),
    ownerTokenIdentifier: v.string(),
  },
  handler: async (ctx, args) => {
    const file = await ownedFile(ctx, args.fileId, args.ownerTokenIdentifier)
    if (
      file.status !== "ready" &&
      file.status !== "deleting" &&
      !(file.status === "failed" && file.verifiedSize !== undefined)
    ) {
      throw new ConvexError("Invalid file state")
    }
    if (file.status !== "deleting") {
      await ctx.db.patch("files", args.fileId, { status: "deleting" })
    }
    return await ctx.db.get("files", args.fileId)
  },
})

export const completeDelete = internalMutation({
  args: {
    fileId: v.id("files"),
    ownerTokenIdentifier: v.string(),
  },
  handler: async (ctx, args) => {
    const file = await ownedFile(ctx, args.fileId, args.ownerTokenIdentifier)
    if (file.status !== "deleting") {
      throw new ConvexError("Invalid file state")
    }
    await ctx.db.delete("files", args.fileId)
  },
})

export const markFailed = internalMutation({
  args: {
    fileId: v.id("files"),
    ownerTokenIdentifier: v.string(),
    failureCode: v.string(),
  },
  handler: async (ctx, args) => {
    const file = await ownedFile(ctx, args.fileId, args.ownerTokenIdentifier)
    if (file.status === "ready") {
      throw new ConvexError("Invalid file state")
    }
    await ctx.db.patch("files", args.fileId, {
      status: "failed",
      failedAt: Date.now(),
      failureCode: args.failureCode,
    })
  },
})

export const discardIncomplete = internalMutation({
  args: {
    fileId: v.id("files"),
    ownerTokenIdentifier: v.string(),
  },
  handler: async (ctx, args) => {
    const file = await ownedFile(ctx, args.fileId, args.ownerTokenIdentifier)
    if (file.status !== "pending" && file.status !== "failed") {
      throw new ConvexError("Invalid file state")
    }
    await ctx.db.delete("files", args.fileId)
  },
})
