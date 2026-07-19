import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server"
import { ConvexError, v } from "convex/values"

import { mutation, query } from "./_generated/server"
import { fileStatus } from "./schema"

const fileValidator = v.object({
  _id: v.id("files"),
  _creationTime: v.number(),
  ownerClerkUserId: v.string(),
  ownerTokenIdentifier: v.string(),
  objectKey: v.string(),
  originalName: v.string(),
  declaredContentType: v.string(),
  declaredSize: v.number(),
  verifiedContentType: v.optional(v.string()),
  verifiedSize: v.optional(v.number()),
  etag: v.optional(v.string()),
  status: fileStatus,
  completedAt: v.optional(v.number()),
  failedAt: v.optional(v.number()),
  failureCode: v.optional(v.string()),
})

async function requireIdentity(ctx: {
  auth: {
    getUserIdentity: () => Promise<{
      subject: string
      tokenIdentifier: string
    } | null>
  }
}) {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) throw new ConvexError("Not authenticated")
  return identity
}

export const createPending = mutation({
  args: {
    objectKey: v.string(),
    originalName: v.string(),
    declaredContentType: v.string(),
    declaredSize: v.number(),
  },
  returns: v.id("files"),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx)
    return await ctx.db.insert("files", {
      ownerClerkUserId: identity.subject,
      ownerTokenIdentifier: identity.tokenIdentifier,
      objectKey: args.objectKey,
      originalName: args.originalName,
      declaredContentType: args.declaredContentType,
      declaredSize: args.declaredSize,
      status: "pending",
    })
  },
})

export const getOwned = query({
  args: { fileId: v.id("files") },
  returns: v.union(fileValidator, v.null()),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx)
    const file = await ctx.db.get("files", args.fileId)
    return file?.ownerTokenIdentifier === identity.tokenIdentifier ? file : null
  },
})

export const listMine = query({
  args: {
    status: fileStatus,
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(fileValidator),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx)
    return await ctx.db
      .query("files")
      .withIndex("by_ownerTokenIdentifier_and_status", (q) =>
        q
          .eq("ownerTokenIdentifier", identity.tokenIdentifier)
          .eq("status", args.status)
      )
      .order("desc")
      .paginate(args.paginationOpts)
  },
})

export const markReady = mutation({
  args: {
    fileId: v.id("files"),
    verifiedContentType: v.string(),
    verifiedSize: v.number(),
    etag: v.optional(v.string()),
  },
  returns: fileValidator,
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx)
    const file = await ctx.db.get("files", args.fileId)
    if (!file || file.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new ConvexError("File not found")
    }
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
    const updated = await ctx.db.get("files", args.fileId)
    if (!updated) throw new ConvexError("File not found")
    return updated
  },
})

export const beginDelete = mutation({
  args: { fileId: v.id("files") },
  returns: fileValidator,
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx)
    const file = await ctx.db.get("files", args.fileId)
    if (!file || file.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new ConvexError("File not found")
    }
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
    const updated = await ctx.db.get("files", args.fileId)
    if (!updated) throw new ConvexError("File not found")
    return updated
  },
})

export const completeDelete = mutation({
  args: { fileId: v.id("files") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx)
    const file = await ctx.db.get("files", args.fileId)
    if (!file || file.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new ConvexError("File not found")
    }
    if (file.status !== "deleting") {
      throw new ConvexError("Invalid file state")
    }
    await ctx.db.delete("files", args.fileId)
    return null
  },
})

export const markFailed = mutation({
  args: {
    fileId: v.id("files"),
    failureCode: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx)
    const file = await ctx.db.get("files", args.fileId)
    if (!file || file.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new ConvexError("File not found")
    }
    await ctx.db.patch("files", args.fileId, {
      status: "failed",
      failedAt: Date.now(),
      failureCode: args.failureCode,
    })
    return null
  },
})

export const discardIncomplete = mutation({
  args: { fileId: v.id("files") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx)
    const file = await ctx.db.get("files", args.fileId)
    if (!file || file.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new ConvexError("File not found")
    }
    if (file.status !== "pending" && file.status !== "failed") {
      throw new ConvexError("Invalid file state")
    }
    await ctx.db.delete("files", args.fileId)
    return null
  },
})
