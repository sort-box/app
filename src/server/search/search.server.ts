import { err, ok, type Result } from "neverthrow"

import type { EmbeddingPort } from "./embedding"
import type { RerankingPort } from "./reranking"
import { VoyageSearchAdapter } from "./providers/voyage/voyage-search.server"

export type SearchConfigurationError = {
  code: "INVALID_SEARCH_CONFIGURATION"
  message: string
}

export type SearchAdapters = {
  embedding: EmbeddingPort
  reranking: RerankingPort
}

export function getSearchAdapters(): Result<
  SearchAdapters,
  SearchConfigurationError
> {
  const apiKey = process.env.VOYAGE_API_KEY?.trim()
  if (!apiKey) {
    return err({
      code: "INVALID_SEARCH_CONFIGURATION",
      message: "Required search configuration is missing.",
    })
  }

  const adapter = new VoyageSearchAdapter(apiKey)
  return ok({ embedding: adapter, reranking: adapter })
}
