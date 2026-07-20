import {
  OfficeErrorType,
  OfficeParser,
  type OfficeContentNode,
  type OfficeParserAST,
  type SupportedFileType,
} from "officeparser"
import { ResultAsync } from "neverthrow"

import type {
  DocumentExtractionError,
  DocumentExtractionInput,
  DocumentExtractorPort,
  DocumentProvenance,
  ExtractedBlock,
  ExtractedBlockKind,
} from "../../document-extractor"
import {
  ExtractionFailure,
  readDocumentBytes,
} from "../../read-document-body.server"

const MAX_OFFICE_UNCOMPRESSED_BYTES = 300 * 1024 ** 2
const MAX_OFFICE_COMPRESSION_RATIO = 100
const MAX_OFFICE_ENTRIES = 10_000
const MAX_OFFICE_TABLE_CELLS = 250_000

function mapError(error: unknown): DocumentExtractionError {
  if (error instanceof ExtractionFailure) return error.extractionError
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : ""
  const message = error instanceof Error ? error.message : ""
  if (/password|encrypted/iu.test(message)) {
    return {
      code: "ENCRYPTED",
      message: "Encrypted Office documents cannot be indexed.",
    }
  }
  if (
    code === OfficeErrorType.ZIP_ENTRY_COUNT_LIMIT_EXCEEDED ||
    code === OfficeErrorType.ZIP_SIZE_LIMIT_EXCEEDED ||
    code === OfficeErrorType.MAX_NESTING_DEPTH_EXCEEDED
  ) {
    return {
      code: "TOO_LARGE",
      message: "The Office document exceeds a safe extraction limit.",
    }
  }
  return {
    code: "EXTRACTION_FAILED",
    message: "The Office document could not be parsed.",
  }
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimum = Math.max(0, bytes.byteLength - 65_557)
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (
      bytes[offset] === 0x50 &&
      bytes[offset + 1] === 0x4b &&
      bytes[offset + 2] === 0x05 &&
      bytes[offset + 3] === 0x06
    ) {
      return offset
    }
  }
  return -1
}

export function inspectOfficeArchive(bytes: Uint8Array): void {
  const endOffset = findEndOfCentralDirectory(bytes)
  if (endOffset < 0) {
    throw new ExtractionFailure({
      code: "EXTRACTION_FAILED",
      message: "The Office document is not a valid OOXML archive.",
    })
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const entries = view.getUint16(endOffset + 10, true)
  const directoryOffset = view.getUint32(endOffset + 16, true)
  if (entries === 0xffff || directoryOffset === 0xffffffff) {
    throw new ExtractionFailure({
      code: "TOO_LARGE",
      message: "ZIP64 Office documents are not accepted for ingestion.",
    })
  }
  if (entries > MAX_OFFICE_ENTRIES) {
    throw new ExtractionFailure({
      code: "TOO_LARGE",
      message: "The Office document contains too many archive entries.",
    })
  }

  let offset = directoryOffset
  let totalUncompressed = 0
  for (let entry = 0; entry < entries; entry += 1) {
    if (
      offset + 46 > bytes.byteLength ||
      view.getUint32(offset, true) !== 0x02014b50
    ) {
      throw new ExtractionFailure({
        code: "EXTRACTION_FAILED",
        message: "The Office archive directory is malformed.",
      })
    }
    const flags = view.getUint16(offset + 8, true)
    if ((flags & 0x1) !== 0) {
      throw new ExtractionFailure({
        code: "ENCRYPTED",
        message: "Encrypted Office documents cannot be indexed.",
      })
    }
    const compressed = view.getUint32(offset + 20, true)
    const uncompressed = view.getUint32(offset + 24, true)
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) {
      throw new ExtractionFailure({
        code: "TOO_LARGE",
        message: "ZIP64 Office entries are not accepted for ingestion.",
      })
    }
    totalUncompressed += uncompressed
    if (
      totalUncompressed >= MAX_OFFICE_UNCOMPRESSED_BYTES ||
      (uncompressed > 0 &&
        uncompressed >= Math.max(1, compressed) * MAX_OFFICE_COMPRESSION_RATIO)
    ) {
      throw new ExtractionFailure({
        code: "TOO_LARGE",
        message: "The Office archive expands beyond a safe ingestion limit.",
      })
    }
    const fileNameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    offset += 46 + fileNameLength + extraLength + commentLength
  }
}

function nodeText(node: OfficeContentNode): string {
  if (node.text?.trim()) return node.text.replace(/\s+/gu, " ").trim()
  return (
    node.children
      ?.map(nodeText)
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/gu, " ")
      .trim() ?? ""
  )
}

type TraversalState = {
  headings: string[]
  offset: number
  provenance?: DocumentProvenance
  sheetRow: number
}

function blockKind(node: OfficeContentNode): ExtractedBlockKind {
  if (node.type === "list") return "list"
  if (node.type === "table" || node.type === "row") return "table"
  if (node.type === "note") return "note"
  if (node.type === "code") return "code"
  return "paragraph"
}

function appendBlock(
  blocks: ExtractedBlock[],
  node: OfficeContentNode,
  state: TraversalState,
  override?: DocumentProvenance
) {
  const text = nodeText(node)
  if (!text) return
  const provenance = override ??
    state.provenance ?? {
      kind: "text" as const,
      start: state.offset,
      end: state.offset + text.length,
    }
  blocks.push({
    kind: blockKind(node),
    text,
    headingPath: [...state.headings],
    provenance,
  })
  state.offset += text.length + 1
}

function walkNodes(
  nodes: readonly OfficeContentNode[],
  blocks: ExtractedBlock[],
  state: TraversalState
) {
  for (const node of nodes) {
    if (node.type === "heading") {
      const text = nodeText(node)
      if (text) {
        const level = Math.max(1, node.metadata?.level ?? 1)
        state.headings = [...state.headings.slice(0, level - 1), text]
      }
      continue
    }
    if (node.type === "page") {
      walkNodes(node.children ?? [], blocks, {
        ...state,
        headings: [...state.headings],
        provenance: {
          kind: "page",
          page: node.metadata?.pageNumber ?? 1,
        },
      })
      continue
    }
    if (node.type === "slide") {
      const slide = node.metadata?.slideNumber ?? 1
      const slideState: TraversalState = {
        ...state,
        headings: [],
        provenance: { kind: "slide", slide },
      }
      walkNodes(node.children ?? [], blocks, slideState)
      for (const note of node.notes ?? []) {
        appendBlock(blocks, note, slideState)
      }
      state.offset = slideState.offset
      continue
    }
    if (node.type === "sheet") {
      const sheet = node.metadata?.sheetName ?? "Sheet"
      const sheetState: TraversalState = {
        ...state,
        headings: [sheet],
        provenance: undefined,
        sheetRow: 0,
      }
      for (const child of node.children ?? []) {
        if (child.type === "row") {
          sheetState.sheetRow += 1
          appendBlock(blocks, child, sheetState, {
            kind: "sheet",
            sheet,
            rowStart: sheetState.sheetRow,
            rowEnd: sheetState.sheetRow,
          })
        } else {
          walkNodes([child], blocks, sheetState)
        }
      }
      state.offset = sheetState.offset
      continue
    }
    if (node.type === "table") {
      const rows = node.children?.filter((child) => child.type === "row") ?? []
      if (rows.length > 0) {
        for (const row of rows) appendBlock(blocks, row, state)
      } else {
        appendBlock(blocks, node, state)
      }
      continue
    }
    if (
      node.type === "paragraph" ||
      node.type === "list" ||
      node.type === "note" ||
      node.type === "code" ||
      node.type === "chart"
    ) {
      appendBlock(blocks, node, state)
      for (const note of node.notes ?? []) appendBlock(blocks, note, state)
      continue
    }
    if (node.children?.length) walkNodes(node.children, blocks, state)
  }
}

export function officeAstToBlocks(ast: OfficeParserAST): ExtractedBlock[] {
  const blocks: ExtractedBlock[] = []
  walkNodes(ast.content, blocks, {
    headings: [],
    offset: 0,
    sheetRow: 0,
  })
  return blocks
}

export class OfficeDocumentExtractor implements DocumentExtractorPort {
  extract(input: DocumentExtractionInput) {
    return ResultAsync.fromPromise(
      (async () => {
        const bytes = await readDocumentBytes(input.body, input.size)
        inspectOfficeArchive(bytes)
        const ast = await OfficeParser.parseOffice(bytes, {
          fileType: input.kind as SupportedFileType,
          decompressionLimits: {
            maxUncompressedBytes: MAX_OFFICE_UNCOMPRESSED_BYTES,
            maxZipEntries: MAX_OFFICE_ENTRIES,
            maxTableCells: MAX_OFFICE_TABLE_CELLS,
          },
          extractAttachments: false,
          ignoreComments: true,
          ignoreHeadersAndFooters: true,
          ignoreNotes: false,
          ignoreSlideMasters: true,
          includeRawContent: false,
          ocr: false,
        })
        const blocks = officeAstToBlocks(ast)
        if (blocks.length === 0) {
          throw new ExtractionFailure({
            code: "NO_TEXT",
            message: "The document contains no extractable text.",
          })
        }
        return blocks
      })(),
      mapError
    )
  }
}
