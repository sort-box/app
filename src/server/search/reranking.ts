import type { ResultAsync } from "neverthrow"

export type RerankCandidate = {
  id: string
  text: string
}

export type RerankedCandidate = {
  id: string
  score: number
}

export type RerankingError =
  | { code: "INVALID_INPUT" }
  | { code: "CONFIGURATION_ERROR" }
  | { code: "RATE_LIMITED"; retryable: true }
  | { code: "UNAVAILABLE"; retryable: true }
  | { code: "INVALID_RESPONSE" }

export interface RerankingPort {
  rerank: (input: {
    query: string
    candidates: readonly RerankCandidate[]
    limit: number
  }) => ResultAsync<readonly RerankedCandidate[], RerankingError>
}
