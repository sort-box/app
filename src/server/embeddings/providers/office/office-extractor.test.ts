import type { OfficeParserAST } from "officeparser"
import { describe, expect, it } from "vitest"

import {
  inspectOfficeArchive,
  officeAstToBlocks,
} from "./office-extractor.server"

function ast(
  type: OfficeParserAST["type"],
  content: OfficeParserAST["content"]
): OfficeParserAST {
  return { type, content } as OfficeParserAST
}

describe("Office AST extraction", () => {
  it("preserves DOCX headings and paragraph order", () => {
    const blocks = officeAstToBlocks(
      ast("docx", [
        { type: "heading", text: "Results", metadata: { level: 1 } },
        { type: "paragraph", text: "Revenue increased." },
        { type: "table", children: [{ type: "row", text: "Q1 | 10" }] },
      ])
    )

    expect(blocks).toEqual([
      expect.objectContaining({
        kind: "paragraph",
        text: "Revenue increased.",
        headingPath: ["Results"],
      }),
      expect.objectContaining({
        kind: "table",
        text: "Q1 | 10",
        headingPath: ["Results"],
      }),
    ])
  })

  it("preserves PPTX slides and speaker notes", () => {
    const blocks = officeAstToBlocks(
      ast("pptx", [
        {
          type: "slide",
          metadata: { slideNumber: 3 },
          children: [{ type: "paragraph", text: "Launch plan" }],
          notes: [{ type: "note", text: "Discuss the beta." }],
        },
      ])
    )

    expect(blocks.map((block) => block.provenance)).toEqual([
      { kind: "slide", slide: 3 },
      { kind: "slide", slide: 3 },
    ])
    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "note"])
  })

  it("preserves XLSX sheet and row ranges", () => {
    const blocks = officeAstToBlocks(
      ast("xlsx", [
        {
          type: "sheet",
          metadata: { sheetName: "Forecast" },
          children: [
            { type: "row", text: "Month | Revenue" },
            { type: "row", text: "July | 120" },
          ],
        },
      ])
    )

    expect(blocks.map((block) => block.provenance)).toEqual([
      { kind: "sheet", sheet: "Forecast", rowStart: 1, rowEnd: 1 },
      { kind: "sheet", sheet: "Forecast", rowStart: 2, rowEnd: 2 },
    ])
    expect(blocks[0].headingPath).toEqual(["Forecast"])
  })
})

describe("Office archive safety", () => {
  function archive(compressed: number, uncompressed: number): Uint8Array {
    const bytes = new Uint8Array(46 + 22)
    const view = new DataView(bytes.buffer)
    view.setUint32(0, 0x02014b50, true)
    view.setUint32(20, compressed, true)
    view.setUint32(24, uncompressed, true)
    view.setUint32(46, 0x06054b50, true)
    view.setUint16(46 + 10, 1, true)
    view.setUint32(46 + 12, 46, true)
    view.setUint32(46 + 16, 0, true)
    return bytes
  }

  it("accepts bounded archive declarations", () => {
    expect(() => inspectOfficeArchive(archive(100, 1_000))).not.toThrow()
  })

  it("rejects suspicious compression expansion", () => {
    expect(() => inspectOfficeArchive(archive(10_000, 2 * 1024 ** 2))).toThrow(
      "expands beyond"
    )
  })

  it("rejects an archive entry at the 100:1 ratio boundary", () => {
    expect(() => inspectOfficeArchive(archive(10, 1_000))).toThrow(
      "expands beyond"
    )
  })
})
