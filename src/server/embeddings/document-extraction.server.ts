import { errAsync } from "neverthrow"

import type {
  DocumentExtractionInput,
  DocumentExtractorPort,
} from "./document-extractor"
import { OfficeDocumentExtractor } from "./providers/office/office-extractor.server"
import { PdfDocumentExtractor } from "./providers/pdf/pdf-extractor.server"
import { PlainTextDocumentExtractor } from "./providers/plain-text/plain-text-extractor.server"

export class DocumentExtractionService implements DocumentExtractorPort {
  constructor(
    private readonly text = new PlainTextDocumentExtractor(),
    private readonly pdf = new PdfDocumentExtractor(),
    private readonly office = new OfficeDocumentExtractor()
  ) {}

  extract(input: DocumentExtractionInput) {
    switch (input.kind) {
      case "text":
        return this.text.extract(input)
      case "pdf":
        return this.pdf.extract(input)
      case "docx":
      case "pptx":
      case "xlsx":
        return this.office.extract(input)
      default:
        return errAsync({
          code: "UNSUPPORTED_TYPE" as const,
          message: "The document format is not supported for embedding.",
        })
    }
  }
}
