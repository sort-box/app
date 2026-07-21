import type { ResultAsync } from "neverthrow"
import { z } from "zod"

import type { AiToolDefinition, JsonValue } from "./ai-provider"

const MAX_LIST_RESULTS = 100
const MAX_SEARCH_RESULTS = 10
const MAX_EXACT_SEARCH_RESULTS = 50
const MAX_READ_CHUNKS = 20

export const listFilesInputSchema = z
  .object({
    path: z.string().min(1).optional(),
    cursor: z.string().min(1).nullable().optional(),
    limit: z.number().int().min(1).max(MAX_LIST_RESULTS).optional(),
  })
  .strict()

export const searchFilesInputSchema = z
  .object({
    query: z.string().trim().min(1).max(1_000),
    limit: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional(),
  })
  .strict()

export const findExactReferencesInputSchema = z
  .object({
    query: z.string().trim().min(1).max(1_000),
    case_sensitive: z.boolean().optional(),
    cursor: z.string().min(1).nullable().optional(),
    limit: z.number().int().min(1).max(MAX_EXACT_SEARCH_RESULTS).optional(),
  })
  .strict()

export const readFileInputSchema = z
  .object({
    file_id: z.string().min(1),
    cursor: z.string().min(1).nullable().optional(),
    chunk_limit: z.number().int().min(1).max(MAX_READ_CHUNKS).optional(),
  })
  .strict()

export type ListFilesInput = z.infer<typeof listFilesInputSchema>
export type SearchFilesInput = z.infer<typeof searchFilesInputSchema>
export type FindExactReferencesInput = z.infer<
  typeof findExactReferencesInputSchema
>
export type ReadFileInput = z.infer<typeof readFileInputSchema>

export type FileSourceLocation =
  | { kind: "page"; page: number }
  | { kind: "slide"; slide: number }
  | {
      kind: "sheet"
      sheet: string
      row_start: number
      row_end: number
    }
  | { kind: "text"; start: number; end: number }

export type FileIndexStatus = "ready" | "indexing" | "unavailable"

export type ListFilesOutput = {
  entries: readonly {
    file_id?: string
    path: string
    kind: "file" | "directory"
    content_type?: string
    size?: number
    index_status?: FileIndexStatus
  }[]
  next_cursor?: string
}

export type SearchFilesOutput = {
  matches: readonly {
    file_id: string
    path: string
    excerpt: string
    heading_path: readonly string[]
    location: FileSourceLocation
  }[]
  incomplete: boolean
  warnings?: readonly ("RERANK_UNAVAILABLE" | "FILES_STILL_INDEXING")[]
}

export type FindExactReferencesOutput = {
  matches: readonly {
    file_id: string
    path: string
    occurrence_count: number
    locations: readonly FileSourceLocation[]
  }[]
  scanned_indexed_files: number
  total_ready_files: number
  unsearchable_ready_files: number
  complete: boolean
  next_cursor?: string
}

export type ReadFileOutput = {
  file: {
    file_id: string
    path: string
    content_type: string
  }
  chunks: readonly {
    text: string
    heading_path: readonly string[]
    location: FileSourceLocation
  }[]
  next_cursor?: string
}

export type FileToolError = {
  code:
    | "INVALID_INPUT"
    | "NOT_AUTHENTICATED"
    | "FILE_NOT_FOUND"
    | "CONTENT_NOT_INDEXED"
    | "RATE_LIMITED"
    | "UNAVAILABLE"
  message: string
  retryable: boolean
}

/**
 * Application-owned execution contract for the file tools.
 * Authentication and provider adapters are supplied by the composition root.
 */
export interface FileToolExecutor {
  listFiles: (
    input: ListFilesInput
  ) => ResultAsync<ListFilesOutput, FileToolError>
  searchFiles: (
    input: SearchFilesInput
  ) => ResultAsync<SearchFilesOutput, FileToolError>
  findExactReferences: (
    input: FindExactReferencesInput
  ) => ResultAsync<FindExactReferencesOutput, FileToolError>
  readFile: (input: ReadFileInput) => ResultAsync<ReadFileOutput, FileToolError>
}

function inputSchema(schema: z.ZodType): Record<string, JsonValue> {
  const { $schema: _, ...jsonSchema } = z.toJSONSchema(schema)
  return jsonSchema as Record<string, JsonValue>
}

export const listFilesTool = {
  name: "list_files",
  description:
    "Browse the user's file tree. Use this to discover file names and paths; it does not search file contents. Returns a paginated list of files and directories.",
  inputSchema: inputSchema(listFilesInputSchema),
} satisfies AiToolDefinition

export const searchFilesTool = {
  name: "search_files",
  description:
    "Semantically search the user's indexed file contents. The server performs query embedding, candidate retrieval, and reranking. Returns ranked excerpts with file paths and source locations, not complete files.",
  inputSchema: inputSchema(searchFilesInputSchema),
} satisfies AiToolDefinition

export const findExactReferencesTool = {
  name: "find_exact_references",
  description:
    "Find literal occurrences across the user's indexed files. Use this instead of semantic search for requests such as 'find all files containing X' or 'is X in my CV'. Returns one deduplicated match per file, occurrence counts, source locations, pagination, and corpus coverage. Continue with next_cursor until complete. Never describe the result as covering all stored files when unsearchable_ready_files is greater than zero.",
  inputSchema: inputSchema(findExactReferencesInputSchema),
} satisfies AiToolDefinition

export const readFileTool = {
  name: "read_file",
  description:
    "Read a page of normalized, extracted text from one user-owned file. Use the file_id returned by list_files or search_files. If only a listed path is available, file_id may also be that exact path. Returns source-located chunks and an optional continuation cursor, never raw file bytes or download URLs.",
  inputSchema: inputSchema(readFileInputSchema),
} satisfies AiToolDefinition

export const fileToolDefinitions = [
  listFilesTool,
  searchFilesTool,
  findExactReferencesTool,
  readFileTool,
] as const satisfies readonly AiToolDefinition[]
