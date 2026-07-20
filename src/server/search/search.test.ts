import { afterEach, describe, expect, it } from "vitest"

import { getSearchAdapters } from "./search.server"

const originalApiKey = process.env.VOYAGE_API_KEY

afterEach(() => {
  if (originalApiKey === undefined) {
    delete process.env.VOYAGE_API_KEY
  } else {
    process.env.VOYAGE_API_KEY = originalApiKey
  }
})

describe("getSearchAdapters", () => {
  it("returns a typed failure when the API key is missing", () => {
    delete process.env.VOYAGE_API_KEY

    const result = getSearchAdapters()

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error).toEqual({
        code: "INVALID_SEARCH_CONFIGURATION",
        message: "Required search configuration is missing.",
      })
    }
  })

  it("returns a typed failure when the API key is blank", () => {
    process.env.VOYAGE_API_KEY = " "

    const result = getSearchAdapters()

    expect(result.isErr()).toBe(true)
  })

  it("builds both search adapters from configured credentials", () => {
    process.env.VOYAGE_API_KEY = "test-api-key"

    const result = getSearchAdapters()

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.embedding).toBe(result.value.reranking)
    }
  })
})
