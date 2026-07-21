import { describe, expect, it } from "vitest"

import {
  fileToolDefinitions,
  findExactReferencesInputSchema,
  listFilesInputSchema,
  readFileInputSchema,
  searchFilesInputSchema,
} from "./file-tools"

describe("file tool definitions", () => {
  it("publishes the file tools", () => {
    expect(fileToolDefinitions.map((tool) => tool.name)).toEqual([
      "list_files",
      "search_files",
      "find_exact_references",
      "read_file",
      "propose_file_organization",
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

  it("requires content evidence for ambiguous organization decisions", () => {
    const list = fileToolDefinitions.find((tool) => tool.name === "list_files")
    const read = fileToolDefinitions.find((tool) => tool.name === "read_file")
    const propose = fileToolDefinitions.find(
      (tool) => tool.name === "propose_file_organization"
    )

    expect(read?.description).toContain(
      "always call this if there is any doubt"
    )
    expect(propose?.description).toContain("Read ambiguous files")
    expect(propose?.description).toContain("leave it unmoved")
    expect(list?.description).toContain(
      "unavailable means the contents cannot currently be searched or read"
    )
    expect(propose?.description).toContain(
      "does not prevent moving or renaming"
    )
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

  it("preserves literal exact queries and rejects model-controlled limits", () => {
    expect(
      findExactReferencesInputSchema.safeParse({
        query: "momentum",
        case_sensitive: true,
      }).success
    ).toBe(true)
    expect(
      findExactReferencesInputSchema.safeParse({ query: " " }).success
    ).toBe(true)
    expect(
      findExactReferencesInputSchema.safeParse({ query: "momentum", limit: 1 })
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
