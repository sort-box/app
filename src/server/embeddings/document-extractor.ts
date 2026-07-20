import type { ResultAsync } from "neverthrow"

import type { EmbeddableDocumentKind } from "./document-types"

export type DocumentProvenance =
  | { kind: "page"; page: number }
  | { kind: "slide"; slide: number }
  | { kind: "sheet"; sheet: string; rowStart: number; rowEnd: number }
  | { kind: "text"; start: number; end: number }

export type ExtractedBlockKind =
  "paragraph" | "list" | "table" | "note" | "code"

export type ExtractedBlock = {
  kind: ExtractedBlockKind
  text: string
  headingPath: readonly string[]
  provenance: DocumentProvenance
}

export type DocumentExtractionError = {
  code:
    | "UNSUPPORTED_TYPE"
    | "OCR_REQUIRED"
    | "TOO_LARGE"
    | "NO_TEXT"
    | "ENCRYPTED"
    | "EXTRACTION_FAILED"
  message: string
}

export type DocumentExtractionInput = {
  body: ReadableStream<Uint8Array>
  contentType: string
  fileName: string
  kind: EmbeddableDocumentKind
  size: number
}

export interface DocumentExtractorPort {
  extract: (
    input: DocumentExtractionInput
  ) => ResultAsync<readonly ExtractedBlock[], DocumentExtractionError>
}
