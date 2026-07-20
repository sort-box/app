import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { uploadFile } from "./api"

function rateLimited(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: "RATE_LIMITED",
        message: "Too many file requests.",
        retryable: true,
        retryAfter: 1,
      },
    }),
    { status: 429 }
  )
}

function ticket(): Response {
  return new Response(
    JSON.stringify({
      data: {
        fileId: "file_1",
        upload: {
          url: "https://storage.example/put",
          method: "PUT",
          expiresAt: 0,
          requiredHeaders: {},
        },
      },
    }),
    { status: 200 }
  )
}

describe("uploadFile rate limit pacing", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("waits out a rate limited step and then succeeds", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(ticket())
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetchMock)
    const waits: Array<number> = []
    const upload = uploadFile("/a.txt", new File(["x"], "a.txt"), {
      onRateLimit: (seconds) => waits.push(seconds),
    })
    await vi.runAllTimersAsync()
    const result = await upload
    expect(result.isOk()).toBe(true)
    expect(waits).toEqual([1])
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it("gives up after exhausting rate limit retries", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => rateLimited())
    vi.stubGlobal("fetch", fetchMock)
    const upload = uploadFile("/a.txt", new File(["x"], "a.txt"))
    await vi.runAllTimersAsync()
    const result = await upload
    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr()).toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
    })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})
