import { describe, expect, it } from "vitest"

import { parseDirectoryPath, parseFilePath } from "./file-api.server"

describe("private file paths", () => {
  it("normalizes valid nested paths", () => {
    const result = parseFilePath("/reports/2026/summary.pdf")
    expect(result).toEqual({
      ok: true,
      value: {
        path: "/reports/2026/summary.pdf",
        parentPath: "/reports/2026",
        basename: "summary.pdf",
      },
    })
  })

  it.each([
    "relative.txt",
    "/",
    "/trailing/",
    "/double//segment",
    "/../secret",
    "/./secret",
    "/windows\\secret",
    "/control\u0000name",
  ])("rejects unsafe path %s", (path) => {
    expect(parseFilePath(path).ok).toBe(false)
  })

  it("accepts root and normalized nested directory paths", () => {
    expect(parseDirectoryPath("/")).toEqual({ ok: true, value: "/" })
    expect(parseDirectoryPath("/reports/2026/")).toEqual({
      ok: true,
      value: "/reports/2026",
    })
  })
})
