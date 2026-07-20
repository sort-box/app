import { describe, expect, it } from "vitest"

import {
  parseDirectoryPath,
  parseFilePath,
  toPublicFile,
} from "./file-api.server"

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

describe("public file metadata", () => {
  it("does not expose ownership or object-storage identifiers", () => {
    const result = toPublicFile({
      _id: "file-id",
      _creationTime: 10,
      ownerClerkUserId: "user-id",
      ownerTokenIdentifier: "issuer|user-id",
      objectKey: "files/private-key",
      originalName: "report.pdf",
      declaredContentType: "application/pdf",
      declaredSize: 42,
      verifiedContentType: "application/pdf",
      verifiedSize: 42,
      etag: "etag",
      status: "ready",
      completedAt: 20,
      path: "/report.pdf",
      parentPath: "/",
      basename: "report.pdf",
      operation: "upload",
      usageBackfilledAt: 15,
    } as never)

    expect(result).toEqual({
      id: "file-id",
      createdAt: 10,
      path: "/report.pdf",
      parentPath: "/",
      basename: "report.pdf",
      contentType: "application/pdf",
      size: 42,
      etag: "etag",
      status: "ready",
      completedAt: 20,
    })
    expect(result).not.toHaveProperty("objectKey")
    expect(result).not.toHaveProperty("ownerTokenIdentifier")
  })
})
