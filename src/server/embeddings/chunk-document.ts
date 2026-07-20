import {
  EMBEDDING_CHUNK_WORDS,
  MAX_DOCUMENT_CHUNKS,
  MAX_EXTRACTED_CHARACTERS,
} from "./document-types"
import type {
  DocumentExtractionError,
  DocumentProvenance,
  ExtractedBlock,
} from "./document-extractor"

export type DocumentChunk = {
  text: string
  embeddingText: string
  order: number
  headingPath: readonly string[]
  provenance: DocumentProvenance
}

type PendingChunk = Omit<DocumentChunk, "embeddingText" | "order">

function words(text: string): string[] {
  return text.trim().split(/\s+/u).filter(Boolean)
}

function boundaryKey(block: ExtractedBlock): string {
  const provenance = block.provenance
  switch (provenance.kind) {
    case "page":
      return `page:${provenance.page}`
    case "slide":
      return `slide:${provenance.slide}`
    case "sheet":
      return `sheet:${provenance.sheet}`
    case "text":
      return `text:${block.headingPath.join("\u001f")}`
  }
}

function mergeProvenance(
  current: DocumentProvenance,
  next: DocumentProvenance
): DocumentProvenance {
  if (current.kind !== next.kind) return current
  switch (current.kind) {
    case "page":
    case "slide":
      return current
    case "sheet":
      return next.kind === "sheet" && current.sheet === next.sheet
        ? {
            kind: "sheet",
            sheet: current.sheet,
            rowStart: Math.min(current.rowStart, next.rowStart),
            rowEnd: Math.max(current.rowEnd, next.rowEnd),
          }
        : current
    case "text":
      return next.kind === "text"
        ? {
            kind: "text",
            start: Math.min(current.start, next.start),
            end: Math.max(current.end, next.end),
          }
        : current
  }
}

function embeddingText(chunk: PendingChunk): string {
  return chunk.headingPath.length === 0
    ? chunk.text
    : `${chunk.headingPath.join(" > ")}\n\n${chunk.text}`
}

export function chunkExtractedBlocks(
  blocks: readonly ExtractedBlock[]
):
  | { ok: true; chunks: readonly DocumentChunk[] }
  | { ok: false; error: DocumentExtractionError } {
  const characterCount = blocks.reduce(
    (total, block) => total + block.text.length,
    0
  )
  if (characterCount > MAX_EXTRACTED_CHARACTERS) {
    return {
      ok: false,
      error: {
        code: "TOO_LARGE",
        message: "The extracted document text exceeds the ingestion limit.",
      },
    }
  }

  const chunks: DocumentChunk[] = []
  let overflow = false
  let pending: PendingChunk | undefined
  let pendingBoundary: string | undefined

  const flush = () => {
    if (!pending) return
    chunks.push({
      ...pending,
      embeddingText: embeddingText(pending),
      order: chunks.length,
    })
    overflow ||= chunks.length > MAX_DOCUMENT_CHUNKS
    pending = undefined
    pendingBoundary = undefined
  }

  for (const block of blocks) {
    const blockWords = words(block.text)
    let offset = 0
    while (offset < blockWords.length) {
      const key = boundaryKey(block)
      const sameBoundary =
        pending !== undefined &&
        pendingBoundary === key &&
        pending.headingPath.join("\u001f") === block.headingPath.join("\u001f")
      if (!sameBoundary) flush()
      if (overflow) {
        return {
          ok: false,
          error: {
            code: "TOO_LARGE",
            message: "The document produces too many embedding passages.",
          },
        }
      }

      const pendingWords = pending ? words(pending.text).length : 0
      const capacity = EMBEDDING_CHUNK_WORDS - pendingWords
      const take = Math.min(capacity, blockWords.length - offset)
      const text = blockWords.slice(offset, offset + take).join(" ")
      if (pending) {
        pending = {
          ...pending,
          text: `${pending.text} ${text}`,
          provenance: mergeProvenance(pending.provenance, block.provenance),
        }
      } else {
        pending = {
          text,
          headingPath: block.headingPath,
          provenance: block.provenance,
        }
        pendingBoundary = key
      }
      offset += take
      if (words(pending.text).length === EMBEDDING_CHUNK_WORDS) flush()
      if (chunks.length > MAX_DOCUMENT_CHUNKS) {
        return {
          ok: false,
          error: {
            code: "TOO_LARGE",
            message: "The document produces too many embedding passages.",
          },
        }
      }
    }
  }
  flush()

  if (overflow) {
    return {
      ok: false,
      error: {
        code: "TOO_LARGE",
        message: "The document produces too many embedding passages.",
      },
    }
  }
  if (chunks.length === 0) {
    return {
      ok: false,
      error: {
        code: "NO_TEXT",
        message: "The document contains no extractable text.",
      },
    }
  }
  return { ok: true, chunks }
}
