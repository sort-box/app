import { describe, expect, it } from "vitest"

import { PlainTextDocumentExtractor } from "./plain-text-extractor.server"

function input(bytes: Uint8Array) {
  const body = bytes.slice().buffer as ArrayBuffer
  return {
    body: new Blob([body]).stream(),
    contentType: "text/plain",
    fileName: "notes.txt",
    kind: "text" as const,
    size: bytes.byteLength,
  }
}

describe("plain-text extraction", () => {
  it("streams UTF-8 paragraphs with source offsets", async () => {
    const bytes = new TextEncoder().encode("First paragraph.\n\nSecond one.")
    const result = await new PlainTextDocumentExtractor().extract(input(bytes))

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toEqual([
        {
          kind: "paragraph",
          text: "First paragraph.",
          headingPath: [],
          provenance: { kind: "text", start: 0, end: 16 },
        },
        {
          kind: "paragraph",
          text: "Second one.",
          headingPath: [],
          provenance: { kind: "text", start: 18, end: 29 },
        },
      ])
    }
  })

  it("rejects binary and empty text", async () => {
    const binary = await new PlainTextDocumentExtractor().extract(
      input(new Uint8Array([65, 0, 66]))
    )
    expect(binary.isErr() && binary.error.code).toBe("EXTRACTION_FAILED")

    const empty = await new PlainTextDocumentExtractor().extract(
      input(new Uint8Array())
    )
    expect(empty.isErr() && empty.error.code).toBe("NO_TEXT")
  })
})
