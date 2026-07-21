import { okAsync, type ResultAsync } from "neverthrow"

import type { RerankingPort } from "../search/reranking"
import type {
  FileIndexStatus,
  FileSourceLocation,
  FileToolError,
  FileToolExecutor,
  FindExactReferencesInput,
  FindExactReferencesOutput,
  ListFilesInput,
  ListFilesOutput,
  ReadFileInput,
  ReadFileOutput,
  SearchFilesInput,
  SearchFilesOutput,
} from "./file-tools"

const DEFAULT_LIST_LIMIT = 50
const DEFAULT_SEARCH_LIMIT = 8
const DEFAULT_READ_CHUNKS = 10
const MAX_SEARCH_CANDIDATES = 30
const MAX_EXCERPT_LENGTH = 700

export type FileToolGatewayError = {
  code:
    | "INVALID_INPUT"
    | "NOT_AUTHENTICATED"
    | "FILE_NOT_FOUND"
    | "CONTENT_NOT_INDEXED"
    | "RATE_LIMITED"
    | "UNAVAILABLE"
  retryable: boolean
}

export type FileEntrySummary = {
  fileId?: string
  path: string
  kind: "file" | "directory"
  indexStatus?: FileIndexStatus
}

export type SearchCandidate = {
  fileId: string
  path: string
  text: string
  headingPath: readonly string[]
  location: FileSourceLocation
}

export type FileChunk = {
  text: string
  headingPath: readonly string[]
  location: FileSourceLocation
}

export type FileChunkPage = {
  file: { fileId: string; path: string; contentType: string }
  chunks: readonly FileChunk[]
  nextCursor?: string
}

export type ExactReferencePage = {
  matches: readonly {
    fileId: string
    path: string
    occurrenceCount: number
    locations: readonly FileSourceLocation[]
    omittedLocationCount: number
  }[]
  scannedReadyFiles: number
  scannedIndexedFiles: number
  unsearchableReadyFiles: number
  complete: boolean
  nextCursor?: string
  warnings?: readonly ("LOCATIONS_TRUNCATED" | "CORPUS_CHANGED")[]
}

/**
 * Provider-neutral access to one user's file data on behalf of the AI tools.
 * Implementations must scope every operation to the authenticated owner.
 */
export interface FileToolGateway {
  listEntries: (input: {
    path: string
    cursor: string | null
    limit: number
  }) => ResultAsync<
    { entries: readonly FileEntrySummary[]; nextCursor?: string },
    FileToolGatewayError
  >
  searchCandidates: (input: {
    query: string
    limit: number
  }) => ResultAsync<readonly SearchCandidate[], FileToolGatewayError>
  findExactReferences: (input: {
    query: string
    caseSensitive: boolean
    cursor: string | null
  }) => ResultAsync<ExactReferencePage, FileToolGatewayError>
  readChunks: (input: {
    fileId: string
    cursor: string | null
    limit: number
  }) => ResultAsync<FileChunkPage, FileToolGatewayError>
}

const toolErrorMessages: Record<FileToolGatewayError["code"], string> = {
  INVALID_INPUT: "The file tool input was invalid.",
  NOT_AUTHENTICATED: "Authentication is required.",
  FILE_NOT_FOUND: "The file was not found.",
  CONTENT_NOT_INDEXED: "The file content is not indexed yet.",
  RATE_LIMITED: "Too many file requests.",
  UNAVAILABLE: "The file service is temporarily unavailable.",
}

function toolError(error: FileToolGatewayError): FileToolError {
  return {
    code: error.code,
    message: toolErrorMessages[error.code],
    retryable: error.retryable,
  }
}

function excerpt(text: string): string {
  return text.length <= MAX_EXCERPT_LENGTH
    ? text
    : `${text.slice(0, MAX_EXCERPT_LENGTH)}…`
}

function toMatch(candidate: SearchCandidate) {
  return {
    file_id: candidate.fileId,
    path: candidate.path,
    excerpt: excerpt(candidate.text),
    heading_path: candidate.headingPath,
    location: candidate.location,
  }
}

function uniqueCandidates(
  candidates: readonly SearchCandidate[],
  limit: number
): SearchCandidate[] {
  const seen = new Set<string>()
  const unique: SearchCandidate[] = []
  for (const candidate of candidates) {
    if (seen.has(candidate.fileId)) continue
    seen.add(candidate.fileId)
    unique.push(candidate)
    if (unique.length === limit) break
  }
  return unique
}

/** Executes the AI file tools against a gateway, reranking search results. */
export class FileToolExecutorService implements FileToolExecutor {
  constructor(
    private readonly gateway: FileToolGateway,
    private readonly reranking: RerankingPort
  ) {}

  listFiles(
    input: ListFilesInput
  ): ResultAsync<ListFilesOutput, FileToolError> {
    return this.gateway
      .listEntries({
        path: input.path ?? "/",
        cursor: input.cursor ?? null,
        limit: input.limit ?? DEFAULT_LIST_LIMIT,
      })
      .map(({ entries, nextCursor }) => ({
        entries: entries.map((entry) => ({
          ...(entry.fileId !== undefined ? { file_id: entry.fileId } : {}),
          path: entry.path,
          kind: entry.kind,
          ...(entry.indexStatus !== undefined
            ? { index_status: entry.indexStatus }
            : {}),
        })),
        ...(nextCursor !== undefined ? { next_cursor: nextCursor } : {}),
      }))
      .mapErr(toolError)
  }

  searchFiles(
    input: SearchFilesInput
  ): ResultAsync<SearchFilesOutput, FileToolError> {
    const limit = input.limit ?? DEFAULT_SEARCH_LIMIT
    return this.gateway
      .searchCandidates({
        query: input.query,
        limit: Math.min(MAX_SEARCH_CANDIDATES, limit * 3),
      })
      .mapErr(toolError)
      .andThen((candidates) => {
        if (candidates.length === 0) {
          return okAsync<SearchFilesOutput, FileToolError>({
            matches: [],
            incomplete: false,
          })
        }
        return this.reranking
          .rerank({
            query: input.query,
            candidates: candidates.map((candidate, index) => ({
              id: String(index),
              text: candidate.text,
            })),
            limit: candidates.length,
          })
          .map<SearchFilesOutput>((ranked) => ({
            matches: uniqueCandidates(
              ranked.flatMap((result) => {
                const candidate = candidates[Number(result.id)]
                return candidate ? [candidate] : []
              }),
              limit
            ).map(toMatch),
            incomplete: false,
          }))
          .orElse(() =>
            okAsync<SearchFilesOutput, FileToolError>({
              matches: uniqueCandidates(candidates, limit).map(toMatch),
              incomplete: false,
              warnings: ["RERANK_UNAVAILABLE"],
            })
          )
      })
  }

  findExactReferences(
    input: FindExactReferencesInput
  ): ResultAsync<FindExactReferencesOutput, FileToolError> {
    return this.gateway
      .findExactReferences({
        query: input.query,
        caseSensitive: input.case_sensitive ?? false,
        cursor: input.cursor ?? null,
      })
      .map((page) => ({
        matches: page.matches.map((match) => ({
          file_id: match.fileId,
          path: match.path,
          occurrence_count: match.occurrenceCount,
          locations: match.locations,
          omitted_location_count: match.omittedLocationCount,
        })),
        scanned_ready_files: page.scannedReadyFiles,
        scanned_indexed_files: page.scannedIndexedFiles,
        unsearchable_ready_files: page.unsearchableReadyFiles,
        complete: page.complete,
        ...(page.nextCursor !== undefined
          ? { next_cursor: page.nextCursor }
          : {}),
        ...(page.warnings !== undefined ? { warnings: page.warnings } : {}),
      }))
      .mapErr(toolError)
  }

  readFile(input: ReadFileInput): ResultAsync<ReadFileOutput, FileToolError> {
    return this.gateway
      .readChunks({
        fileId: input.file_id,
        cursor: input.cursor ?? null,
        limit: input.chunk_limit ?? DEFAULT_READ_CHUNKS,
      })
      .map((page) => ({
        file: {
          file_id: page.file.fileId,
          path: page.file.path,
          content_type: page.file.contentType,
        },
        chunks: page.chunks.map((chunk) => ({
          text: chunk.text,
          heading_path: chunk.headingPath,
          location: chunk.location,
        })),
        ...(page.nextCursor !== undefined
          ? { next_cursor: page.nextCursor }
          : {}),
      }))
      .mapErr(toolError)
  }
}
