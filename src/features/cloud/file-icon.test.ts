import { existsSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { fileIconName, iconByExtension } from "./file-icon"

describe("fileIconName", () => {
  it("maps known extensions to their icon", () => {
    expect(fileIconName("report.pdf")).toBe("pdf")
    expect(fileIconName("photo.jpeg")).toBe("image")
    expect(fileIconName("archive.tar")).toBe("zip")
    expect(fileIconName("component.tsx")).toBe("react_ts")
  })

  it("ignores case and uses the last extension", () => {
    expect(fileIconName("MOVIE.MP4")).toBe("video")
    expect(fileIconName("bundle.min.js")).toBe("javascript")
  })

  it("falls back to the generic file icon", () => {
    expect(fileIconName("unknown.xyz")).toBe("file")
    expect(fileIconName("README")).toBe("file")
  })
})

describe("icon assets", () => {
  const iconsDirectory = resolve(__dirname, "../../../public/file-icons")

  it("has an SVG for every mapped icon plus the defaults", () => {
    const icons = new Set([...Object.values(iconByExtension), "file", "folder"])
    for (const icon of icons) {
      expect(
        existsSync(resolve(iconsDirectory, `${icon}.svg`)),
        `missing public/file-icons/${icon}.svg`
      ).toBe(true)
    }
  })
})
