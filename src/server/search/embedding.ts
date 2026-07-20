import type { ResultAsync } from "neverthrow"

export type EmbeddingVector = readonly number[]

export type EmbeddingError =
  | { code: "INVALID_INPUT" }
  | { code: "CONFIGURATION_ERROR" }
  | { code: "RATE_LIMITED"; retryable: true }
  | { code: "UNAVAILABLE"; retryable: true }
  | { code: "INVALID_RESPONSE" }

export interface EmbeddingPort {
  embedDocuments: (
    texts: readonly string[]
  ) => ResultAsync<readonly EmbeddingVector[], EmbeddingError>

  embedQuery: (text: string) => ResultAsync<EmbeddingVector, EmbeddingError>
}
