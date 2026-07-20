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
    originalName: v.string(),
    declaredContentType: v.string(),
    declaredSize: v.number(),
  },
  returns: v.object({ fileId: v.id("files"), objectKey: v.string() }),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx)
    let objectKey = ""
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const candidate = `files/${crypto.randomUUID()}`
      const existing = await ctx.db
        .query("files")
        .withIndex("by_objectKey", (q) => q.eq("objectKey", candidate))
        .unique()
      if (!existing) {
        objectKey = candidate
        break
      }
    }
    if (!objectKey) throw new ConvexError("Unable to allocate object key")

    const fileId = await ctx.db.insert("files", {
      ownerClerkUserId: identity.subject,
      ownerTokenIdentifier: identity.tokenIdentifier,
      objectKey,
      originalName: args.originalName,
      declaredContentType: args.declaredContentType,
      declaredSize: args.declaredSize,
      status: "pending",
    })
    return { fileId, objectKey }
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
