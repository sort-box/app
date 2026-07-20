import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server"
import { ConvexError, v } from "convex/values"

import type { Doc, Id } from "./_generated/dataModel"
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server"
import { fileStatus } from "./schema"

const TEN_GIB = 10 * 1024 ** 3
const WINDOW_MS = 60_000
const MAX_FILE_SIZE = Math.floor(4.995 * 1024 ** 3)

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
  explicit: v.optional(v.boolean()),
})

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
  if (existing && (excluding === undefined || existing.fileId !== excluding)) {
    throw new ConvexError("PATH_CONFLICT")
  }
}

// A pending upload reservation must not lock its path until scheduled cleanup:
// when the client-side PUT fails, retrying the same path supersedes the stale
// reservation. Safe because the mutation is transactional (the refund rolls
// back with any later failure), completeUpload rejects non-pending files, and
// the orphaned object is removed by the failed-file cleanup job.
async function supersedePendingUpload(
  ctx: MutationCtx,
  ownerTokenIdentifier: string,
  path: string
) {
  const entry = await ctx.db
    .query("fileEntries")
    .withIndex("by_owner_path", (q) =>
      q.eq("ownerTokenIdentifier", ownerTokenIdentifier).eq("path", path)
    )
    .first()
  if (
    !entry ||
    entry.kind !== "file" ||
    entry.status !== "pending" ||
    !entry.fileId
  ) {
    return
  }
  const file = await ctx.db.get("files", entry.fileId)
  if (!file || file.status !== "pending" || file.operation !== "upload") {
    return
  }
  const current = await usage(ctx, ownerTokenIdentifier)
  await ctx.db.patch(current._id, {
    reservedBytes: Math.max(0, current.reservedBytes - file.declaredSize),
  })
  await ctx.db.patch(file._id, {
    status: "failed",
    failedAt: Date.now(),
    failureCode: "SUPERSEDED",
  })
  await ctx.db.delete(entry._id)
}

function assertCanonicalPath(
  path: string,
  parentPath: string,
  basename: string
) {
  const normalized = path.normalize("NFC")
  const segments = normalized.startsWith("/")
    ? normalized.slice(1).split("/")
    : []
  const expectedParent =
    segments.length === 1 ? "/" : `/${segments.slice(0, -1).join("/")}`
  const invalidCharacter = Array.from(normalized).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
  if (
    normalized !== path ||
    path === "/" ||
    !path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    invalidCharacter ||
    new TextEncoder().encode(path).byteLength > 1024 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        new TextEncoder().encode(segment).byteLength > 255
    ) ||
    basename !== segments.at(-1) ||
    parentPath !== expectedParent
  ) {
    throw new ConvexError("INVALID_PATH")
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
    .withIndex("by_owner_fileId", (q) =>
      q.eq("ownerTokenIdentifier", ownerTokenIdentifier).eq("fileId", fileId)
    )
    .unique()
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
    const deleting = await ctx.db
      .query("fileEntries")
      .withIndex("by_owner_parent_status_path", (q) =>
        q
          .eq("ownerTokenIdentifier", ownerTokenIdentifier)
          .eq("parentPath", path)
          .eq("status", "deleting")
      )
      .first()
    if (children || pending || deleting) return
    const directory = await ctx.db
      .query("fileEntries")
      .withIndex("by_owner_path", (q) =>
        q.eq("ownerTokenIdentifier", ownerTokenIdentifier).eq("path", path)
      )
      .first()
    if (!directory || directory.kind !== "directory") return
    if (directory.explicit) return
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

export const consumeRateLimit = internalMutation({
  args: {
    ownerTokenIdentifier: v.string(),
    bucket: v.union(
      v.literal("read"),
      v.literal("mutation"),
      v.literal("upload")
    ),
  },
  returns: v.object({ allowed: v.boolean(), retryAfter: v.number() }),
  handler: async (ctx, args) => {
    // Per user and minute. Uploads consume one upload token (ticket) plus
    // one mutation token (complete) per file, so mutation stays above upload
    // to leave headroom for interactive rename/move/delete during a batch.
    const limit =
      args.bucket === "read" ? 60 : args.bucket === "mutation" ? 90 : 60
    const now = Date.now()
    const record = await ctx.db
      .query("fileRateLimits")
      .withIndex("by_owner_bucket", (q) =>
        q
          .eq("ownerTokenIdentifier", args.ownerTokenIdentifier)
          .eq("bucket", args.bucket)
      )
      .unique()
    if (!record || now - record.windowStartedAt >= WINDOW_MS) {
      if (record) {
        await ctx.db.patch(record._id, { windowStartedAt: now, count: 1 })
      } else {
        await ctx.db.insert("fileRateLimits", {
          ownerTokenIdentifier: args.ownerTokenIdentifier,
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
    if (record.count >= limit) return { allowed: false, retryAfter }
    await ctx.db.patch(record._id, { count: record.count + 1 })
    return { allowed: true, retryAfter: 0 }
  },
})

export const createUpload = internalMutation({
  args: {
    ownerClerkUserId: v.string(),
    ownerTokenIdentifier: v.string(),
    path: v.string(),
    parentPath: v.string(),
    basename: v.string(),
    contentType: v.string(),
    size: v.number(),
  },
  returns: v.object({ fileId: v.id("files"), objectKey: v.string() }),
  handler: async (ctx, args) => {
    assertCanonicalPath(args.path, args.parentPath, args.basename)
    if (
      !Number.isInteger(args.size) ||
      args.size < 0 ||
      args.size > MAX_FILE_SIZE
    ) {
      throw new ConvexError("INVALID_SIZE")
    }
    await supersedePendingUpload(ctx, args.ownerTokenIdentifier, args.path)
    await assertPathAvailable(ctx, args.ownerTokenIdentifier, args.path)
    await ensureDirectories(ctx, args.ownerTokenIdentifier, args.parentPath)
    await reserveBytes(ctx, args.ownerTokenIdentifier, args.size, TEN_GIB)
    const objectKey = `files/${crypto.randomUUID()}`
    const fileId = await ctx.db.insert("files", {
      ownerClerkUserId: args.ownerClerkUserId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
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
      ownerTokenIdentifier: args.ownerTokenIdentifier,
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

export const getOwned = internalQuery({
  args: { ownerTokenIdentifier: v.string(), fileId: v.id("files") },
  returns: v.union(fileValidator, v.null()),
  handler: async (ctx, args) => {
    const file = await ctx.db.get("files", args.fileId)
    return file?.ownerTokenIdentifier === args.ownerTokenIdentifier
      ? file
      : null
  },
})

export const list = internalQuery({
  args: {
    ownerTokenIdentifier: v.string(),
    parentPath: v.string(),
    recursive: v.boolean(),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(entryValidator),
  handler: async (ctx, args) => {
    if (!args.recursive) {
      return await ctx.db
        .query("fileEntries")
        .withIndex("by_owner_parent_status_path", (q) =>
          q
            .eq("ownerTokenIdentifier", args.ownerTokenIdentifier)
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
          .eq("ownerTokenIdentifier", args.ownerTokenIdentifier)
          .gte("path", prefix)
          .lt("path", `${prefix}\uffff`)
      )
      .filter((q) =>
        q.and(q.eq(q.field("status"), "ready"), q.eq(q.field("kind"), "file"))
      )
      .paginate(args.paginationOpts)
  },
})

export const completeUpload = internalMutation({
  args: {
    ownerTokenIdentifier: v.string(),
    fileId: v.id("files"),
    verifiedContentType: v.string(),
    verifiedSize: v.number(),
    etag: v.optional(v.string()),
  },
  returns: fileValidator,
  handler: async (ctx, args) => {
    const file = await owned(ctx, args.fileId, args.ownerTokenIdentifier)
    if (file.status === "ready") return file
    if (file.status !== "pending" || file.operation !== "upload") {
      throw new ConvexError("INVALID_FILE_STATE")
    }
    if (
      args.verifiedSize !== file.declaredSize ||
      args.verifiedContentType !== file.declaredContentType
    ) {
      throw new ConvexError("UPLOAD_MISMATCH")
    }
    const current = await usage(ctx, args.ownerTokenIdentifier)
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
    const entry = await fileEntry(ctx, args.ownerTokenIdentifier, file._id)
    if (entry) await ctx.db.patch(entry._id, { status: "ready" })
    return (await ctx.db.get(file._id))!
  },
})

export const failPending = internalMutation({
  args: {
    ownerTokenIdentifier: v.string(),
    fileId: v.id("files"),
    failureCode: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const file = await owned(ctx, args.fileId, args.ownerTokenIdentifier)
    if (file.status === "pending") {
      const current = await usage(ctx, args.ownerTokenIdentifier)
      await ctx.db.patch(current._id, {
        reservedBytes: Math.max(0, current.reservedBytes - file.declaredSize),
      })
      await ctx.db.patch(file._id, {
        status: "failed",
        failedAt: Date.now(),
        failureCode: args.failureCode,
      })
      const entry = await fileEntry(ctx, args.ownerTokenIdentifier, file._id)
      if (entry) {
        await ctx.db.delete(entry._id)
        await pruneDirectories(ctx, args.ownerTokenIdentifier, entry.parentPath)
      }
    }
    return null
  },
})

export const reserveCopy = internalMutation({
  args: {
    ownerClerkUserId: v.string(),
    ownerTokenIdentifier: v.string(),
    sourceFileId: v.id("files"),
    path: v.string(),
    parentPath: v.string(),
    basename: v.string(),
  },
  returns: v.object({
    fileId: v.id("files"),
    sourceObjectKey: v.string(),
    destinationObjectKey: v.string(),
  }),
  handler: async (ctx, args) => {
    assertCanonicalPath(args.path, args.parentPath, args.basename)
    const source = await owned(
      ctx,
      args.sourceFileId,
      args.ownerTokenIdentifier
    )
    if (source.status !== "ready" || source.verifiedSize === undefined) {
      throw new ConvexError("INVALID_FILE_STATE")
    }
    await assertPathAvailable(ctx, args.ownerTokenIdentifier, args.path)
    await ensureDirectories(ctx, args.ownerTokenIdentifier, args.parentPath)
    await reserveBytes(
      ctx,
      args.ownerTokenIdentifier,
      source.verifiedSize,
      TEN_GIB
    )
    const destinationObjectKey = `files/${crypto.randomUUID()}`
    const fileId = await ctx.db.insert("files", {
      ownerClerkUserId: args.ownerClerkUserId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
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
      ownerTokenIdentifier: args.ownerTokenIdentifier,
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

export const completeCopy = internalMutation({
  args: {
    ownerTokenIdentifier: v.string(),
    fileId: v.id("files"),
    verifiedContentType: v.string(),
    verifiedSize: v.number(),
    etag: v.optional(v.string()),
  },
  returns: fileValidator,
  handler: async (ctx, args) => {
    const file = await owned(ctx, args.fileId, args.ownerTokenIdentifier)
    if (file.status === "ready") return file
    if (file.status !== "pending" || file.operation !== "copy") {
      throw new ConvexError("INVALID_FILE_STATE")
    }
    if (
      args.verifiedSize !== file.declaredSize ||
      args.verifiedContentType !== file.declaredContentType
    ) {
      throw new ConvexError("UPLOAD_MISMATCH")
    }
    const current = await usage(ctx, args.ownerTokenIdentifier)
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
    const entry = await fileEntry(ctx, args.ownerTokenIdentifier, file._id)
    if (entry) await ctx.db.patch(entry._id, { status: "ready" })
    return (await ctx.db.get(file._id))!
  },
})

export const move = internalMutation({
  args: {
    ownerTokenIdentifier: v.string(),
    fileId: v.id("files"),
    path: v.string(),
    parentPath: v.string(),
    basename: v.string(),
  },
  returns: fileValidator,
  handler: async (ctx, args) => {
    assertCanonicalPath(args.path, args.parentPath, args.basename)
    const file = await owned(ctx, args.fileId, args.ownerTokenIdentifier)
    if (file.status !== "ready") throw new ConvexError("INVALID_FILE_STATE")
    const oldParentPath = file.parentPath ?? "/"
    await assertPathAvailable(
      ctx,
      args.ownerTokenIdentifier,
      args.path,
      file._id
    )
    await ensureDirectories(ctx, args.ownerTokenIdentifier, args.parentPath)
    await ctx.db.patch(file._id, {
      path: args.path,
      parentPath: args.parentPath,
      basename: args.basename,
      originalName: args.basename,
    })
    const entry = await fileEntry(ctx, args.ownerTokenIdentifier, file._id)
    if (entry) {
      await ctx.db.patch(entry._id, {
        path: args.path,
        parentPath: args.parentPath,
        basename: args.basename,
      })
    }
    await pruneDirectories(ctx, args.ownerTokenIdentifier, oldParentPath)
    return (await ctx.db.get(file._id))!
  },
})

export const createDirectory = internalMutation({
  args: {
    ownerTokenIdentifier: v.string(),
    path: v.string(),
    parentPath: v.string(),
    basename: v.string(),
  },
  returns: entryValidator,
  handler: async (ctx, args) => {
    assertCanonicalPath(args.path, args.parentPath, args.basename)
    const existing = await ctx.db
      .query("fileEntries")
      .withIndex("by_owner_path", (q) =>
        q
          .eq("ownerTokenIdentifier", args.ownerTokenIdentifier)
          .eq("path", args.path)
      )
      .first()
    if (existing) {
      if (existing.kind !== "directory" || existing.explicit) {
        throw new ConvexError("PATH_CONFLICT")
      }
      await ctx.db.patch(existing._id, { explicit: true })
      return (await ctx.db.get(existing._id))!
    }
    await ensureDirectories(ctx, args.ownerTokenIdentifier, args.parentPath)
    const id = await ctx.db.insert("fileEntries", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      path: args.path,
      parentPath: args.parentPath,
      basename: args.basename,
      kind: "directory",
      status: "ready",
      explicit: true,
    })
    return (await ctx.db.get(id))!
  },
})

export const deleteDirectory = internalMutation({
  args: { ownerTokenIdentifier: v.string(), path: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const entry = await ctx.db
      .query("fileEntries")
      .withIndex("by_owner_path", (q) =>
        q
          .eq("ownerTokenIdentifier", args.ownerTokenIdentifier)
          .eq("path", args.path)
      )
      .first()
    if (!entry || entry.kind !== "directory") {
      throw new ConvexError("FILE_NOT_FOUND")
    }
    for (const status of ["ready", "pending", "deleting"] as const) {
      const child = await ctx.db
        .query("fileEntries")
        .withIndex("by_owner_parent_status_path", (q) =>
          q
            .eq("ownerTokenIdentifier", args.ownerTokenIdentifier)
            .eq("parentPath", args.path)
            .eq("status", status)
        )
        .first()
      if (child) throw new ConvexError("DIRECTORY_NOT_EMPTY")
    }
    await ctx.db.delete(entry._id)
    await pruneDirectories(ctx, args.ownerTokenIdentifier, entry.parentPath)
    return null
  },
})

export const MAX_DIRECTORY_MOVE_ENTRIES = 1000

export const moveDirectory = internalMutation({
  args: {
    ownerTokenIdentifier: v.string(),
    sourcePath: v.string(),
    path: v.string(),
    parentPath: v.string(),
    basename: v.string(),
  },
  returns: entryValidator,
  handler: async (ctx, args) => {
    assertCanonicalPath(args.path, args.parentPath, args.basename)
    const sourceSegments = args.sourcePath.startsWith("/")
      ? args.sourcePath.slice(1).split("/")
      : []
    assertCanonicalPath(
      args.sourcePath,
      sourceSegments.length <= 1
        ? "/"
        : `/${sourceSegments.slice(0, -1).join("/")}`,
      sourceSegments.at(-1) ?? ""
    )
    const source = await ctx.db
      .query("fileEntries")
      .withIndex("by_owner_path", (q) =>
        q
          .eq("ownerTokenIdentifier", args.ownerTokenIdentifier)
          .eq("path", args.sourcePath)
      )
      .first()
    if (!source || source.kind !== "directory") {
      throw new ConvexError("FILE_NOT_FOUND")
    }
    if (args.path === args.sourcePath) return source
    if (args.path.startsWith(`${args.sourcePath}/`)) {
      throw new ConvexError("INVALID_PATH")
    }
    await assertPathAvailable(ctx, args.ownerTokenIdentifier, args.path)
    const prefix = `${args.sourcePath}/`
    const descendants = await ctx.db
      .query("fileEntries")
      .withIndex("by_owner_path", (q) =>
        q
          .eq("ownerTokenIdentifier", args.ownerTokenIdentifier)
          .gte("path", prefix)
          .lt("path", `${prefix}\uffff`)
      )
      .take(MAX_DIRECTORY_MOVE_ENTRIES + 1)
    if (descendants.length > MAX_DIRECTORY_MOVE_ENTRIES) {
      throw new ConvexError("DIRECTORY_TOO_LARGE")
    }
    if (descendants.some((descendant) => descendant.status !== "ready")) {
      throw new ConvexError("INVALID_FILE_STATE")
    }
    const oldParentPath = source.parentPath
    await ensureDirectories(ctx, args.ownerTokenIdentifier, args.parentPath)
    await ctx.db.patch(source._id, {
      path: args.path,
      parentPath: args.parentPath,
      basename: args.basename,
    })
    for (const descendant of descendants) {
      const path = args.path + descendant.path.slice(args.sourcePath.length)
      const parentPath =
        args.path + descendant.parentPath.slice(args.sourcePath.length)
      await ctx.db.patch(descendant._id, { path, parentPath })
      if (descendant.fileId) {
        await ctx.db.patch(descendant.fileId, { path, parentPath })
      }
    }
    await pruneDirectories(ctx, args.ownerTokenIdentifier, oldParentPath)
    return (await ctx.db.get(source._id))!
  },
})

export const beginDelete = internalMutation({
  args: { ownerTokenIdentifier: v.string(), fileId: v.id("files") },
  returns: fileValidator,
  handler: async (ctx, args) => {
    const file = await owned(ctx, args.fileId, args.ownerTokenIdentifier)
    if (file.status !== "ready" && file.status !== "deleting") {
      throw new ConvexError("INVALID_FILE_STATE")
    }
    if (file.status !== "deleting") {
      await ctx.db.patch(file._id, { status: "deleting" })
      const entry = await fileEntry(ctx, args.ownerTokenIdentifier, file._id)
      if (entry) await ctx.db.patch(entry._id, { status: "deleting" })
    }
    return (await ctx.db.get(file._id))!
  },
})

export const completeDelete = internalMutation({
  args: { ownerTokenIdentifier: v.string(), fileId: v.id("files") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const file = await owned(ctx, args.fileId, args.ownerTokenIdentifier)
    if (file.status !== "deleting") throw new ConvexError("INVALID_FILE_STATE")
    const current = await usage(ctx, args.ownerTokenIdentifier)
    await ctx.db.patch(current._id, {
      usedBytes: Math.max(0, current.usedBytes - (file.verifiedSize ?? 0)),
    })
    await ctx.db.delete(file._id)
    const entry = await fileEntry(ctx, args.ownerTokenIdentifier, file._id)
    if (entry) {
      await ctx.db.delete(entry._id)
      await pruneDirectories(ctx, args.ownerTokenIdentifier, entry.parentPath)
    }
    return null
  },
})

export const cancelDelete = internalMutation({
  args: { ownerTokenIdentifier: v.string(), fileId: v.id("files") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const file = await owned(ctx, args.fileId, args.ownerTokenIdentifier)
    if (file.status === "deleting") {
      await ctx.db.patch(file._id, { status: "ready" })
      const entry = await fileEntry(ctx, args.ownerTokenIdentifier, file._id)
      if (entry) await ctx.db.patch(entry._id, { status: "ready" })
    }
    return null
  },
})

export function legacyPath(file: Doc<"files">) {
  return file.path ?? `/${file.originalName}`
}
