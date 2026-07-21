import type { FileSourceLocation } from "./file-tools"

export type FileChunkSource = {
  headingPath: readonly string[]
  location: FileSourceLocation
}

const FALLBACK_SOURCE: FileChunkSource = {
  headingPath: [],
  location: { kind: "text", start: 0, end: 0 },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function locationFrom(value: unknown): FileSourceLocation | undefined {
  if (!isRecord(value)) return undefined
  if (value.kind === "page" && isCount(value.page)) {
    return { kind: "page", page: value.page }
  }
  if (value.kind === "slide" && isCount(value.slide)) {
    return { kind: "slide", slide: value.slide }
  }
  if (
    value.kind === "sheet" &&
    typeof value.sheet === "string" &&
    isCount(value.rowStart) &&
    isCount(value.rowEnd)
  ) {
    return {
      kind: "sheet",
      sheet: value.sheet,
      row_start: value.rowStart,
      row_end: value.rowEnd,
    }
  }
  if (value.kind === "text" && isCount(value.start) && isCount(value.end)) {
    return { kind: "text", start: value.start, end: value.end }
  }
  return undefined
}

/**
 * Recovers the source location a document chunker stored on a RAG chunk.
 * Unknown or malformed metadata degrades to an empty text location instead of
 * failing the read, because chunk text is still useful without provenance.
 */
export function fileChunkSource(metadata: unknown): FileChunkSource {
  if (!isRecord(metadata)) return FALLBACK_SOURCE
  const location = locationFrom(metadata.provenance)
  if (!location) return FALLBACK_SOURCE
  const headingPath = Array.isArray(metadata.headingPath)
    ? metadata.headingPath.filter(
        (segment): segment is string => typeof segment === "string"
      )
    : []
  return { headingPath, location }
}
