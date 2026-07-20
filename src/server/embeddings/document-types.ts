export const MAX_EMBEDDING_SOURCE_BYTES = 100 * 1024 ** 2
export const MAX_EXTRACTED_CHARACTERS = 5_000_000
export const MAX_DOCUMENT_CHUNKS = 10_000
export const EMBEDDING_CHUNK_WORDS = 100
export const EMBEDDING_DIMENSION = 1_024
export const EMBEDDING_VERSION = "v1:voyage-4-large:1024:passage-100" as const

export type EmbeddableDocumentKind = "text" | "pdf" | "docx" | "pptx" | "xlsx"

const OFFICE_MIME_TYPES: Record<string, EmbeddableDocumentKind> = {
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
}

const EXTENSIONS: Record<string, EmbeddableDocumentKind> = {
  docx: "docx",
  md: "text",
  markdown: "text",
  pdf: "pdf",
  pptx: "pptx",
  text: "text",
  txt: "text",
  xlsx: "xlsx",
}

const UNSUPPORTED_MIME_TYPES = new Set([
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
])

export function documentExtension(fileName: string): string {
  const basename = fileName.split(/[\\/]/).at(-1) ?? ""
  const dot = basename.lastIndexOf(".")
  return dot > 0 ? basename.slice(dot + 1).toLowerCase() : ""
}

export function embeddableDocumentKind(
  fileName: string,
  contentType: string
): EmbeddableDocumentKind | null {
  const normalizedContentType = contentType.split(";")[0].trim().toLowerCase()

  if (normalizedContentType === "application/pdf") return "pdf"
  if (
    normalizedContentType.startsWith("text/") ||
    normalizedContentType === "application/json" ||
    normalizedContentType === "application/xml" ||
    normalizedContentType === "application/x-yaml"
  ) {
    return "text"
  }
  if (OFFICE_MIME_TYPES[normalizedContentType]) {
    return OFFICE_MIME_TYPES[normalizedContentType]
  }
  if (
    normalizedContentType.startsWith("image/") ||
    normalizedContentType.startsWith("audio/") ||
    normalizedContentType.startsWith("video/") ||
    UNSUPPORTED_MIME_TYPES.has(normalizedContentType)
  ) {
    return null
  }
  return EXTENSIONS[documentExtension(fileName)] ?? null
}
