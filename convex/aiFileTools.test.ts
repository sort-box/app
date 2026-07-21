/// <reference types="vite/client" />
import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { internal } from "./_generated/api"
import type { ActionCtx } from "./_generated/server"
import { findExactReferencesInOwnedFiles } from "./aiFileTools"
import { documentRag } from "./embeddings/rag"
import schema from "./schema"
import { utf8ByteLength } from "../src/server/ai/chat-history-contract"
import { findExactReferencesInputSchema } from "../src/server/ai/file-tools"

// Keep optional component test exports out of Vite's static import resolution.
const ragTestModule = "@convex-dev/rag/" + "test"
const { default: ragTest } = (await import(ragTestModule)) as {
  default: { register: (test: ReturnType<typeof convexTest>) => void }
}
const migrationsTestModule = "@convex-dev/migrations/" + "test"
const { default: migrationsTest } = (await import(migrationsTestModule)) as {
  default: { register: (test: ReturnType<typeof convexTest>) => void }
}

const modules = import.meta.glob("./**/*.ts")
function testBackend() {
  const t = convexTest(schema, modules)
  ragTest.register(t)
  migrationsTest.register(t)
  return t
}

const owner = {
  ownerClerkUserId: "owner",
  ownerTokenIdentifier: "issuer|owner",
}

const previousServiceSecret = process.env.FILE_SERVICE_SECRET

beforeEach(() => {
  vi.useFakeTimers()
  process.env.FILE_SERVICE_SECRET = "test-service-secret-that-is-long-enough"
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  if (previousServiceSecret === undefined) {
    delete process.env.FILE_SERVICE_SECRET
  } else {
    process.env.FILE_SERVICE_SECRET = previousServiceSecret
  }
})

type TestChunk = {
  text: string
  metadata: {
    headingPath: string[]
    provenance: { kind: "text"; start: number; end: number }
  }
}

function exactHarness(input: {
  chunks: readonly TestChunk[]
  entryId?: string
  searchable?: boolean
}) {
  const entryId = input.entryId ?? "entry-1"
  const runQuery = vi.fn(
    async (_query, args: { ownerTokenIdentifier: string }) => {
      expect(args.ownerTokenIdentifier).toBe(owner.ownerTokenIdentifier)
      return {
        page: [
          {
            fileId: "file-1",
            path: "/large.txt",
            ...(input.searchable === false ? {} : { entryId }),
          },
        ],
        isDone: true,
        continueCursor: "",
      }
    }
  )
  const listChunks = vi
    .spyOn(documentRag, "listChunks")
    .mockImplementation(async (_ctx, args) => {
      const start = Number(args.paginationOpts.cursor ?? 0)
      const maximumBytesRead =
        args.paginationOpts.maximumBytesRead ?? Number.POSITIVE_INFINITY
      let pageBytes = 0
      let end = start
      while (
        end < input.chunks.length &&
        end - start < args.paginationOpts.numItems
      ) {
        const nextBytes = utf8ByteLength(input.chunks[end]!.text)
        if (pageBytes + nextBytes > maximumBytesRead) break
        pageBytes += nextBytes
        end += 1
      }
      return {
        page: input.chunks.slice(start, end).map((chunk, index) => ({
          ...chunk,
          order: start + index,
          state: "ready" as const,
        })),
        continueCursor: String(end),
        isDone: end === input.chunks.length,
      } as never
    })
  return {
    ctx: { runQuery } as unknown as ActionCtx,
    listChunks,
    runQuery,
  }
}

function textChunk(text: string, index: number): TestChunk {
  return {
    text,
    metadata: {
      headingPath: [],
      provenance: { kind: "text", start: index, end: index + text.length },
    },
  }
}

describe("ai file tools", () => {
  it("rejects AI file requests without the service identity", async () => {
    const t = testBackend()
    const response = await t.fetch("/internal/ai/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "search", query: "hello", limit: 5 }),
    })

    expect(response.status).toBe(401)
  })

  it("does not read chunks of another user's file", async () => {
    const t = testBackend()
    const created = await t.mutation(internal.fileRest.createUpload, {
      ...owner,
      path: "/notes.txt",
      parentPath: "/",
      basename: "notes.txt",
      contentType: "text/plain",
      size: 5,
    })

    await expect(
      t.query(internal.aiFileTools.readOwnedFileChunks, {
        ownerTokenIdentifier: "issuer|someone-else",
        fileId: created.fileId,
        cursor: null,
        numItems: 5,
      })
    ).rejects.toThrow(/FILE_NOT_FOUND/)
  })

  it("reports content that has not finished indexing", async () => {
    const t = testBackend()
    const created = await t.mutation(internal.fileRest.createUpload, {
      ...owner,
      path: "/notes.txt",
      parentPath: "/",
      basename: "notes.txt",
      contentType: "text/plain",
      size: 5,
    })
    await t.mutation(internal.fileRest.completeUpload, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      fileId: created.fileId,
      verifiedContentType: "text/plain",
      verifiedSize: 5,
      etag: "etag",
    })

    await expect(
      t.query(internal.aiFileTools.readOwnedFileChunks, {
        ownerTokenIdentifier: owner.ownerTokenIdentifier,
        fileId: created.fileId,
        cursor: null,
        numItems: 5,
      })
    ).rejects.toThrow(/CONTENT_NOT_INDEXED/)
  })

  it.each(["/notes.txt", "notes.txt"])(
    "resolves an owned file path passed as %s",
    async (fileId) => {
      const t = testBackend()
      const created = await t.mutation(internal.fileRest.createUpload, {
        ...owner,
        path: "/notes.txt",
        parentPath: "/",
        basename: "notes.txt",
        contentType: "text/plain",
        size: 5,
      })
      await t.mutation(internal.fileRest.completeUpload, {
        ownerTokenIdentifier: owner.ownerTokenIdentifier,
        fileId: created.fileId,
        verifiedContentType: "text/plain",
        verifiedSize: 5,
        etag: "etag",
      })

      await expect(
        t.query(internal.aiFileTools.readOwnedFileChunks, {
          ownerTokenIdentifier: owner.ownerTokenIdentifier,
          fileId,
          cursor: null,
          numItems: 5,
        })
      ).rejects.toThrow(/CONTENT_NOT_INDEXED/)
    }
  )

  it("only hydrates search results for the owner's ready files", async () => {
    const t = testBackend()
    const created = await t.mutation(internal.fileRest.createUpload, {
      ...owner,
      path: "/notes.txt",
      parentPath: "/",
      basename: "notes.txt",
      contentType: "text/plain",
      size: 5,
    })

    const pending = await t.query(internal.aiFileTools.getOwnedReadyFiles, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      fileIds: [created.fileId],
    })
    expect(pending).toEqual([])

    await t.mutation(internal.fileRest.completeUpload, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      fileId: created.fileId,
      verifiedContentType: "text/plain",
      verifiedSize: 5,
      etag: "etag",
    })

    const ready = await t.query(internal.aiFileTools.getOwnedReadyFiles, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      fileIds: [created.fileId],
    })
    expect(ready).toEqual([{ fileId: created.fileId, path: "/notes.txt" }])

    const foreign = await t.query(internal.aiFileTools.getOwnedReadyFiles, {
      ownerTokenIdentifier: "issuer|someone-else",
      fileIds: [created.fileId],
    })
    expect(foreign).toEqual([])
  })
})

describe("exact reference scan", () => {
  it("resumes a 10,000-chunk file within every per-call budget", async () => {
    const chunks = Array.from({ length: 10_000 }, (_, index) =>
      textChunk("needle", index * 6)
    )
    const harness = exactHarness({ chunks })
    let cursor: string | null = null
    let result:
      Awaited<ReturnType<typeof findExactReferencesInOwnedFiles>> | undefined
    let previousCalls = 0

    for (let invocation = 0; invocation < 5; invocation += 1) {
      result = await findExactReferencesInOwnedFiles(harness.ctx, {
        ownerTokenIdentifier: owner.ownerTokenIdentifier,
        query: "needle",
        caseSensitive: true,
        cursor,
      })
      const invocationCalls =
        harness.listChunks.mock.calls.length - previousCalls
      previousCalls = harness.listChunks.mock.calls.length
      expect(invocationCalls).toBeLessThanOrEqual(11)
      expect(utf8ByteLength(JSON.stringify(result))).toBeLessThanOrEqual(
        48 * 1024
      )
      cursor = result.nextCursor ?? null
    }

    expect(result).toMatchObject({
      complete: true,
      scannedReadyFiles: 1,
      scannedIndexedFiles: 1,
      unsearchableReadyFiles: 0,
      warnings: ["LOCATIONS_TRUNCATED"],
      matches: [
        {
          occurrenceCount: 10_000,
          omittedLocationCount: 9_980,
        },
      ],
    })
    expect(result?.matches[0]?.locations).toHaveLength(20)
    expect(cursor).toBeNull()
  })

  it("stops scanning before the two MiB source-text budget", async () => {
    const chunkText = "x".repeat(200 * 1024)
    const harness = exactHarness({
      chunks: Array.from({ length: 12 }, (_, index) =>
        textChunk(chunkText, index * chunkText.length)
      ),
    })

    const first = await findExactReferencesInOwnedFiles(harness.ctx, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      query: "absent",
      caseSensitive: true,
      cursor: null,
    })

    expect(first.complete).toBe(false)
    const scannedStarts = harness.listChunks.mock.calls.map(([, args]) =>
      Number(args.paginationOpts.cursor ?? 0)
    )
    expect(Math.max(...scannedStarts)).toBe(10)
    expect(10 * utf8ByteLength(chunkText)).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(11 * utf8ByteLength(chunkText)).toBeGreaterThan(2 * 1024 * 1024)

    const second = await findExactReferencesInOwnedFiles(harness.ctx, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      query: "absent",
      caseSensitive: true,
      cursor: first.nextCursor!,
    })
    expect(second.complete).toBe(true)
    expect(second.scannedIndexedFiles).toBe(1)
  })

  it("emits at most ten completed matching files per invocation", async () => {
    const runQuery = vi.fn(async () => ({
      page: Array.from({ length: 11 }, (_, index) => ({
        fileId: `file-${index}`,
        path: `/file-${index}.txt`,
        entryId: `entry-${index}`,
      })),
      isDone: true,
      continueCursor: "",
    }))
    vi.spyOn(documentRag, "listChunks").mockImplementation(
      async (_ctx, args) =>
        ({
          page: [
            {
              ...textChunk("needle", 0),
              order: 0,
              state: "ready",
            },
          ],
          continueCursor: "",
          isDone: true,
          entryId: args.entryId,
        }) as never
    )
    const ctx = { runQuery } as unknown as ActionCtx

    const first = await findExactReferencesInOwnedFiles(ctx, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      query: "needle",
      caseSensitive: true,
      cursor: null,
    })
    expect(first.matches).toHaveLength(10)
    expect(first.complete).toBe(false)

    const second = await findExactReferencesInOwnedFiles(ctx, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      query: "needle",
      caseSensitive: true,
      cursor: first.nextCursor!,
    })
    expect(second.matches).toHaveLength(1)
    expect(second.scannedReadyFiles).toBe(11)
    expect(second.complete).toBe(true)
  })

  it("rejects cursor tampering and query mismatches", async () => {
    const harness = exactHarness({
      chunks: Array.from({ length: 2_001 }, (_, index) =>
        textChunk("needle", index * 6)
      ),
    })
    const first = await findExactReferencesInOwnedFiles(harness.ctx, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      query: "needle",
      caseSensitive: true,
      cursor: null,
    })
    expect(first.nextCursor).toBeTypeOf("string")
    const cursor = first.nextCursor!
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`

    await expect(
      findExactReferencesInOwnedFiles(harness.ctx, {
        ownerTokenIdentifier: owner.ownerTokenIdentifier,
        query: "needle",
        caseSensitive: true,
        cursor: tampered,
      })
    ).rejects.toThrow(/INVALID_EXACT_CURSOR/u)
    await expect(
      findExactReferencesInOwnedFiles(harness.ctx, {
        ownerTokenIdentifier: owner.ownerTokenIdentifier,
        query: "different",
        caseSensitive: true,
        cursor,
      })
    ).rejects.toThrow(/INVALID_EXACT_CURSOR/u)
  })

  it("handles case sensitivity and matches across adjacent chunks", async () => {
    const insensitive = exactHarness({
      chunks: [textChunk("Term nee", 0), textChunk("DLE term", 8)],
    })
    const result = await findExactReferencesInOwnedFiles(insensitive.ctx, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      query: "needle",
      caseSensitive: false,
      cursor: null,
    })
    expect(result.matches[0]?.occurrenceCount).toBe(1)

    vi.restoreAllMocks()
    const sensitive = exactHarness({
      chunks: [textChunk("Term term TERM", 0)],
    })
    const exact = await findExactReferencesInOwnedFiles(sensitive.ctx, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      query: "Term",
      caseSensitive: true,
      cursor: null,
    })
    expect(exact.matches[0]?.occurrenceCount).toBe(1)
  })

  it("preserves arbitrary literals, counts overlaps, and respects source boundaries", async () => {
    expect(findExactReferencesInputSchema.parse({ query: " a " }).query).toBe(
      " a "
    )
    const overlapping = exactHarness({ chunks: [textChunk("aaa", 0)] })
    const overlaps = await findExactReferencesInOwnedFiles(overlapping.ctx, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      query: "aa",
      caseSensitive: true,
      cursor: null,
    })
    expect(overlaps.matches[0]?.occurrenceCount).toBe(2)

    vi.restoreAllMocks()
    const separateSources = exactHarness({
      chunks: [
        {
          ...textChunk("nee", 0),
          metadata: {
            headingPath: ["first"],
            provenance: { kind: "text", start: 0, end: 3 },
          },
        },
        {
          ...textChunk("dle", 3),
          metadata: {
            headingPath: ["second"],
            provenance: { kind: "text", start: 3, end: 6 },
          },
        },
      ],
    })
    const separated = await findExactReferencesInOwnedFiles(
      separateSources.ctx,
      {
        ownerTokenIdentifier: owner.ownerTokenIdentifier,
        query: "needle",
        caseSensitive: true,
        cursor: null,
      }
    )
    expect(separated.matches).toEqual([])
  })

  it("counts ready files that cannot be searched", async () => {
    const harness = exactHarness({ chunks: [], searchable: false })

    const result = await findExactReferencesInOwnedFiles(harness.ctx, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      query: "needle",
      caseSensitive: false,
      cursor: null,
    })

    expect(result).toEqual({
      matches: [],
      scannedReadyFiles: 1,
      scannedIndexedFiles: 0,
      unsearchableReadyFiles: 1,
      complete: true,
    })
    expect(harness.listChunks).not.toHaveBeenCalled()
  })

  it("revalidates the active entry and marks corpus changes on resume", async () => {
    const chunks = Array.from({ length: 2_001 }, (_, index) =>
      textChunk("old", index * 3)
    )
    const firstHarness = exactHarness({ chunks, entryId: "entry-old" })
    const first = await findExactReferencesInOwnedFiles(firstHarness.ctx, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      query: "new",
      caseSensitive: true,
      cursor: null,
    })

    vi.restoreAllMocks()
    const resumedHarness = exactHarness({
      chunks: [textChunk("new", 0)],
      entryId: "entry-new",
    })
    const resumed = await findExactReferencesInOwnedFiles(resumedHarness.ctx, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      query: "new",
      caseSensitive: true,
      cursor: first.nextCursor!,
    })

    expect(resumed).toMatchObject({
      complete: true,
      warnings: ["CORPUS_CHANGED"],
      matches: [{ occurrenceCount: 1 }],
    })
  })
})
