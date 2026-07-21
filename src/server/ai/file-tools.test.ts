import { describe, expect, it } from "vitest"

import {
  fileToolDefinitions,
  findExactReferencesInputSchema,
  listFilesInputSchema,
  readFileInputSchema,
  searchFilesInputSchema,
} from "./file-tools"

describe("file tool definitions", () => {
  it("publishes the four read-only file tools", () => {
    expect(fileToolDefinitions.map((tool) => tool.name)).toEqual([
      "list_files",
      "search_files",
      "find_exact_references",
      "read_file",
    ])
  })

  it("publishes strict JSON object input schemas", () => {
    for (const tool of fileToolDefinitions) {
      expect(tool.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      })
      expect(tool.inputSchema).not.toHaveProperty("$schema")
    }
  })
})

describe("file tool input validation", () => {
  it("accepts bounded list input and rejects unknown properties", () => {
    expect(
      listFilesInputSchema.safeParse({ path: "/reports", limit: 100 }).success
    ).toBe(true)
    expect(
      listFilesInputSchema.safeParse({ path: "/", recursive: true }).success
    ).toBe(false)
  })

  it("requires a non-blank semantic search query", () => {
    expect(searchFilesInputSchema.safeParse({ query: "revenue" }).success).toBe(
      true
    )
    expect(searchFilesInputSchema.safeParse({ query: " " }).success).toBe(false)
  })

  it("requires a non-blank exact query and bounds its result page", () => {
    expect(
      findExactReferencesInputSchema.safeParse({
        query: "momentum",
        case_sensitive: true,
        limit: 50,
      }).success
    ).toBe(true)
    expect(
      findExactReferencesInputSchema.safeParse({ query: " ", limit: 50 })
        .success
    ).toBe(false)
    expect(
      findExactReferencesInputSchema.safeParse({ query: "momentum", limit: 51 })
        .success
    ).toBe(false)
  })

  it("requires a file id and bounds read pagination", () => {
    expect(
      readFileInputSchema.safeParse({ file_id: "file-id", chunk_limit: 20 })
        .success
    ).toBe(true)
    expect(
      readFileInputSchema.safeParse({ file_id: "file-id", chunk_limit: 21 })
        .success
    ).toBe(false)
  })
})
