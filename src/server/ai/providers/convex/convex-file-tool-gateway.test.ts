import { describe, expect, it, vi } from "vitest"

import type { FileRestService } from "../../../files/file-api.server"
import { ConvexFileToolGateway } from "./convex-file-tool-gateway.server"

type FetchCall = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>

const context = {
  authToken: "auth-token",
  convexSiteUrl: "https://example.convex.site/",
  serviceSecret: "s".repeat(32),
}

function gateway(fetchMock: ReturnType<typeof vi.fn<FetchCall>>) {
  return new ConvexFileToolGateway(
    {} as FileRestService,
    context,
    fetchMock as typeof fetch
  )
}

describe("ConvexFileToolGateway", () => {
  it("uses the cursor-only exact-search contract", async () => {
    const fetchMock = vi.fn<FetchCall>(async () =>
      Response.json({
        matches: [
          {
            fileId: "file-1",
            path: "/notes.txt",
            occurrenceCount: 23,
            locations: [{ kind: "text", start: 0, end: 20 }],
            omittedLocationCount: 22,
          },
        ],
        scannedReadyFiles: 1,
        scannedIndexedFiles: 1,
        unsearchableReadyFiles: 0,
        complete: false,
        nextCursor: "signed-cursor",
        warnings: ["LOCATIONS_TRUNCATED"],
      })
    )

    const result = await gateway(fetchMock).findExactReferences({
      query: "Literal",
      caseSensitive: true,
      cursor: null,
    })

    expect(result._unsafeUnwrap()).toMatchObject({
      matches: [{ occurrenceCount: 23, omittedLocationCount: 22 }],
      nextCursor: "signed-cursor",
    })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://example.convex.site/internal/ai/files")
    expect(init).toBeDefined()
    if (!init) return
    expect(init.headers).toEqual({
      Authorization: "Bearer auth-token",
      "Content-Type": "application/json",
      "x-file-service-secret": "s".repeat(32),
    })
    expect(JSON.parse(String(init.body))).toEqual({
      operation: "findExact",
      query: "Literal",
      caseSensitive: true,
      cursor: null,
    })
  })

  it("rejects malformed exact-search responses", async () => {
    const result = await gateway(
      vi.fn(async () => Response.json({ matches: [] }))
    ).findExactReferences({
      query: "term",
      caseSensitive: false,
      cursor: null,
    })

    expect(result.isErr() && result.error).toEqual({
      code: "UNAVAILABLE",
      retryable: true,
    })
  })

  it.each([
    [400, undefined, "INVALID_INPUT"],
    [401, undefined, "NOT_AUTHENTICATED"],
    [404, undefined, "FILE_NOT_FOUND"],
    [409, "CONTENT_NOT_INDEXED", "CONTENT_NOT_INDEXED"],
    [429, undefined, "RATE_LIMITED"],
    [500, undefined, "UNAVAILABLE"],
  ] as const)(
    "maps HTTP %s responses to %s",
    async (status, responseCode, expectedCode) => {
      const fetchMock = vi.fn(async () =>
        Response.json(
          responseCode === undefined ? {} : { code: responseCode },
          { status }
        )
      )

      const result = await gateway(fetchMock).readChunks({
        fileId: "file-1",
        cursor: null,
        limit: 10,
      })

      expect(result.isErr() && result.error.code).toBe(expectedCode)
    }
  )
})
