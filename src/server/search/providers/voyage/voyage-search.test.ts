import { describe, expect, it, vi } from "vitest"

import { VoyageSearchAdapter } from "./voyage-search.server"

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

function adapterWith(fetchImplementation: typeof fetch) {
  return new VoyageSearchAdapter("test-api-key", fetchImplementation)
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>) {
  const init = fetchMock.mock.calls[0][1] as RequestInit
  return JSON.parse(init.body as string)
}

describe("VoyageSearchAdapter embeddings", () => {
  it("embeds documents with the retrieval document input type", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [
          { object: "embedding", index: 1, embedding: [0.3, 0.4] },
          { object: "embedding", index: 0, embedding: [0.1, 0.2] },
        ],
      })
    )
    const adapter = adapterWith(fetchMock)

    const result = await adapter.embedDocuments(["first", "second"])

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toEqual([
        [0.1, 0.2],
        [0.3, 0.4],
      ])
    }
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.voyageai.com/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer test-api-key",
          "Content-Type": "application/json",
        },
      })
    )
    expect(requestBody(fetchMock)).toEqual({
      input: ["first", "second"],
      model: "voyage-4-large",
      input_type: "document",
    })
  })

  it("embeds a query with the retrieval query input type", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [{ object: "embedding", index: 0, embedding: [0.5, 0.6] }],
      })
    )
    const adapter = adapterWith(fetchMock)

    const result = await adapter.embedQuery("find this")

    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value).toEqual([0.5, 0.6])
    expect(requestBody(fetchMock)).toEqual({
      input: ["find this"],
      model: "voyage-4-large",
      input_type: "query",
    })
  })

  it.each([
    { name: "an empty document batch", input: [] },
    { name: "a blank document", input: [" "] },
    {
      name: "more than 1000 documents",
      input: Array.from({ length: 1_001 }, () => "document"),
    },
  ])("rejects $name without a request", async ({ input }) => {
    const fetchMock = vi.fn()
    const adapter = adapterWith(fetchMock)

    const result = await adapter.embedDocuments(input)

    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error).toEqual({ code: "INVALID_INPUT" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects a blank query without a request", async () => {
    const fetchMock = vi.fn()
    const adapter = adapterWith(fetchMock)

    const result = await adapter.embedQuery(" ")

    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error).toEqual({ code: "INVALID_INPUT" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: "a missing vector",
      body: { data: [{ index: 0, embedding: [0.1] }] },
    },
    {
      name: "a duplicate index",
      body: {
        data: [
          { index: 0, embedding: [0.1] },
          { index: 0, embedding: [0.2] },
        ],
      },
    },
    {
      name: "a non-finite vector value",
      body: {
        data: [
          { index: 0, embedding: [0.1] },
          { index: 1, embedding: [Number.NaN] },
        ],
      },
    },
  ])("rejects $name in an embedding response", async ({ body }) => {
    const adapter = adapterWith(vi.fn(async () => jsonResponse(body)))

    const result = await adapter.embedDocuments(["first", "second"])

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error).toEqual({ code: "INVALID_RESPONSE" })
    }
  })
})

describe("VoyageSearchAdapter reranking", () => {
  it("maps Voyage result indices back to candidate IDs", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.7 },
        ],
      })
    )
    const adapter = adapterWith(fetchMock)

    const result = await adapter.rerank({
      query: "best result",
      candidates: [
        { id: "first-id", text: "first" },
        { id: "second-id", text: "second" },
        { id: "third-id", text: "third" },
      ],
      limit: 2,
    })

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toEqual([
        { id: "second-id", score: 0.9 },
        { id: "first-id", score: 0.7 },
      ])
    }
    expect(requestBody(fetchMock)).toEqual({
      query: "best result",
      documents: ["first", "second", "third"],
      model: "rerank-2.5",
      top_k: 2,
      return_documents: false,
    })
  })

  it.each([
    {
      name: "a blank query",
      input: {
        query: " ",
        candidates: [{ id: "one", text: "first" }],
        limit: 1,
      },
    },
    {
      name: "an empty candidate list",
      input: { query: "query", candidates: [], limit: 1 },
    },
    {
      name: "a blank candidate",
      input: {
        query: "query",
        candidates: [{ id: "one", text: " " }],
        limit: 1,
      },
    },
    {
      name: "a blank candidate ID",
      input: {
        query: "query",
        candidates: [{ id: " ", text: "first" }],
        limit: 1,
      },
    },
    {
      name: "a non-integer limit",
      input: {
        query: "query",
        candidates: [{ id: "one", text: "first" }],
        limit: 0.5,
      },
    },
    {
      name: "a limit larger than the candidate list",
      input: {
        query: "query",
        candidates: [{ id: "one", text: "first" }],
        limit: 2,
      },
    },
  ])("rejects $name without a request", async ({ input }) => {
    const fetchMock = vi.fn()
    const adapter = adapterWith(fetchMock)

    const result = await adapter.rerank(input)

    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error).toEqual({ code: "INVALID_INPUT" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: "an out-of-range index",
      data: [{ index: 2, relevance_score: 0.9 }],
    },
    {
      name: "a duplicate index",
      data: [
        { index: 0, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.8 },
      ],
    },
    {
      name: "a non-finite score",
      data: [{ index: 0, relevance_score: Number.POSITIVE_INFINITY }],
    },
  ])("rejects $name in a reranking response", async ({ data }) => {
    const adapter = adapterWith(vi.fn(async () => jsonResponse({ data })))

    const result = await adapter.rerank({
      query: "query",
      candidates: [
        { id: "one", text: "first" },
        { id: "two", text: "second" },
      ],
      limit: data.length,
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error).toEqual({ code: "INVALID_RESPONSE" })
    }
  })
})

describe("VoyageSearchAdapter failures", () => {
  it.each([
    { status: 400, error: { code: "INVALID_INPUT" } },
    { status: 401, error: { code: "CONFIGURATION_ERROR" } },
    { status: 403, error: { code: "CONFIGURATION_ERROR" } },
    { status: 429, error: { code: "RATE_LIMITED", retryable: true } },
    { status: 500, error: { code: "UNAVAILABLE", retryable: true } },
    { status: 503, error: { code: "UNAVAILABLE", retryable: true } },
    { status: 418, error: { code: "INVALID_RESPONSE" } },
  ])(
    "maps HTTP $status without exposing its body",
    async ({ status, error }) => {
      const adapter = adapterWith(
        vi.fn(async () =>
          jsonResponse({ detail: "secret provider detail" }, status)
        )
      )

      const result = await adapter.embedQuery("query")

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error).toEqual(error)
        expect(JSON.stringify(result.error)).not.toContain("secret")
      }
    }
  )

  it("maps network failures without exposing their details", async () => {
    const adapter = adapterWith(
      vi.fn(async () => {
        throw new Error("secret endpoint and request id")
      })
    )

    const result = await adapter.embedQuery("query")

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error).toEqual({ code: "UNAVAILABLE", retryable: true })
      expect(JSON.stringify(result.error)).not.toContain("secret")
    }
  })

  it("rejects an invalid JSON success response", async () => {
    const adapter = adapterWith(
      vi.fn(async () => new Response("not JSON", { status: 200 }))
    )

    const result = await adapter.embedQuery("query")

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error).toEqual({ code: "INVALID_RESPONSE" })
    }
  })
})
