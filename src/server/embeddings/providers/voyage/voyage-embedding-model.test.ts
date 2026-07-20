import { afterEach, describe, expect, it, vi } from "vitest"

import { createVoyageDocumentEmbeddingModel } from "./voyage-embedding-model.server"
import type { VoyageEmbeddingModelError } from "./voyage-embedding-model.server"

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("Voyage document embedding model", () => {
  it("backs off and retries transient provider failures", async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, "random").mockReturnValue(0)
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(
        Response.json({
          data: [
            {
              index: 0,
              embedding: Array.from({ length: 1_024 }, () => 0.01),
            },
          ],
        })
      )
    vi.stubGlobal("fetch", fetchMock)

    const model = createVoyageDocumentEmbeddingModel("test-key")
    const pending = model.doEmbed({
      values: ["A passage"],
    })
    await vi.runAllTimersAsync()

    const result = await pending
    expect(model.maxEmbeddingsPerCall).toBe(128)
    expect(result.embeddings).toHaveLength(1)
    expect(result.embeddings[0]).toHaveLength(1_024)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("does not retry permanent provider failures", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 400 }))
    vi.stubGlobal("fetch", fetchMock)

    const pending = createVoyageDocumentEmbeddingModel("test-key").doEmbed({
      values: ["A passage"],
    })

    await expect(pending).rejects.toMatchObject({
      code: "INVALID_INPUT",
      retryable: false,
    } satisfies Partial<VoyageEmbeddingModelError>)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
