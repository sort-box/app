import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server"
import { ConvexError, v } from "convex/values"

import type { Doc, Id } from "./_generated/dataModel"
import { mutation, query, type MutationCtx } from "./_generated/server"
import { fileStatus } from "./schema"

const TEN_GIB = 10 * 1024 ** 3
const WINDOW_MS = 60_000

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
  path: v.optional(v.string()),
  parentPath: v.optional(v.string()),
  basename: v.optional(v.string()),
  operation: v.optional(v.union(v.literal("upload"), v.literal("copy"))),
  usageBackfilledAt: v.optional(v.number()),
})
const entryValidator = v.object({
  _id: v.id("fileEntries"),
  _creationTime: v.number(),
  ownerTokenIdentifier: v.string(),
  path: v.string(),
  parentPath: v.string(),
  basename: v.string(),
  kind: v.union(v.literal("file"), v.literal("directory")),
  fileId: v.optional(v.id("files")),
  status: fileStatus,
})

async function identity(ctx: {
  auth: {
    getUserIdentity: () => Promise<{
      subject: string
      tokenIdentifier: string
    } | null>
  }
}) {
  const value = await ctx.auth.getUserIdentity()
  if (!value) throw new ConvexError("NOT_AUTHENTICATED")
  return value
}

async function owned(
  ctx: MutationCtx,
  fileId: Id<"files">,
  ownerTokenIdentifier: string
) {
  const file = await ctx.db.get("files", fileId)
  if (!file || file.ownerTokenIdentifier !== ownerTokenIdentifier) {
    throw new ConvexError("FILE_NOT_FOUND")
  }
  return file
}

async function usage(ctx: MutationCtx, ownerTokenIdentifier: string) {
  const current = await ctx.db
    .query("fileUsage")
    .withIndex("by_owner", (q) =>
      q.eq("ownerTokenIdentifier", ownerTokenIdentifier)
    )
    .unique()
  if (current) return current
  const id = await ctx.db.insert("fileUsage", {
    ownerTokenIdentifier,
    reservedBytes: 0,
    usedBytes: 0,
  })
  return (await ctx.db.get(id))!
}

async function assertPathAvailable(
  ctx: MutationCtx,
  ownerTokenIdentifier: string,
  path: string,
  excluding?: Id<"files">
) {
  const existing = await ctx.db
    .query("fileEntries")
    .withIndex("by_owner_path", (q) =>
      q.eq("ownerTokenIdentifier", ownerTokenIdentifier).eq("path", path)
    )
    .first()
  if (existing && existing.fileId !== excluding) {
    throw new ConvexError("PATH_CONFLICT")
  }
}

async function ensureDirectories(
  ctx: MutationCtx,
  ownerTokenIdentifier: string,
  parentPath: string
) {
  if (parentPath === "/") return
  const segments = parentPath.slice(1).split("/")
  for (let index = 0; index < segments.length; index += 1) {
    const path = `/${segments.slice(0, index + 1).join("/")}`
    const existing = await ctx.db
      .query("fileEntries")
      .withIndex("by_owner_path", (q) =>
        q.eq("ownerTokenIdentifier", ownerTokenIdentifier).eq("path", path)
      )
      .first()
    if (existing?.kind === "file") throw new ConvexError("PATH_CONFLICT")
    if (!existing) {
      await ctx.db.insert("fileEntries", {
        ownerTokenIdentifier,
        path,
        parentPath:
          index === 0 ? "/" : `/${segments.slice(0, index).join("/")}`,
        basename: segments[index],
        kind: "directory",
        status: "ready",
      })
    }
  }
}

async function fileEntry(
  ctx: MutationCtx,
  ownerTokenIdentifier: string,
  fileId: Id<"files">
) {
  return await ctx.db
    .query("fileEntries")
    .withIndex("by_owner_path", (q) =>
      q.eq("ownerTokenIdentifier", ownerTokenIdentifier)
    )
    .filter((q) => q.eq(q.field("fileId"), fileId))
    .first()
}

async function pruneDirectories(
  ctx: MutationCtx,
  ownerTokenIdentifier: string,
  startingPath: string
) {
  let path = startingPath
  while (path !== "/") {
    const children = await ctx.db
      .query("fileEntries")
      .withIndex("by_owner_parent_status_path", (q) =>
        q
          .eq("ownerTokenIdentifier", ownerTokenIdentifier)
          .eq("parentPath", path)
          .eq("status", "ready")
      )
      .first()
    const pending = await ctx.db
      .query("fileEntries")
      .withIndex("by_owner_parent_status_path", (q) =>
        q
          .eq("ownerTokenIdentifier", ownerTokenIdentifier)
          .eq("parentPath", path)
          .eq("status", "pending")
      )
      .first()
    if (children || pending) return
    const directory = await ctx.db
      .query("fileEntries")
      .withIndex("by_owner_path", (q) =>
        q.eq("ownerTokenIdentifier", ownerTokenIdentifier).eq("path", path)
      )
      .first()
    if (!directory || directory.kind !== "directory") return
    await ctx.db.delete(directory._id)
    path = directory.parentPath
  }
}

async function reserveBytes(
  ctx: MutationCtx,
  ownerTokenIdentifier: string,
  bytes: number,
  quota: number
) {
  const current = await usage(ctx, ownerTokenIdentifier)
  if (current.usedBytes + current.reservedBytes + bytes > quota) {
    throw new ConvexError("QUOTA_EXCEEDED")
  }
  await ctx.db.patch(current._id, {
    reservedBytes: current.reservedBytes + bytes,
  })
}

export const consumeRateLimit = mutation({
  args: {
    bucket: v.union(
      v.literal("read"),
      v.literal("mutation"),
      v.literal("upload")
    ),
    limit: v.number(),
  },
  returns: v.object({ allowed: v.boolean(), retryAfter: v.number() }),
  handler: async (ctx, args) => {
    const owner = await identity(ctx)
    const now = Date.now()
    const record = await ctx.db
      .query("fileRateLimits")
      .withIndex("by_owner_bucket", (q) =>
        q
          .eq("ownerTokenIdentifier", owner.tokenIdentifier)
          .eq("bucket", args.bucket)
      )
      .unique()
    if (!record || now - record.windowStartedAt >= WINDOW_MS) {
      if (record) {
        await ctx.db.patch(record._id, { windowStartedAt: now, count: 1 })
      } else {
        await ctx.db.insert("fileRateLimits", {
          ownerTokenIdentifier: owner.tokenIdentifier,
          bucket: args.bucket,
          windowStartedAt: now,
          count: 1,
        })
      }
      return { allowed: true, retryAfter: 0 }
    }
    const retryAfter = Math.max(
      1,
      Math.ceil((WINDOW_MS - (now - record.windowStartedAt)) / 1000)
    )
    if (record.count >= args.limit) return { allowed: false, retryAfter }
    await ctx.db.patch(record._id, { count: record.count + 1 })
    return { allowed: true, retryAfter: 0 }
  },
})

export const createUpload = mutation({
  args: {
    path: v.string(),
    parentPath: v.string(),
    basename: v.string(),
    contentType: v.string(),
    size: v.number(),
    quota: v.optional(v.number()),
  },
  returns: v.object({ fileId: v.id("files"), objectKey: v.string() }),
  handler: async (ctx, args) => {
    const owner = await identity(ctx)
    await assertPathAvailable(ctx, owner.tokenIdentifier, args.path)
    await ensureDirectories(ctx, owner.tokenIdentifier, args.parentPath)
    await reserveBytes(
      ctx,
      owner.tokenIdentifier,
      args.size,
      args.quota ?? TEN_GIB
    )
    const objectKey = `files/${crypto.randomUUID()}`
    const fileId = await ctx.db.insert("files", {
      ownerClerkUserId: owner.subject,
      ownerTokenIdentifier: owner.tokenIdentifier,
      objectKey,
      originalName: args.basename,
      declaredContentType: args.contentType,
      declaredSize: args.size,
      path: args.path,
      parentPath: args.parentPath,
      basename: args.basename,
      operation: "upload",
      usageBackfilledAt: Date.now(),
      status: "pending",
    })
    await ctx.db.insert("fileEntries", {
      ownerTokenIdentifier: owner.tokenIdentifier,
      path: args.path,
      parentPath: args.parentPath,
      basename: args.basename,
      kind: "file",
      fileId,
      status: "pending",
    })
    return { fileId, objectKey }
  },
})

export const getOwned = query({
  args: { fileId: v.id("files") },
  returns: v.union(fileValidator, v.null()),
  handler: async (ctx, args) => {
    const owner = await identity(ctx)
    const file = await ctx.db.get("files", args.fileId)
    return file?.ownerTokenIdentifier === owner.tokenIdentifier ? file : null
  },
})

export const list = query({
  args: {
    parentPath: v.string(),
    recursive: v.boolean(),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(entryValidator),
  handler: async (ctx, args) => {
    const owner = await identity(ctx)
    if (!args.recursive) {
      return await ctx.db
        .query("fileEntries")
        .withIndex("by_owner_parent_status_path", (q) =>
          q
            .eq("ownerTokenIdentifier", owner.tokenIdentifier)
            .eq("parentPath", args.parentPath)
            .eq("status", "ready")
        )
        .paginate(args.paginationOpts)
    }
    const prefix = args.parentPath === "/" ? "/" : `${args.parentPath}/`
    return await ctx.db
      .query("fileEntries")
      .withIndex("by_owner_path", (q) =>
        q
          .eq("ownerTokenIdentifier", owner.tokenIdentifier)
          .gte("path", prefix)
          .lt("path", `${prefix}\uffff`)
      )
      .filter((q) =>
        q.and(q.eq(q.field("status"), "ready"), q.eq(q.field("kind"), "file"))
      )
      .paginate(args.paginationOpts)
  },
})

export const completeUpload = mutation({
  args: {
    fileId: v.id("files"),
    verifiedContentType: v.string(),
    verifiedSize: v.number(),
    etag: v.optional(v.string()),
  },
  returns: fileValidator,
  handler: async (ctx, args) => {
    const owner = await identity(ctx)
    const file = await owned(ctx, args.fileId, owner.tokenIdentifier)
    if (file.status === "ready") return file
    if (file.status !== "pending" || file.operation !== "upload") {
      throw new ConvexError("INVALID_FILE_STATE")
    }
    const current = await usage(ctx, owner.tokenIdentifier)
    await ctx.db.patch(current._id, {
      reservedBytes: Math.max(0, current.reservedBytes - file.declaredSize),
      usedBytes: current.usedBytes + args.verifiedSize,
    })
    await ctx.db.patch(file._id, {
      verifiedContentType: args.verifiedContentType,
      verifiedSize: args.verifiedSize,
      etag: args.etag,
      status: "ready",
      completedAt: Date.now(),
      failureCode: undefined,
      failedAt: undefined,
    })
    const entry = await fileEntry(ctx, owner.tokenIdentifier, file._id)
    if (entry) await ctx.db.patch(entry._id, { status: "ready" })
    return (await ctx.db.get(file._id))!
  },
})

export const failPending = mutation({
  args: { fileId: v.id("files"), failureCode: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = await identity(ctx)
    const file = await owned(ctx, args.fileId, owner.tokenIdentifier)
    if (file.status === "pending") {
      const current = await usage(ctx, owner.tokenIdentifier)
      await ctx.db.patch(current._id, {
        reservedBytes: Math.max(0, current.reservedBytes - file.declaredSize),
      })
      await ctx.db.patch(file._id, {
        status: "failed",
        failedAt: Date.now(),
        failureCode: args.failureCode,
      })
      const entry = await fileEntry(ctx, owner.tokenIdentifier, file._id)
      if (entry) {
        await ctx.db.delete(entry._id)
        await pruneDirectories(ctx, owner.tokenIdentifier, entry.parentPath)
      }
    }
    return null
  },
})

export const reserveCopy = mutation({
  args: {
    sourceFileId: v.id("files"),
    path: v.string(),
    parentPath: v.string(),
    basename: v.string(),
    quota: v.optional(v.number()),
  },
  returns: v.object({
    fileId: v.id("files"),
    sourceObjectKey: v.string(),
    destinationObjectKey: v.string(),
  }),
  handler: async (ctx, args) => {
    const owner = await identity(ctx)
    const source = await owned(ctx, args.sourceFileId, owner.tokenIdentifier)
    if (source.status !== "ready" || source.verifiedSize === undefined) {
      throw new ConvexError("INVALID_FILE_STATE")
    }
    await assertPathAvailable(ctx, owner.tokenIdentifier, args.path)
    await ensureDirectories(ctx, owner.tokenIdentifier, args.parentPath)
    await reserveBytes(
      ctx,
      owner.tokenIdentifier,
      source.verifiedSize,
      args.quota ?? TEN_GIB
    )
    const destinationObjectKey = `files/${crypto.randomUUID()}`
    const fileId = await ctx.db.insert("files", {
      ownerClerkUserId: owner.subject,
      ownerTokenIdentifier: owner.tokenIdentifier,
      objectKey: destinationObjectKey,
      originalName: args.basename,
      declaredContentType:
        source.verifiedContentType ?? source.declaredContentType,
      declaredSize: source.verifiedSize,
      path: args.path,
      parentPath: args.parentPath,
      basename: args.basename,
      operation: "copy",
      usageBackfilledAt: Date.now(),
      status: "pending",
    })
    await ctx.db.insert("fileEntries", {
      ownerTokenIdentifier: owner.tokenIdentifier,
      path: args.path,
      parentPath: args.parentPath,
      basename: args.basename,
      kind: "file",
      fileId,
      status: "pending",
    })
    return { fileId, sourceObjectKey: source.objectKey, destinationObjectKey }
  },
})

export const completeCopy = mutation({
  args: {
    fileId: v.id("files"),
    verifiedContentType: v.string(),
    verifiedSize: v.number(),
    etag: v.optional(v.string()),
  },
  returns: fileValidator,
  handler: async (ctx, args) => {
    const owner = await identity(ctx)
    const file = await owned(ctx, args.fileId, owner.tokenIdentifier)
    if (file.status === "ready") return file
    if (file.status !== "pending" || file.operation !== "copy") {
      throw new ConvexError("INVALID_FILE_STATE")
    }
    const current = await usage(ctx, owner.tokenIdentifier)
    await ctx.db.patch(current._id, {
      reservedBytes: Math.max(0, current.reservedBytes - file.declaredSize),
      usedBytes: current.usedBytes + args.verifiedSize,
    })
    await ctx.db.patch(file._id, {
      verifiedContentType: args.verifiedContentType,
      verifiedSize: args.verifiedSize,
      etag: args.etag,
      status: "ready",
      completedAt: Date.now(),
    })
    const entry = await fileEntry(ctx, owner.tokenIdentifier, file._id)
    if (entry) await ctx.db.patch(entry._id, { status: "ready" })
    return (await ctx.db.get(file._id))!
  },
})

export const move = mutation({
  args: {
    fileId: v.id("files"),
    path: v.string(),
    parentPath: v.string(),
    basename: v.string(),
  },
  returns: fileValidator,
  handler: async (ctx, args) => {
    const owner = await identity(ctx)
    const file = await owned(ctx, args.fileId, owner.tokenIdentifier)
    if (file.status !== "ready") throw new ConvexError("INVALID_FILE_STATE")
    const oldParentPath = file.parentPath ?? "/"
    await assertPathAvailable(ctx, owner.tokenIdentifier, args.path, file._id)
    await ensureDirectories(ctx, owner.tokenIdentifier, args.parentPath)
    await ctx.db.patch(file._id, {
      path: args.path,
      parentPath: args.parentPath,
      basename: args.basename,
      originalName: args.basename,
    })
    const entry = await fileEntry(ctx, owner.tokenIdentifier, file._id)
    if (entry) {
      await ctx.db.patch(entry._id, {
        path: args.path,
        parentPath: args.parentPath,
        basename: args.basename,
      })
    }
    await pruneDirectories(ctx, owner.tokenIdentifier, oldParentPath)
    return (await ctx.db.get(file._id))!
  },
})

export const beginDelete = mutation({
  args: { fileId: v.id("files") },
  returns: fileValidator,
  handler: async (ctx, args) => {
    const owner = await identity(ctx)
    const file = await owned(ctx, args.fileId, owner.tokenIdentifier)
    if (file.status !== "ready" && file.status !== "deleting") {
      throw new ConvexError("INVALID_FILE_STATE")
    }
    if (file.status !== "deleting") {
      await ctx.db.patch(file._id, { status: "deleting" })
      const entry = await fileEntry(ctx, owner.tokenIdentifier, file._id)
      if (entry) await ctx.db.patch(entry._id, { status: "deleting" })
    }
    return (await ctx.db.get(file._id))!
  },
})

export const completeDelete = mutation({
  args: { fileId: v.id("files") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = await identity(ctx)
    const file = await owned(ctx, args.fileId, owner.tokenIdentifier)
    if (file.status !== "deleting") throw new ConvexError("INVALID_FILE_STATE")
    const current = await usage(ctx, owner.tokenIdentifier)
    await ctx.db.patch(current._id, {
      usedBytes: Math.max(0, current.usedBytes - (file.verifiedSize ?? 0)),
    })
    await ctx.db.delete(file._id)
    const entry = await fileEntry(ctx, owner.tokenIdentifier, file._id)
    if (entry) {
      await ctx.db.delete(entry._id)
      await pruneDirectories(ctx, owner.tokenIdentifier, entry.parentPath)
    }
    return null
  },
})

export const cancelDelete = mutation({
  args: { fileId: v.id("files") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = await identity(ctx)
    const file = await owned(ctx, args.fileId, owner.tokenIdentifier)
    if (file.status === "deleting") {
      await ctx.db.patch(file._id, { status: "ready" })
      const entry = await fileEntry(ctx, owner.tokenIdentifier, file._id)
      if (entry) await ctx.db.patch(entry._id, { status: "ready" })
    }
    return null
  },
})

export function legacyPath(file: Doc<"files">) {
  return file.path ?? `/${file.originalName}`
}
