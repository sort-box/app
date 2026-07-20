import { ResultAsync } from "neverthrow"

import type {
  DocumentExtractionError,
  DocumentExtractionInput,
  DocumentExtractorPort,
  ExtractedBlock,
} from "../../document-extractor"
import {
  ExtractionFailure,
  readDocumentBytes,
} from "../../read-document-body.server"

function mapError(error: unknown): DocumentExtractionError {
  if (error instanceof ExtractionFailure) return error.extractionError
  console.error("PDF extraction failed.", error)
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String(error.name)
      : ""
  if (name === "PasswordException") {
    return {
      code: "ENCRYPTED",
      message: "Encrypted PDF documents cannot be indexed.",
    }
  }
  return {
    code: "EXTRACTION_FAILED",
    message: "The PDF document could not be parsed.",
  }
}

function textItem(value: unknown): string {
  return typeof value === "object" &&
    value !== null &&
    "str" in value &&
    typeof value.str === "string"
    ? value.str
    : ""
}

function endsLine(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "hasEOL" in value &&
    value.hasEOL === true
  )
}

export class PdfDocumentExtractor implements DocumentExtractorPort {
  extract(input: DocumentExtractionInput) {
    return ResultAsync.fromPromise(
      (async () => {
        const bytes = await readDocumentBytes(input.body, input.size)
        await import("@napi-rs/canvas")
        // @ts-expect-error PDF.js does not publish types for its worker module.
        await import("pdfjs-dist/legacy/build/pdf.worker.mjs")
        const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs")
        const task = getDocument({
          data: bytes,
          stopAtErrors: true,
          verbosity: 0,
        })
        try {
          const pdf = await task.promise
          const blocks: ExtractedBlock[] = []
          for (
            let pageNumber = 1;
            pageNumber <= pdf.numPages;
            pageNumber += 1
          ) {
            const page = await pdf.getPage(pageNumber)
            const content = await page.getTextContent()
            const parts: string[] = []
            for (const item of content.items) {
              const text = textItem(item)
              if (text) parts.push(text)
              if (endsLine(item)) parts.push("\n")
            }
            const text = parts
              .join(" ")
              .replace(/[ \t]*\n[ \t]*/gu, "\n")
              .replace(/[ \t]+/gu, " ")
              .trim()
            if (text) {
              blocks.push({
                kind: "paragraph",
                text,
                headingPath: [],
                provenance: { kind: "page", page: pageNumber },
              })
            }
            page.cleanup()
          }
          if (blocks.length === 0) {
            throw new ExtractionFailure({
              code: "OCR_REQUIRED",
              message: "The PDF has no extractable text layer.",
            })
          }
          return blocks
        } finally {
          await task.destroy()
        }
      })(),
      mapError
    )
  }
}
