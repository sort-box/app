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
  })
    .index("by_ownerTokenIdentifier_and_status", [
      "ownerTokenIdentifier",
      "status",
    ])
    .index("by_status", ["status"])
    .index("by_objectKey", ["objectKey"]),
})
