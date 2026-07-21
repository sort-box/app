import type { ResultAsync } from "neverthrow"
import { z } from "zod"

import type { AiToolDefinition, JsonValue } from "./ai-provider"

const MAX_LIST_RESULTS = 100
const MAX_SEARCH_RESULTS = 10
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
    query: z.string().min(1).max(1_000),
    case_sensitive: z.boolean().optional(),
    cursor: z.string().min(1).nullable().optional(),
  })
  .strict()

export const readFileInputSchema = z
  .object({
    file_id: z.string().min(1),
    cursor: z.string().min(1).nullable().optional(),
    chunk_limit: z.number().int().min(1).max(MAX_READ_CHUNKS).optional(),
  })
  .strict()

export const proposeFileOrganizationInputSchema = z
  .object({
    summary: z.string().trim().min(1).max(2_000),
    warnings: z.array(z.string().max(500)).max(20).optional(),
    unchanged_paths: z.array(z.string().min(1)).max(1_000).optional(),
    unresolved_paths: z.array(z.string().min(1)).max(1_000).optional(),
    previous_plan_id: z.string().min(1).optional(),
    operations: z
      .array(
        z
          .object({
            before_path: z.string().min(1),
            after_path: z.string().min(1),
          })
          .strict()
      )
      .min(1)
      .max(1_000),
  })
  .strict()

export type ListFilesInput = z.infer<typeof listFilesInputSchema>
export type SearchFilesInput = z.infer<typeof searchFilesInputSchema>
export type FindExactReferencesInput = z.infer<
  typeof findExactReferencesInputSchema
>
export type ReadFileInput = z.infer<typeof readFileInputSchema>
export type ProposeFileOrganizationInput = z.infer<
  typeof proposeFileOrganizationInputSchema
>

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
    omitted_location_count: number
  }[]
  scanned_ready_files: number
  scanned_indexed_files: number
  unsearchable_ready_files: number
  complete: boolean
  next_cursor?: string
  warnings?: readonly ("LOCATIONS_TRUNCATED" | "CORPUS_CHANGED")[]
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
    | "PLAN_NOT_APPLICABLE"
    | "PLAN_STALE"
    | "PATH_CONFLICT"
    | "SCOPE_TOO_LARGE"
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
  proposeFileOrganization: (
    input: ProposeFileOrganizationInput,
    conversationId: string
  ) => ResultAsync<{ plan_id: string; revision: number }, FileToolError>
}

function inputSchema(schema: z.ZodType): Record<string, JsonValue> {
  const { $schema: _, ...jsonSchema } = z.toJSONSchema(schema)
  return jsonSchema as Record<string, JsonValue>
}

export const listFilesTool = {
  name: "list_files",
  description:
    "Browse the user's file tree without asking for separate permission. Use this whenever a request concerns stored files or implies organizing them. It discovers names and paths, not contents, and returns paginated files and directories. index_status describes extracted-content indexing only: unavailable means the contents cannot currently be searched or read, not that the file is inaccessible. A listed ready file may still be moved or renamed. Follow next_cursor until the relevant scope is complete before proposing a reorganization.",
  inputSchema: inputSchema(listFilesInputSchema),
} satisfies AiToolDefinition

export const searchFilesTool = {
  name: "search_files",
  description:
    "Semantically search the user's indexed file contents. During organization, use this whenever names or current locations do not unambiguously prove a file's purpose, then use read_file for decisive evidence. The server performs query embedding, candidate retrieval, and reranking. Returns ranked excerpts with file paths and source locations, not complete files.",
  inputSchema: inputSchema(searchFilesInputSchema),
} satisfies AiToolDefinition

export const findExactReferencesTool = {
  name: "find_exact_references",
  description:
    "Find literal occurrences across the user's indexed files. Use this instead of semantic search for requests such as 'find all files containing X' or 'is X in my CV'. Returns exact per-file occurrence counts, representative source locations, omitted-location counts, resumable pagination, and cumulative corpus coverage. Continue with next_cursor until complete. Never claim exhaustive coverage when unsearchable_ready_files is greater than zero or warnings are present.",
  inputSchema: inputSchema(findExactReferencesInputSchema),
} satisfies AiToolDefinition

export const readFileTool = {
  name: "read_file",
  description:
    "Read a page of normalized, extracted text from one user-owned file. When organizing files, always call this if there is any doubt about an item's purpose; never trust its current folder or filename alone. Continue with next_cursor if the first page is inconclusive. Use the file_id returned by list_files or search_files. If only a listed path is available, file_id may also be that exact path. Returns source-located chunks and an optional continuation cursor, never raw file bytes or download URLs.",
  inputSchema: inputSchema(readFileInputSchema),
} satisfies AiToolDefinition

export const proposeFileOrganizationTool = {
  name: "propose_file_organization",
  description:
    "Create one complete, reviewable file organization proposal when the user explicitly or implicitly wants cleanup, sorting, renaming, or a clearer structure. This never changes files, so do not ask for permission before calling it. Browse the complete relevant tree first. Account for every discovered file exactly once: include a move/rename operation, list it in unchanged_paths when its current path is already correct, or list it in unresolved_paths with a warning when evidence is unavailable. A proposal that silently omits discovered files is invalid. Current locations may be wrong and filenames are not sufficient evidence when there is any doubt. Read ambiguous files before assigning destinations. If content cannot resolve an item, leave it unmoved and add a warning instead of guessing—unless the user explicitly supplies the destination or other decisive classification context. Content index_status unavailable does not prevent moving or renaming a listed file. Submit only evidence-backed or explicitly user-directed moves and renames. Do not split a complete plan into arbitrary small proposals to work around an error; correct the reported validation issue and retry the full plan. Omit previous_plan_id for every initial proposal. For a user-requested revision, copy only the exact opaque proposal ID supplied by the application. Never invent IDs such as 'init', 'new', or 'plan_001'.",
  inputSchema: inputSchema(proposeFileOrganizationInputSchema),
} satisfies AiToolDefinition

export const fileToolDefinitions = [
  listFilesTool,
  searchFilesTool,
  findExactReferencesTool,
  readFileTool,
  proposeFileOrganizationTool,
] as const satisfies readonly AiToolDefinition[]
