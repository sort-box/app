import { describe, expect, it } from "vitest"

import { fileChunkSource } from "./file-chunk-metadata"

describe("fileChunkSource", () => {
  it("maps stored provenance and heading path to a tool source", () => {
    expect(
      fileChunkSource({
        headingPath: ["Financials", "Q2"],
        provenance: { kind: "sheet", sheet: "Revenue", rowStart: 3, rowEnd: 9 },
      })
    ).toEqual({
      headingPath: ["Financials", "Q2"],
      location: { kind: "sheet", sheet: "Revenue", row_start: 3, row_end: 9 },
    })
    expect(fileChunkSource({ provenance: { kind: "page", page: 4 } })).toEqual({
      headingPath: [],
      location: { kind: "page", page: 4 },
    })
    expect(
      fileChunkSource({ provenance: { kind: "text", start: 10, end: 90 } })
    ).toEqual({
      headingPath: [],
      location: { kind: "text", start: 10, end: 90 },
    })
  })

  it("degrades malformed metadata to an empty text location", () => {
    expect(fileChunkSource(undefined)).toEqual({
      headingPath: [],
      location: { kind: "text", start: 0, end: 0 },
    })
    expect(fileChunkSource({ provenance: { kind: "page" } })).toEqual({
      headingPath: [],
      location: { kind: "text", start: 0, end: 0 },
    })
    expect(
      fileChunkSource({
        headingPath: ["ok", 7],
        provenance: { kind: "slide", slide: 2 },
      })
    ).toEqual({
      headingPath: ["ok"],
      location: { kind: "slide", slide: 2 },
    })
  })
})
