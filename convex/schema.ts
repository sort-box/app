import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

import { storedAiMessage } from "./chatSchemas"

export const fileStatus = v.union(
  v.literal("pending"),
  v.literal("ready"),
  v.literal("deleting"),
  v.literal("failed")
)

export const embeddingStatus = v.union(
  v.literal("not_indexed"),
  v.literal("queued"),
  v.literal("extracting"),
  v.literal("embedding"),
  v.literal("ready"),
  v.literal("failed"),
  v.literal("unsupported")
)

export const embeddingErrorCode = v.union(
  v.literal("UNSUPPORTED_TYPE"),
  v.literal("OCR_REQUIRED"),
  v.literal("TOO_LARGE"),
  v.literal("NO_TEXT"),
  v.literal("ENCRYPTED"),
  v.literal("EXTRACTION_FAILED"),
  v.literal("EMBEDDING_FAILED")
)

export const organizationPlanStatus = v.union(
  v.literal("draft"),
  v.literal("superseded"),
  v.literal("applied"),
  v.literal("rejected"),
  v.literal("stale"),
  v.literal("undone"),
  v.literal("partially_undone"),
  v.literal("failed")
)

export default defineSchema({
  chatConversations: defineTable({
    ownerTokenIdentifier: v.string(),
    /** Optional for conversations created before titles existed. */
    title: v.optional(v.string()),
    nextSequence: v.number(),
    updatedAt: v.number(),
  }).index("by_ownerTokenIdentifier_and_updatedAt", [
    "ownerTokenIdentifier",
    "updatedAt",
  ]),
  chatMessages: defineTable({
    conversationId: v.id("chatConversations"),
    sequence: v.number(),
    payload: storedAiMessage,
  }).index("by_conversationId_and_sequence", ["conversationId", "sequence"]),
  organizationPlans: defineTable({
    ownerTokenIdentifier: v.string(),
    conversationId: v.id("chatConversations"),
    previousPlanId: v.optional(v.id("organizationPlans")),
    revision: v.number(),
    status: organizationPlanStatus,
    summary: v.string(),
    warnings: v.array(v.string()),
    createdAt: v.number(),
    appliedAt: v.optional(v.number()),
    undoneAt: v.optional(v.number()),
  })
    .index("by_conversationId_and_createdAt", ["conversationId", "createdAt"])
    .index("by_ownerTokenIdentifier_and_conversationId", [
      "ownerTokenIdentifier",
      "conversationId",
    ]),
  organizationPlanOperations: defineTable({
    planId: v.id("organizationPlans"),
    ownerTokenIdentifier: v.string(),
    entryId: v.id("fileEntries"),
    fileId: v.optional(v.id("files")),
    kind: v.union(v.literal("file"), v.literal("directory")),
    beforePath: v.string(),
    afterPath: v.string(),
    undoStatus: v.optional(
      v.union(v.literal("restored"), v.literal("skipped"))
    ),
    undoReason: v.optional(v.string()),
  })
    .index("by_planId", ["planId"])
    .index("by_ownerTokenIdentifier_and_planId", [
      "ownerTokenIdentifier",
      "planId",
    ]),
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
    /** Optional during the widen/backfill phase of the embedding rollout. */
    embeddingStatus: v.optional(embeddingStatus),
    embeddingEntryId: v.optional(v.string()),
    embeddingVersion: v.optional(v.string()),
    embeddingErrorCode: v.optional(embeddingErrorCode),
    embeddingUpdatedAt: v.optional(v.number()),
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
  userUsage: defineTable(
    v.union(
      v.object({
        ownerTokenIdentifier: v.string(),
        kind: v.literal("ai"),
        inputTokens: v.number(),
        outputTokens: v.number(),
      }),
      v.object({
        ownerTokenIdentifier: v.string(),
        kind: v.literal("embedding"),
        tokens: v.number(),
      }),
      v.object({
        ownerTokenIdentifier: v.string(),
        kind: v.literal("file"),
        reservedBytes: v.number(),
        usedBytes: v.number(),
      }),
      v.object({
        ownerTokenIdentifier: v.string(),
        kind: v.literal("reranking"),
        documents: v.number(),
      })
    )
  ).index("by_owner_and_kind", ["ownerTokenIdentifier", "kind"]),
  userEntitlements: defineTable(
    v.union(
      v.object({
        ownerTokenIdentifier: v.string(),
        kind: v.literal("ai"),
        tokenLimit: v.number(),
      }),
      v.object({
        ownerTokenIdentifier: v.string(),
        kind: v.literal("embedding"),
        tokenLimit: v.number(),
      }),
      v.object({
        ownerTokenIdentifier: v.string(),
        kind: v.literal("file"),
        storageLimitBytes: v.number(),
      }),
      v.object({
        ownerTokenIdentifier: v.string(),
        kind: v.literal("reranking"),
        documentLimit: v.number(),
      })
    )
  ).index("by_owner_and_kind", ["ownerTokenIdentifier", "kind"]),
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
