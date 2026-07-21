import type { EntryId } from "@convex-dev/rag"
import { paginationOptsValidator } from "convex/server"
import { ConvexError, v } from "convex/values"

import {
  MAX_TOOL_RESULT_OUTPUT_BYTES,
  utf8ByteLength,
} from "../src/server/ai/chat-history-contract"
import { fileChunkSource } from "../src/server/ai/file-chunk-metadata"
import type { FileSourceLocation } from "../src/server/ai/file-tools"
import { internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { env, internalQuery, type ActionCtx } from "./_generated/server"
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
    omittedLocationCount: number
  }>
  scannedReadyFiles: number
  scannedIndexedFiles: number
  unsearchableReadyFiles: number
  complete: boolean
  nextCursor?: string
  warnings?: Array<"LOCATIONS_TRUNCATED" | "CORPUS_CHANGED">
}

type ExactWarning = "LOCATIONS_TRUNCATED" | "CORPUS_CHANGED"

type ExactActiveFile = {
  fileId: string
  entryId: string
  chunkCursor: string | null
  occurrenceCount: number
  matchingLocationCount: number
  locations: FileSourceLocation[]
  suffix: string
  boundary: string | null
}

type ExactCursorState = {
  version: 1
  pageCursor: string | null
  fileOffset: number
  scannedReadyFiles: number
  scannedIndexedFiles: number
  unsearchableReadyFiles: number
  warnings: ExactWarning[]
  activeFile?: ExactActiveFile
}

type ExactReadyFile = {
  fileId: Id<"files">
  path: string
  entryId?: string
}

const EXACT_FILES_PER_PAGE = 25
const EXACT_CHUNKS_PER_PAGE = 200
const MAX_EXACT_CHUNKS = 2_000
const MAX_EXACT_SOURCE_BYTES = 2 * 1024 * 1024
const MAX_EXACT_COMPONENT_CALLS = 12
const MAX_EXACT_MATCHES = 10
const MAX_EXACT_LOCATIONS_PER_FILE = 20

export const getOwnedReadyFilesPage = internalQuery({
  args: {
    ownerTokenIdentifier: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(
      v.object({
        fileId: v.id("files"),
        path: v.string(),
        entryId: v.optional(v.string()),
      })
    ),
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
    return {
      page: page.page.map((file) => ({
        fileId: file._id,
        path: file.path ?? `/${file.originalName}`,
        ...(file.embeddingStatus === "ready" && file.embeddingEntryId
          ? { entryId: file.embeddingEntryId }
          : {}),
      })),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    }
  },
})

function base64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/")
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
}

async function cursorSignature(value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.FILE_SERVICE_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))
  )
}

function cursorBinding(input: {
  ownerTokenIdentifier: string
  query: string
  caseSensitive: boolean
}): string {
  return JSON.stringify({
    version: 1,
    ownerTokenIdentifier: input.ownerTokenIdentifier,
    query: input.query,
    caseSensitive: input.caseSensitive,
  })
}

async function encodeExactCursor(
  state: ExactCursorState,
  input: { ownerTokenIdentifier: string; query: string; caseSensitive: boolean }
): Promise<string> {
  const payload = base64Url(new TextEncoder().encode(JSON.stringify(state)))
  const signature = await cursorSignature(
    `${cursorBinding(input)}\u0000${payload}`
  )
  return `${payload}.${base64Url(signature)}`
}

function validCursorState(value: unknown): value is ExactCursorState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const state = value as Record<string, unknown>
  return (
    state.version === 1 &&
    (state.pageCursor === null || typeof state.pageCursor === "string") &&
    typeof state.fileOffset === "number" &&
    Number.isInteger(state.fileOffset) &&
    state.fileOffset >= 0 &&
    typeof state.scannedReadyFiles === "number" &&
    typeof state.scannedIndexedFiles === "number" &&
    typeof state.unsearchableReadyFiles === "number" &&
    Array.isArray(state.warnings)
  )
}

async function decodeExactCursor(
  cursor: string | null,
  input: { ownerTokenIdentifier: string; query: string; caseSensitive: boolean }
): Promise<ExactCursorState> {
  if (!cursor) {
    return {
      version: 1,
      pageCursor: null,
      fileOffset: 0,
      scannedReadyFiles: 0,
      scannedIndexedFiles: 0,
      unsearchableReadyFiles: 0,
      warnings: [],
    }
  }
  try {
    const [payload, presented, extra] = cursor.split(".")
    if (!payload || !presented || extra !== undefined) throw new Error()
    const expected = await cursorSignature(
      `${cursorBinding(input)}\u0000${payload}`
    )
    const payloadBytes = fromBase64Url(payload)
    const actual = fromBase64Url(presented)
    if (
      base64Url(payloadBytes) !== payload ||
      base64Url(actual) !== presented
    ) {
      throw new Error()
    }
    if (actual.length !== expected.length) throw new Error()
    let difference = 0
    for (let index = 0; index < expected.length; index += 1) {
      difference |= expected[index] ^ actual[index]
    }
    if (difference !== 0) throw new Error()
    const parsed: unknown = JSON.parse(new TextDecoder().decode(payloadBytes))
    if (!validCursorState(parsed)) throw new Error()
    return parsed
  } catch {
    throw new ConvexError("INVALID_EXACT_CURSOR")
  }
}

function countOccurrences(text: string, query: string): number {
  let count = 0
  let offset = 0
  while (true) {
    const index = text.indexOf(query, offset)
    if (index === -1) return count
    count += 1
    offset = index + 1
  }
}

function boundaryOccurrences(
  suffix: string,
  text: string,
  query: string
): number {
  if (!suffix || query.length < 2) return 0
  const prefix = text.slice(0, query.length - 1)
  const combined = suffix + prefix
  let count = 0
  let offset = 0
  while (true) {
    const index = combined.indexOf(query, offset)
    if (index === -1) return count
    if (index < suffix.length && index + query.length > suffix.length) {
      count += 1
    }
    offset = index + 1
  }
}

function sourceBoundary(
  headingPath: readonly string[],
  location: FileSourceLocation
): string {
  const heading = headingPath.join("\u001f")
  if (location.kind === "page") return `page:${location.page}:${heading}`
  if (location.kind === "slide") return `slide:${location.slide}:${heading}`
  if (location.kind === "sheet") return `sheet:${location.sheet}:${heading}`
  return `text:${heading}`
}

function addWarning(state: ExactCursorState, warning: ExactWarning) {
  if (!state.warnings.includes(warning)) state.warnings.push(warning)
}

/** Literal search with signed continuation state and fixed per-call budgets. */
export async function findExactReferencesInOwnedFiles(
  ctx: ActionCtx,
  input: {
    ownerTokenIdentifier: string
    query: string
    caseSensitive: boolean
    cursor: string | null
  }
): Promise<ExactReferenceResult> {
  const state = await decodeExactCursor(input.cursor, input)
  const needle = input.caseSensitive ? input.query : input.query.toLowerCase()
  const matches: ExactReferenceResult["matches"] = []
  let componentCalls = 1
  let chunksScanned = 0
  let sourceBytes = 0
  let completedMatches = 0
  let stopped = false

  const filesPage: {
    page: ExactReadyFile[]
    isDone: boolean
    continueCursor: string
  } = await ctx.runQuery(internal.aiFileTools.getOwnedReadyFilesPage, {
    ownerTokenIdentifier: input.ownerTokenIdentifier,
    paginationOpts: {
      cursor: state.pageCursor,
      numItems: EXACT_FILES_PER_PAGE,
    },
  })

  if (state.activeFile && !filesPage.page[state.fileOffset]) {
    addWarning(state, "CORPUS_CHANGED")
    state.activeFile = undefined
  }

  let fileOffset = state.fileOffset
  while (fileOffset < filesPage.page.length && !stopped) {
    const file = filesPage.page[fileOffset]
    if (!file.entryId) {
      state.scannedReadyFiles += 1
      state.unsearchableReadyFiles += 1
      state.activeFile = undefined
      fileOffset += 1
      continue
    }

    if (
      state.activeFile &&
      (state.activeFile.fileId !== file.fileId ||
        state.activeFile.entryId !== file.entryId)
    ) {
      addWarning(state, "CORPUS_CHANGED")
      state.activeFile = undefined
    }
    const active =
      state.activeFile ??
      ({
        fileId: file.fileId,
        entryId: file.entryId,
        chunkCursor: null,
        occurrenceCount: 0,
        matchingLocationCount: 0,
        locations: [],
        suffix: "",
        boundary: null,
      } satisfies ExactActiveFile)
    state.activeFile = active

    while (
      componentCalls < MAX_EXACT_COMPONENT_CALLS &&
      chunksScanned < MAX_EXACT_CHUNKS &&
      sourceBytes < MAX_EXACT_SOURCE_BYTES
    ) {
      const chunks = await documentRag.listChunks(ctx, {
        entryId: active.entryId as EntryId,
        order: "asc",
        paginationOpts: {
          cursor: active.chunkCursor,
          numItems: Math.min(
            EXACT_CHUNKS_PER_PAGE,
            MAX_EXACT_CHUNKS - chunksScanned
          ),
          maximumBytesRead: MAX_EXACT_SOURCE_BYTES - sourceBytes,
        },
      })
      componentCalls += 1
      for (const chunk of chunks.page) {
        const source = fileChunkSource(chunk.metadata)
        const haystack = input.caseSensitive
          ? chunk.text
          : chunk.text.toLowerCase()
        const boundary = sourceBoundary(source.headingPath, source.location)
        const acrossBoundary =
          active.boundary === boundary
            ? boundaryOccurrences(active.suffix, haystack, needle)
            : 0
        const chunkCount = countOccurrences(haystack, needle) + acrossBoundary
        if (chunkCount > 0) {
          active.occurrenceCount += chunkCount
          active.matchingLocationCount += 1
          if (active.locations.length < MAX_EXACT_LOCATIONS_PER_FILE) {
            active.locations.push(source.location)
          }
        }
        const sequence =
          active.boundary === boundary ? active.suffix + haystack : haystack
        active.suffix =
          needle.length > 1 ? sequence.slice(-(needle.length - 1)) : ""
        active.boundary = boundary
        chunksScanned += 1
        sourceBytes += utf8ByteLength(chunk.text)
      }
      if (!chunks.isDone) {
        active.chunkCursor = chunks.continueCursor
        continue
      }

      state.scannedReadyFiles += 1
      state.scannedIndexedFiles += 1
      if (active.occurrenceCount > 0) {
        const omittedLocationCount =
          active.matchingLocationCount - active.locations.length
        if (omittedLocationCount > 0) {
          addWarning(state, "LOCATIONS_TRUNCATED")
        }
        matches.push({
          fileId: file.fileId,
          path: file.path,
          occurrenceCount: active.occurrenceCount,
          locations: active.locations,
          omittedLocationCount,
        })
        completedMatches += 1
      }
      state.activeFile = undefined
      fileOffset += 1
      break
    }
    stopped =
      state.activeFile !== undefined || completedMatches >= MAX_EXACT_MATCHES
  }

  state.fileOffset = fileOffset
  let complete = false
  if (!stopped && fileOffset >= filesPage.page.length) {
    if (filesPage.isDone) {
      complete = true
      state.activeFile = undefined
    } else {
      state.pageCursor = filesPage.continueCursor
      state.fileOffset = 0
    }
  }

  const result: ExactReferenceResult = {
    matches,
    scannedReadyFiles: state.scannedReadyFiles,
    scannedIndexedFiles: state.scannedIndexedFiles,
    unsearchableReadyFiles: state.unsearchableReadyFiles,
    complete,
    ...(!complete ? { nextCursor: await encodeExactCursor(state, input) } : {}),
    ...(state.warnings.length > 0 ? { warnings: state.warnings } : {}),
  }
  if (utf8ByteLength(JSON.stringify(result)) > MAX_TOOL_RESULT_OUTPUT_BYTES) {
    throw new ConvexError("EXACT_RESULT_TOO_LARGE")
  }
  return result
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
