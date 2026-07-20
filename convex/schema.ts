import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

export const fileStatus = v.union(
  v.literal("pending"),
  v.literal("ready"),
  v.literal("deleting"),
  v.literal("failed")
)

export default defineSchema({
  files: defineTable({
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
    /** Optional until the path backfill has completed. */
    path: v.optional(v.string()),
    parentPath: v.optional(v.string()),
    basename: v.optional(v.string()),
    operation: v.optional(v.union(v.literal("upload"), v.literal("copy"))),
    usageBackfilledAt: v.optional(v.number()),
  })
    .index("by_ownerTokenIdentifier_and_status", [
      "ownerTokenIdentifier",
      "status",
    ])
    .index("by_status", ["status"])
    .index("by_objectKey", ["objectKey"])
    .index("by_owner_and_path", ["ownerTokenIdentifier", "path"])
    .index("by_owner_parent_status", [
      "ownerTokenIdentifier",
      "parentPath",
      "status",
      "path",
    ]),
  fileUsage: defineTable({
    ownerTokenIdentifier: v.string(),
    reservedBytes: v.number(),
    usedBytes: v.number(),
  }).index("by_owner", ["ownerTokenIdentifier"]),
  fileRateLimits: defineTable({
    ownerTokenIdentifier: v.string(),
    bucket: v.string(),
    windowStartedAt: v.number(),
    count: v.number(),
  }).index("by_owner_bucket", ["ownerTokenIdentifier", "bucket"]),
  fileEntries: defineTable({
    ownerTokenIdentifier: v.string(),
    path: v.string(),
    parentPath: v.string(),
    basename: v.string(),
    kind: v.union(v.literal("file"), v.literal("directory")),
    fileId: v.optional(v.id("files")),
    status: fileStatus,
    /**
     * Directory created explicitly by the user; kept when empty and only
     * removed by an explicit delete.
     */
    explicit: v.optional(v.boolean()),
  })
    .index("by_owner_path", ["ownerTokenIdentifier", "path"])
    .index("by_owner_fileId", ["ownerTokenIdentifier", "fileId"])
    .index("by_owner_parent_status_path", [
      "ownerTokenIdentifier",
      "parentPath",
      "status",
      "path",
    ]),
})
