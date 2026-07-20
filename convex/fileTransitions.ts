import { ConvexError, v } from "convex/values"

import type { Id } from "./_generated/dataModel"
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server"

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
    const entry = await ctx.db
      .query("fileEntries")
      .withIndex("by_owner_path", (q) =>
        q.eq("ownerTokenIdentifier", file.ownerTokenIdentifier)
      )
      .filter((q) => q.eq(q.field("fileId"), file._id))
      .first()
    if (entry) await ctx.db.delete(entry._id)
    await ctx.db.delete("files", args.fileId)
  },
})

export const listExpired = internalQuery({
  args: {
    cutoff: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(100, Math.floor(args.limit)))
    const [pending, failed] = await Promise.all([
      ctx.db
        .query("files")
        .withIndex("by_status", (q) =>
          q.eq("status", "pending").lt("_creationTime", args.cutoff)
        )
        .take(limit),
      ctx.db
        .query("files")
        .withIndex("by_status", (q) =>
          q.eq("status", "failed").lt("_creationTime", args.cutoff)
        )
        .take(limit),
    ])
    return [...pending, ...failed].slice(0, limit).map((file) => ({
      fileId: file._id,
      objectKey: file.objectKey,
    }))
  },
})

export const completeCleanup = internalMutation({
  args: {
    fileId: v.id("files"),
    objectKey: v.string(),
  },
  handler: async (ctx, args) => {
    const file = await ctx.db.get("files", args.fileId)
    if (
      !file ||
      file.objectKey !== args.objectKey ||
      (file.status !== "pending" && file.status !== "failed")
    ) {
      throw new ConvexError("Invalid cleanup candidate")
    }
    if (file.status === "pending") {
      const usage = await ctx.db
        .query("fileUsage")
        .withIndex("by_owner", (q) =>
          q.eq("ownerTokenIdentifier", file.ownerTokenIdentifier)
        )
        .unique()
      if (usage) {
        await ctx.db.patch(usage._id, {
          reservedBytes: Math.max(0, usage.reservedBytes - file.declaredSize),
        })
      }
    }
    const entry = await ctx.db
      .query("fileEntries")
      .withIndex("by_owner_path", (q) =>
        q.eq("ownerTokenIdentifier", file.ownerTokenIdentifier)
      )
      .filter((q) => q.eq(q.field("fileId"), file._id))
      .first()
    if (entry) await ctx.db.delete(entry._id)
    await ctx.db.delete("files", args.fileId)
  },
})
