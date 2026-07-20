import { describe, expect, it } from "vitest"

import { chunkExtractedBlocks } from "./chunk-document"
import type { ExtractedBlock } from "./document-extractor"

function block(
  text: string,
  input: Partial<ExtractedBlock> = {}
): ExtractedBlock {
  return {
    kind: "paragraph",
    headingPath: [],
    provenance: { kind: "page", page: 1 },
    text,
    ...input,
  }
}

describe("document chunking", () => {
  it("creates non-overlapping passages of at most 100 words", () => {
    const input = Array.from({ length: 205 }, (_, index) => `word-${index}`)
    const result = chunkExtractedBlocks([block(input.join(" "))])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.chunks.map((chunk) => chunk.text.split(" ").length)).toEqual([
      100, 100, 5,
    ])
    expect(result.chunks.flatMap((chunk) => chunk.text.split(" "))).toEqual(
      input
    )
    expect(result.chunks.map((chunk) => chunk.order)).toEqual([0, 1, 2])
  })

  it("does not combine passages across structural boundaries", () => {
    const result = chunkExtractedBlocks([
      block("first page", { provenance: { kind: "page", page: 1 } }),
      block("second page", { provenance: { kind: "page", page: 2 } }),
    ])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.chunks).toHaveLength(2)
    expect(result.chunks.map((chunk) => chunk.provenance)).toEqual([
      { kind: "page", page: 1 },
      { kind: "page", page: 2 },
    ])
  })

  it("embeds heading context without changing clean passage text", () => {
    const result = chunkExtractedBlocks([
      block("Quarterly revenue increased.", {
        headingPath: ["Financials", "Revenue"],
      }),
    ])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.chunks[0]).toMatchObject({
      text: "Quarterly revenue increased.",
      embeddingText: "Financials > Revenue\n\nQuarterly revenue increased.",
    })
  })

  it("rejects empty and over-limit extracted content", () => {
    expect(chunkExtractedBlocks([])).toMatchObject({
      ok: false,
      error: { code: "NO_TEXT" },
    })
    expect(chunkExtractedBlocks([block("a".repeat(5_000_001))])).toMatchObject({
      ok: false,
      error: { code: "TOO_LARGE" },
    })
  })
})
