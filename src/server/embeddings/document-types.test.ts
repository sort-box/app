import { describe, expect, it } from "vitest"

import { embeddableDocumentKind } from "./document-types"

describe("embeddable document type detection", () => {
  it("accepts supported MIME types and octet-stream extensions", () => {
    expect(embeddableDocumentKind("notes.bin", "text/plain")).toBe("text")
    expect(
      embeddableDocumentKind("report.pdf", "application/octet-stream")
    ).toBe("pdf")
    expect(
      embeddableDocumentKind(
        "report.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      )
    ).toBe("docx")
  })

  it("does not disguise media or legacy Office files with an extension", () => {
    expect(embeddableDocumentKind("photo.txt", "image/png")).toBeNull()
    expect(embeddableDocumentKind("recording.txt", "audio/mpeg")).toBeNull()
    expect(
      embeddableDocumentKind("legacy.docx", "application/msword")
    ).toBeNull()
  })
})
