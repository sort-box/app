import type { EntryId } from "@convex-dev/rag"
import { ConvexError, v } from "convex/values"

import {
  EMBEDDING_VERSION,
  MAX_EMBEDDING_SOURCE_BYTES,
  embeddableDocumentKind,
} from "../src/server/embeddings/document-types"
import { internal } from "./_generated/api"
import type { DataModel, Doc, Id } from "./_generated/dataModel"
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server"
import { documentRag } from "./embeddings/rag"

const errorCodes = [
  "UNSUPPORTED_TYPE",
  "OCR_REQUIRED",
  "TOO_LARGE",
  "NO_TEXT",
  "ENCRYPTED",
  "EXTRACTION_FAILED",
  "EMBEDDING_FAILED",
] as const

type EmbeddingErrorCode = (typeof errorCodes)[number]

function safeErrorCode(error: string | null): EmbeddingErrorCode {
  return errorCodes.find((code) => error?.includes(code)) ?? "EMBEDDING_FAILED"
}

export async function queueFileEmbedding(
  ctx: MutationCtx,
  file: Doc<"files">
): Promise<void> {
  const contentType = file.verifiedContentType ?? file.declaredContentType
  const size = file.verifiedSize ?? file.declaredSize
  const now = Date.now()
  if (size > MAX_EMBEDDING_SOURCE_BYTES) {
    await ctx.db.patch(file._id, {
      embeddingStatus: "failed",
      embeddingErrorCode: "TOO_LARGE",
      embeddingUpdatedAt: now,
      embeddingVersion: EMBEDDING_VERSION,
    })
    return
  }
  if (!embeddableDocumentKind(file.originalName, contentType)) {
    await ctx.db.patch(file._id, {
      embeddingStatus: "unsupported",
      embeddingErrorCode: "UNSUPPORTED_TYPE",
      embeddingUpdatedAt: now,
      embeddingVersion: EMBEDDING_VERSION,
    })
    return
  }

  await ctx.db.patch(file._id, {
    embeddingStatus: "queued",
    embeddingEntryId: undefined,
    embeddingErrorCode: undefined,
    embeddingUpdatedAt: now,
    embeddingVersion: EMBEDDING_VERSION,
  })
  try {
    const result = await documentRag.addAsync(ctx, {
      namespace: file.ownerTokenIdentifier,
      key: file._id,
      title: file.basename ?? file.originalName,
      contentHash: `${file.etag ?? size}:${EMBEDDING_VERSION}`,
      chunkerAction: internal.documentEmbeddingAction.chunkDocument,
      onComplete: internal.documentEmbedding.completeEmbedding,
      metadata: {
        contentType,
        fileId: file._id,
        version: EMBEDDING_VERSION,
      },
    })
    await ctx.db.patch(file._id, {
      embeddingEntryId: result.entryId,
      embeddingStatus: result.status === "ready" ? "ready" : "queued",
      embeddingUpdatedAt: Date.now(),
    })
  } catch (cause) {
    console.error("Failed to enqueue document embedding.", cause)
    await ctx.db.patch(file._id, {
      embeddingStatus: "failed",
      embeddingErrorCode: "EMBEDDING_FAILED",
      embeddingUpdatedAt: Date.now(),
    })
  }
}

export const setEmbeddingStage = internalMutation({
  args: {
    fileId: v.id("files"),
    entryId: v.string(),
    stage: v.union(v.literal("extracting"), v.literal("embedding")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const file = await ctx.db.get("files", args.fileId)
    if (file?.status === "ready" && file.embeddingEntryId === args.entryId) {
      await ctx.db.patch(file._id, {
        embeddingStatus: args.stage,
        embeddingUpdatedAt: Date.now(),
      })
    }
    return null
  },
})

export const getEmbeddingSourceMetadata = internalQuery({
  args: {
    fileId: v.id("files"),
    entryId: v.string(),
  },
  returns: v.union(
    v.object({
      contentType: v.string(),
      fileName: v.string(),
      objectKey: v.string(),
      size: v.number(),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    const file = await ctx.db.get("files", args.fileId)
    if (file?.status !== "ready" || file.embeddingEntryId !== args.entryId) {
      return null
    }
    return {
      contentType: file.verifiedContentType ?? file.declaredContentType,
      fileName: file.basename ?? file.originalName,
      objectKey: file.objectKey,
      size: file.verifiedSize ?? file.declaredSize,
    }
  },
})

export const completeEmbedding = documentRag.defineOnComplete<DataModel>(
  async (ctx, { entry, replacedEntry, error }) => {
    const fileId = entry.metadata?.fileId as Id<"files"> | undefined
    const file = fileId ? await ctx.db.get("files", fileId) : null
    const isCurrent =
      file?.embeddingEntryId === entry.entryId && file.status === "ready"

    if (!isCurrent) {
      await documentRag.deleteAsync(ctx, { entryId: entry.entryId })
    } else if (error) {
      await ctx.db.patch(file._id, {
        embeddingStatus: "failed",
        embeddingEntryId: undefined,
        embeddingErrorCode: safeErrorCode(error),
        embeddingUpdatedAt: Date.now(),
      })
      await documentRag.deleteAsync(ctx, { entryId: entry.entryId })
    } else {
      await ctx.db.patch(file._id, {
        embeddingStatus: "ready",
        embeddingErrorCode: undefined,
        embeddingUpdatedAt: Date.now(),
        embeddingVersion: EMBEDDING_VERSION,
      })
    }

    if (isCurrent && !error && replacedEntry) {
      await documentRag.deleteAsync(ctx, {
        entryId: replacedEntry.entryId,
      })
    }
  }
)

export async function deleteFileEmbedding(
  ctx: MutationCtx,
  entryId: string | undefined
) {
  if (entryId) {
    try {
      await documentRag.deleteAsync(ctx, {
        entryId: entryId as EntryId,
      })
    } catch (cause) {
      // RAG deletion is not idempotent. Treat an already-removed entry as the
      // desired state so stale callbacks and file deletion can safely retry.
      if (!(
        cause instanceof Error && /Entry .* not found/u.test(cause.message)
      )) {
        throw cause
      }
    }
  }
}

export const verifyEmbeddingBackfill = internalQuery({
  args: {},
  returns: v.object({
    complete: v.boolean(),
    sampleRemaining: v.array(v.id("files")),
  }),
  handler: async (ctx) => {
    // This full scan is intentionally a temporary, manually invoked rollout
    // verification. Do not schedule it as a cron after the backfill completes.
    const remaining = await ctx.db
      .query("files")
      .filter((q) => q.eq(q.field("embeddingStatus"), undefined))
      .take(10)
    return {
      complete: remaining.length === 0,
      sampleRemaining: remaining.map((file) => file._id),
    }
  },
})

export function shouldRestartEmbedding(file: Doc<"files">) {
  if (file.status !== "ready") {
    throw new ConvexError("INVALID_FILE_STATE")
  }
  if (
    file.embeddingStatus === "queued" ||
    file.embeddingStatus === "extracting" ||
    file.embeddingStatus === "embedding" ||
    file.embeddingStatus === "ready"
  ) {
    return file.embeddingStatus !== "ready"
  }
  if (file.embeddingStatus !== "failed") {
    throw new ConvexError("INVALID_FILE_STATE")
  }
  return true
}
