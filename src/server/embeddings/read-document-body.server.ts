import { MAX_EMBEDDING_SOURCE_BYTES } from "./document-types"
import type { DocumentExtractionError } from "./document-extractor"

export class ExtractionFailure extends Error {
  constructor(readonly extractionError: DocumentExtractionError) {
    super(extractionError.message)
  }
}

export async function readDocumentBytes(
  body: ReadableStream<Uint8Array>,
  declaredSize: number
): Promise<Uint8Array> {
  if (
    !Number.isInteger(declaredSize) ||
    declaredSize < 0 ||
    declaredSize > MAX_EMBEDDING_SOURCE_BYTES
  ) {
    throw new ExtractionFailure({
      code: "TOO_LARGE",
      message: "The source document exceeds the ingestion size limit.",
    })
  }

  const chunks: Uint8Array[] = []
  const reader = body.getReader()
  let received = 0
  while (true) {
    const result = await reader.read()
    if (result.done) break
    received += result.value.byteLength
    if (received > declaredSize || received > MAX_EMBEDDING_SOURCE_BYTES) {
      await reader.cancel()
      throw new ExtractionFailure({
        code: "TOO_LARGE",
        message: "The source document exceeds the ingestion size limit.",
      })
    }
    chunks.push(result.value)
  }
  if (received !== declaredSize) {
    throw new ExtractionFailure({
      code: "EXTRACTION_FAILED",
      message: "The downloaded document size does not match its metadata.",
    })
  }

  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
