import { errAsync, okAsync } from "neverthrow"
import { describe, expect, it, vi } from "vitest"

import type { RerankingPort } from "../search/reranking"
import {
  FileToolExecutorService,
  type FileToolGateway,
  type SearchCandidate,
} from "./file-tool-executor"

const candidates: SearchCandidate[] = [
  {
    fileId: "file-1",
    path: "/reports/revenue.pdf",
    text: "Revenue increased in Q2.",
    headingPath: ["Financials"],
    location: { kind: "page", page: 3 },
  },
  {
    fileId: "file-2",
    path: "/notes/summary.md",
    text: "The summary mentions revenue briefly.",
    headingPath: [],
    location: { kind: "text", start: 0, end: 40 },
  },
]

function gateway(overrides: Partial<FileToolGateway> = {}): FileToolGateway {
  return {
    listEntries: vi.fn(() =>
      okAsync({
        entries: [
          { path: "/reports", kind: "directory" as const },
          {
            fileId: "file-1",
            path: "/reports/revenue.pdf",
            kind: "file" as const,
            indexStatus: "ready" as const,
          },
        ],
        nextCursor: "cursor-2",
      })
    ),
    searchCandidates: vi.fn(() => okAsync(candidates)),
    findExactReferences: vi.fn(() =>
      okAsync({
        matches: [
          {
            fileId: "file-1",
            path: "/reports/revenue.pdf",
            occurrenceCount: 2,
            locations: [{ kind: "page" as const, page: 3 }],
            omittedLocationCount: 4,
          },
        ],
        scannedReadyFiles: 3,
        scannedIndexedFiles: 2,
        unsearchableReadyFiles: 1,
        complete: false,
        nextCursor: "exact-cursor",
        warnings: ["LOCATIONS_TRUNCATED" as const],
      })
    ),
    readChunks: vi.fn(() =>
      okAsync({
        file: {
          fileId: "file-1",
          path: "/reports/revenue.pdf",
          contentType: "application/pdf",
        },
        chunks: [
          {
            text: "Revenue increased in Q2.",
            headingPath: ["Financials"],
            location: { kind: "page" as const, page: 3 },
          },
        ],
        nextCursor: "chunk-cursor",
      })
    ),
    ...overrides,
  }
}

function reranking(overrides: Partial<RerankingPort> = {}): RerankingPort {
  return {
    rerank: vi.fn(() =>
      okAsync([
        { id: "1", score: 0.9 },
        { id: "0", score: 0.4 },
      ])
    ),
    ...overrides,
  }
}

describe("FileToolExecutorService", () => {
  it("lists files with defaults and maps entries to the tool contract", async () => {
    const files = gateway()
    const service = new FileToolExecutorService(files, reranking())

    const result = await service.listFiles({})

    expect(files.listEntries).toHaveBeenCalledWith({
      path: "/",
      cursor: null,
      limit: 50,
    })
    expect(result._unsafeUnwrap()).toEqual({
      entries: [
        { path: "/reports", kind: "directory" },
        {
          file_id: "file-1",
          path: "/reports/revenue.pdf",
          kind: "file",
          index_status: "ready",
        },
      ],
      next_cursor: "cursor-2",
    })
  })

  it("returns reranked search matches", async () => {
    const rerank = reranking()
    const service = new FileToolExecutorService(gateway(), rerank)

    const result = await service.searchFiles({ query: "revenue", limit: 2 })

    expect(rerank.rerank).toHaveBeenCalledWith({
      query: "revenue",
      candidates: [
        { id: "0", text: candidates[0]!.text },
        { id: "1", text: candidates[1]!.text },
      ],
      limit: candidates.length,
    })
    expect(result._unsafeUnwrap()).toEqual({
      matches: [
        {
          file_id: "file-2",
          path: "/notes/summary.md",
          excerpt: candidates[1]!.text,
          heading_path: [],
          location: { kind: "text", start: 0, end: 40 },
        },
        {
          file_id: "file-1",
          path: "/reports/revenue.pdf",
          excerpt: candidates[0]!.text,
          heading_path: ["Financials"],
          location: { kind: "page", page: 3 },
        },
      ],
      incomplete: false,
    })
  })

  it("deduplicates semantic search results by file", async () => {
    const duplicate = { ...candidates[0]!, text: "A second matching chunk." }
    const service = new FileToolExecutorService(
      gateway({
        searchCandidates: vi.fn(() =>
          okAsync([candidates[0]!, duplicate, candidates[1]!])
        ),
      }),
      reranking({
        rerank: vi.fn(() =>
          okAsync([
            { id: "0", score: 0.9 },
            { id: "1", score: 0.8 },
            { id: "2", score: 0.7 },
          ])
        ),
      })
    )

    const result = await service.searchFiles({ query: "revenue", limit: 2 })

    expect(
      result._unsafeUnwrap().matches.map((match) => match.file_id)
    ).toEqual(["file-1", "file-2"])
  })

  it("maps exact-search coverage and pagination", async () => {
    const files = gateway()
    const service = new FileToolExecutorService(files, reranking())

    const result = await service.findExactReferences({ query: "Revenue" })

    expect(files.findExactReferences).toHaveBeenCalledWith({
      query: "Revenue",
      caseSensitive: false,
      cursor: null,
    })
    expect(result._unsafeUnwrap()).toEqual({
      matches: [
        {
          file_id: "file-1",
          path: "/reports/revenue.pdf",
          occurrence_count: 2,
          locations: [{ kind: "page", page: 3 }],
          omitted_location_count: 4,
        },
      ],
      scanned_ready_files: 3,
      scanned_indexed_files: 2,
      unsearchable_ready_files: 1,
      complete: false,
      next_cursor: "exact-cursor",
      warnings: ["LOCATIONS_TRUNCATED"],
    })
  })

  it("falls back to vector order with a warning when reranking fails", async () => {
    const service = new FileToolExecutorService(
      gateway(),
      reranking({
        rerank: vi.fn(() =>
          errAsync({ code: "UNAVAILABLE" as const, retryable: true as const })
        ),
      })
    )

    const result = await service.searchFiles({ query: "revenue", limit: 1 })

    expect(result._unsafeUnwrap()).toEqual({
      matches: [
        {
          file_id: "file-1",
          path: "/reports/revenue.pdf",
          excerpt: candidates[0]!.text,
          heading_path: ["Financials"],
          location: { kind: "page", page: 3 },
        },
      ],
      incomplete: false,
      warnings: ["RERANK_UNAVAILABLE"],
    })
  })

  it("skips reranking when the search has no candidates", async () => {
    const rerank = reranking()
    const service = new FileToolExecutorService(
      gateway({ searchCandidates: vi.fn(() => okAsync([])) }),
      rerank
    )

    const result = await service.searchFiles({ query: "nothing" })

    expect(rerank.rerank).not.toHaveBeenCalled()
    expect(result._unsafeUnwrap()).toEqual({ matches: [], incomplete: false })
  })

  it("reads file chunks and translates gateway errors", async () => {
    const files = gateway()
    const service = new FileToolExecutorService(files, reranking())

    const read = await service.readFile({ file_id: "file-1" })
    expect(files.readChunks).toHaveBeenCalledWith({
      fileId: "file-1",
      cursor: null,
      limit: 10,
    })
    expect(read._unsafeUnwrap()).toEqual({
      file: {
        file_id: "file-1",
        path: "/reports/revenue.pdf",
        content_type: "application/pdf",
      },
      chunks: [
        {
          text: "Revenue increased in Q2.",
          heading_path: ["Financials"],
          location: { kind: "page", page: 3 },
        },
      ],
      next_cursor: "chunk-cursor",
    })

    const missing = new FileToolExecutorService(
      gateway({
        readChunks: vi.fn(() =>
          errAsync({ code: "CONTENT_NOT_INDEXED" as const, retryable: false })
        ),
      }),
      reranking()
    )
    const failed = await missing.readFile({ file_id: "file-9" })
    expect(failed._unsafeUnwrapErr()).toEqual({
      code: "CONTENT_NOT_INDEXED",
      message: "The file content is not indexed yet.",
      retryable: false,
    })
  })
})
