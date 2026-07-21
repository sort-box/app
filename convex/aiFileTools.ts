import type { EntryId } from "@convex-dev/rag"
import { paginationOptsValidator } from "convex/server"
import { ConvexError, v } from "convex/values"

import { fileChunkSource } from "../src/server/ai/file-chunk-metadata"
import type { FileSourceLocation } from "../src/server/ai/file-tools"
import { internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { internalQuery, type ActionCtx } from "./_generated/server"
import { documentRag } from "./embeddings/rag"

const locationValidator = v.union(
  v.object({ kind: v.literal("page"), page: v.number() }),
  v.object({ kind: v.literal("slide"), slide: v.number() }),
  v.object({
    kind: v.literal("sheet"),
    sheet: v.string(),
    row_start: v.number(),
    row_end: v.number(),
  }),
  v.object({ kind: v.literal("text"), start: v.number(), end: v.number() })
)

const chunkValidator = v.object({
  text: v.string(),
  headingPath: v.array(v.string()),
  location: locationValidator,
})

export type AiSearchCandidate = {
  fileId: string
  path: string
  text: string
  headingPath: string[]
  location: FileSourceLocation
}

export type ExactReferenceResult = {
  matches: Array<{
    fileId: string
    path: string
    occurrenceCount: number
    locations: FileSourceLocation[]
  }>
  scannedIndexedFiles: number
  totalReadyFiles: number
  unsearchableReadyFiles: number
  complete: boolean
  nextCursor?: string
}

export const getOwnedReadyFileCoveragePage = internalQuery({
  args: {
    ownerTokenIdentifier: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    searchable: v.number(),
    unsearchable: v.number(),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("files")
      .withIndex("by_ownerTokenIdentifier_and_status", (q) =>
        q
          .eq("ownerTokenIdentifier", args.ownerTokenIdentifier)
          .eq("status", "ready")
      )
      .paginate(args.paginationOpts)
    const searchable = page.page.filter(
      (file) => file.embeddingStatus === "ready" && file.embeddingEntryId
    ).length
    return {
      searchable,
      unsearchable: page.page.length - searchable,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    }
  },
})

async function ownedReadyFileCoverage(
  ctx: ActionCtx,
  ownerTokenIdentifier: string
): Promise<{ totalReadyFiles: number; unsearchableReadyFiles: number }> {
  let cursor: string | null = null
  let searchable = 0
  let unsearchable = 0
  while (true) {
    const page: {
      searchable: number
      unsearchable: number
      isDone: boolean
      continueCursor: string
    } = await ctx.runQuery(internal.aiFileTools.getOwnedReadyFileCoveragePage, {
      ownerTokenIdentifier,
      paginationOpts: { cursor, numItems: 100 },
    })
    searchable += page.searchable
    unsearchable += page.unsearchable
    if (page.isDone) break
    cursor = page.continueCursor
  }
  return {
    totalReadyFiles: searchable + unsearchable,
    unsearchableReadyFiles: unsearchable,
  }
}

function countOccurrences(text: string, query: string): number {
  let count = 0
  let offset = 0
  while (true) {
    const index = text.indexOf(query, offset)
    if (index === -1) return count
    count += 1
    offset = index + query.length
  }
}

/** Literal, file-deduplicated search over a page of the caller's RAG entries. */
export async function findExactReferencesInOwnedFiles(
  ctx: ActionCtx,
  input: {
    ownerTokenIdentifier: string
    query: string
    caseSensitive: boolean
    cursor: string | null
    limit: number
  }
): Promise<ExactReferenceResult> {
  const namespace = await documentRag.getNamespace(ctx, {
    namespace: input.ownerTokenIdentifier,
  })
  const coverage = await ownedReadyFileCoverage(ctx, input.ownerTokenIdentifier)
  if (!namespace) {
    return {
      matches: [],
      scannedIndexedFiles: 0,
      ...coverage,
      complete: true,
    }
  }

  const entries = await documentRag.list(ctx, {
    namespaceId: namespace.namespaceId,
    status: "ready",
    paginationOpts: { cursor: input.cursor, numItems: input.limit },
  })
  const ownedFiles = await ctx.runQuery(
    internal.aiFileTools.getOwnedReadyFiles,
    {
      ownerTokenIdentifier: input.ownerTokenIdentifier,
      fileIds: entries.page.flatMap((entry) => {
        const fileId = entry.metadata?.fileId
        return typeof fileId === "string" ? [fileId as Id<"files">] : []
      }),
    }
  )
  const paths = new Map(ownedFiles.map((file) => [file.fileId, file.path]))
  const needle = input.caseSensitive
    ? input.query
    : input.query.toLocaleLowerCase()
  const matches: ExactReferenceResult["matches"] = []

  for (const entry of entries.page) {
    const fileId = entry.metadata?.fileId as Id<"files"> | undefined
    const path = fileId ? paths.get(fileId) : undefined
    if (!fileId || !path) continue
    let chunkCursor: string | null = null
    let occurrenceCount = 0
    const locations: FileSourceLocation[] = []
    while (true) {
      const chunks = await documentRag.listChunks(ctx, {
        entryId: entry.entryId,
        order: "asc",
        paginationOpts: { cursor: chunkCursor, numItems: 100 },
      })
      for (const chunk of chunks.page) {
        const haystack = input.caseSensitive
          ? chunk.text
          : chunk.text.toLocaleLowerCase()
        const chunkCount = countOccurrences(haystack, needle)
        if (chunkCount > 0) {
          occurrenceCount += chunkCount
          locations.push(fileChunkSource(chunk.metadata).location)
        }
      }
      if (chunks.isDone) break
      chunkCursor = chunks.continueCursor
    }
    if (occurrenceCount > 0) {
      matches.push({ fileId, path, occurrenceCount, locations })
    }
  }

  return {
    matches,
    scannedIndexedFiles: entries.page.length,
    ...coverage,
    complete: entries.isDone,
    ...(entries.isDone ? {} : { nextCursor: entries.continueCursor }),
  }
}

export const getOwnedReadyFiles = internalQuery({
  args: {
    ownerTokenIdentifier: v.string(),
    fileIds: v.array(v.id("files")),
  },
  returns: v.array(v.object({ fileId: v.id("files"), path: v.string() })),
  handler: async (ctx, args) => {
    const files: Array<{ fileId: Id<"files">; path: string }> = []
    for (const fileId of args.fileIds) {
      const file = await ctx.db.get("files", fileId)
      if (
        file &&
        file.ownerTokenIdentifier === args.ownerTokenIdentifier &&
        file.status === "ready"
      ) {
        files.push({
          fileId: file._id,
          path: file.path ?? `/${file.originalName}`,
        })
      }
    }
    return files
  },
})

/**
 * Vector search over the caller's indexed documents. Results whose backing
 * file is no longer owned and ready are dropped, which covers the window
 * between a file deletion and its asynchronous RAG entry cleanup.
 */
export async function searchOwnedFiles(
  ctx: ActionCtx,
  input: { ownerTokenIdentifier: string; query: string; limit: number }
): Promise<AiSearchCandidate[]> {
  const namespace = await documentRag.getNamespace(ctx, {
    namespace: input.ownerTokenIdentifier,
  })
  if (!namespace) return []

  const { results, entries } = await documentRag.search(ctx, {
    namespace: input.ownerTokenIdentifier,
    query: input.query,
    limit: input.limit,
  })

  const entryFileIds = new Map<string, Id<"files">>()
  for (const entry of entries) {
    const fileId = entry.metadata?.fileId
    if (typeof fileId === "string") {
      entryFileIds.set(entry.entryId, fileId as Id<"files">)
    }
  }
  const files: Array<{ fileId: Id<"files">; path: string }> =
    await ctx.runQuery(internal.aiFileTools.getOwnedReadyFiles, {
      ownerTokenIdentifier: input.ownerTokenIdentifier,
      fileIds: [...new Set(entryFileIds.values())],
    })
  const paths = new Map(files.map((file) => [file.fileId, file.path]))

  const candidates: AiSearchCandidate[] = []
  for (const result of results) {
    const fileId = entryFileIds.get(result.entryId)
    const path = fileId ? paths.get(fileId) : undefined
    const first = result.content[0]
    if (!fileId || !path || !first) continue
    const source = fileChunkSource(first.metadata)
    candidates.push({
      fileId,
      path,
      text: result.content.map((chunk) => chunk.text).join("\n"),
      headingPath: [...source.headingPath],
      location: source.location,
    })
  }
  return candidates
}

export const readOwnedFileChunks = internalQuery({
  args: {
    ownerTokenIdentifier: v.string(),
    fileId: v.string(),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  returns: v.object({
    file: v.object({
      fileId: v.id("files"),
      path: v.string(),
      contentType: v.string(),
    }),
    chunks: v.array(chunkValidator),
    nextCursor: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const normalizedId = ctx.db.normalizeId("files", args.fileId)
    const path = args.fileId.startsWith("/") ? args.fileId : `/${args.fileId}`
    const file = normalizedId
      ? await ctx.db.get("files", normalizedId)
      : await ctx.db
          .query("files")
          .withIndex("by_owner_and_path", (q) =>
            q
              .eq("ownerTokenIdentifier", args.ownerTokenIdentifier)
              .eq("path", path)
          )
          .unique()
    if (
      !file ||
      file.ownerTokenIdentifier !== args.ownerTokenIdentifier ||
      file.status !== "ready"
    ) {
      throw new ConvexError("FILE_NOT_FOUND")
    }
    if (file.embeddingStatus !== "ready" || !file.embeddingEntryId) {
      throw new ConvexError("CONTENT_NOT_INDEXED")
    }
    const page = await documentRag.listChunks(ctx, {
      entryId: file.embeddingEntryId as EntryId,
      paginationOpts: { cursor: args.cursor, numItems: args.numItems },
    })
    return {
      file: {
        fileId: file._id,
        path: file.path ?? `/${file.originalName}`,
        contentType: file.verifiedContentType ?? file.declaredContentType,
      },
      chunks: page.page.map((chunk) => {
        const source = fileChunkSource(chunk.metadata)
        return {
          text: chunk.text,
          headingPath: [...source.headingPath],
          location: source.location,
        }
      }),
      ...(page.isDone ? {} : { nextCursor: page.continueCursor }),
    }
  },
})
