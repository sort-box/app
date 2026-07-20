import { ResultAsync } from "neverthrow"

import {
  MAX_EMBEDDING_SOURCE_BYTES,
  MAX_EXTRACTED_CHARACTERS,
} from "../../document-types"
import type {
  DocumentExtractionError,
  DocumentExtractionInput,
  DocumentExtractorPort,
  ExtractedBlock,
} from "../../document-extractor"
import { ExtractionFailure } from "../../read-document-body.server"

function mapError(error: unknown): DocumentExtractionError {
  return error instanceof ExtractionFailure
    ? error.extractionError
    : {
        code: "EXTRACTION_FAILED",
        message: "The text document could not be decoded.",
      }
}

async function decodeText(input: DocumentExtractionInput): Promise<string> {
  if (input.size > MAX_EMBEDDING_SOURCE_BYTES) {
    throw new ExtractionFailure({
      code: "TOO_LARGE",
      message: "The source document exceeds the ingestion size limit.",
    })
  }

  const reader = input.body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let text = ""
  let received = 0
  while (true) {
    const result = await reader.read()
    if (result.done) break
    received += result.value.byteLength
    if (received > input.size || received > MAX_EMBEDDING_SOURCE_BYTES) {
      await reader.cancel()
      throw new ExtractionFailure({
        code: "TOO_LARGE",
        message: "The source document exceeds the ingestion size limit.",
      })
    }
    text += decoder.decode(result.value, { stream: true })
    if (text.length > MAX_EXTRACTED_CHARACTERS) {
      await reader.cancel()
      throw new ExtractionFailure({
        code: "TOO_LARGE",
        message: "The extracted document text exceeds the ingestion limit.",
      })
    }
  }
  if (received !== input.size) {
    throw new ExtractionFailure({
      code: "EXTRACTION_FAILED",
      message: "The downloaded document size does not match its metadata.",
    })
  }
  text += decoder.decode()
  if (text.includes("\u0000")) {
    throw new ExtractionFailure({
      code: "EXTRACTION_FAILED",
      message: "The text document contains binary data.",
    })
  }
  return text.replace(/\r\n?/gu, "\n")
}

function textBlocks(text: string): ExtractedBlock[] {
  const blocks: ExtractedBlock[] = []
  const paragraphPattern = /\S(?:.*?\S)?(?=\n{2,}|\s*$)/gsu
  for (const match of text.matchAll(paragraphPattern)) {
    const clean = match[0].replace(/\s+/gu, " ").trim()
    if (!clean) continue
    const start = match.index
    blocks.push({
      kind: "paragraph",
      text: clean,
      headingPath: [],
      provenance: { kind: "text", start, end: start + match[0].length },
    })
  }
  return blocks
}

export class PlainTextDocumentExtractor implements DocumentExtractorPort {
  extract(input: DocumentExtractionInput) {
    return ResultAsync.fromPromise(
      decodeText(input).then((text) => {
        const blocks = textBlocks(text)
        if (blocks.length === 0) {
          throw new ExtractionFailure({
            code: "NO_TEXT",
            message: "The document contains no extractable text.",
          })
        }
        return blocks
      }),
      mapError
    )
  }
}
