import { describe, expect, it } from "vitest"

import { PdfDocumentExtractor } from "./pdf-extractor.server"

function pdf(content: string): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let source = "%PDF-1.4\n"
  const offsets = [0]
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(source.length)
    source += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xref = source.length
  source += `xref\n0 ${objects.length + 1}\n`
  source += "0000000000 65535 f \n"
  source += offsets
    .slice(1)
    .map((offset) => `${offset.toString().padStart(10, "0")} 00000 n \n`)
    .join("")
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
  source += `startxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(source)
}

function input(bytes: Uint8Array) {
  const body = bytes.slice().buffer as ArrayBuffer
  return {
    body: new Blob([body]).stream(),
    contentType: "application/pdf",
    fileName: "fixture.pdf",
    kind: "pdf" as const,
    size: bytes.byteLength,
  }
}

describe("PDF extraction", () => {
  it("extracts text with page provenance", async () => {
    const bytes = pdf("BT /F1 12 Tf 72 720 Td (Hello PDF) Tj ET")
    const result = await new PdfDocumentExtractor().extract(input(bytes))

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toEqual([
        {
          kind: "paragraph",
          text: "Hello PDF",
          headingPath: [],
          provenance: { kind: "page", page: 1 },
        },
      ])
    }
  })

  it("marks a PDF without a text layer as OCR-required", async () => {
    const bytes = pdf("q Q")
    const result = await new PdfDocumentExtractor().extract(input(bytes))

    expect(result.isErr() && result.error.code).toBe("OCR_REQUIRED")
  })

  it("maps corrupt PDF data to a safe extraction error", async () => {
    const bytes = new TextEncoder().encode("not a pdf")
    const result = await new PdfDocumentExtractor().extract(input(bytes))

    expect(result.isErr() && result.error.code).toBe("EXTRACTION_FAILED")
  })
})
