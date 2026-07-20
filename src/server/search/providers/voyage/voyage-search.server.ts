import { ResultAsync, errAsync, okAsync } from "neverthrow"

import type {
  EmbeddingError,
  EmbeddingPort,
  EmbeddingVector,
} from "../../embedding"
import type {
  RerankedCandidate,
  RerankingError,
  RerankingPort,
} from "../../reranking"

const VOYAGE_API_URL = "https://api.voyageai.com/v1"
const EMBEDDING_MODEL = "voyage-4-large"
const RERANKING_MODEL = "rerank-2.5"
const MAX_BATCH_SIZE = 1_000
const DEFAULT_EMBEDDING_DIMENSION = 1_024

type VoyageError = EmbeddingError | RerankingError
type Fetch = typeof fetch

class VoyageRequestError {
  constructor(readonly error: VoyageError) {}
}

function mapStatus(status: number): VoyageError {
  if (status === 400) return { code: "INVALID_INPUT" }
  if (status === 401 || status === 403) {
    return { code: "CONFIGURATION_ERROR" }
  }
  if (status === 429) return { code: "RATE_LIMITED", retryable: true }
  if (status >= 500) return { code: "UNAVAILABLE", retryable: true }
  return { code: "INVALID_RESPONSE" }
}

function mapRequestError(error: unknown): VoyageError {
  return error instanceof VoyageRequestError
    ? error.error
    : { code: "UNAVAILABLE", retryable: true }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function invalidTexts(texts: readonly string[]): boolean {
  return (
    texts.length === 0 ||
    texts.length > MAX_BATCH_SIZE ||
    texts.some((text) => text.trim().length === 0)
  )
}

export class VoyageSearchAdapter implements EmbeddingPort, RerankingPort {
  constructor(
    private readonly apiKey: string,
    private readonly fetch: Fetch = globalThis.fetch,
    private readonly embeddingDimension = DEFAULT_EMBEDDING_DIMENSION
  ) {
    if (
      !Number.isInteger(embeddingDimension) ||
      embeddingDimension < 1 ||
      embeddingDimension > 2_048
    ) {
      throw new RangeError("Invalid embedding dimension.")
    }
  }

  embedDocuments(texts: readonly string[]) {
    if (invalidTexts(texts)) {
      return errAsync<readonly EmbeddingVector[], EmbeddingError>({
        code: "INVALID_INPUT",
      })
    }

    return this.embed(texts, "document")
  }

  embedQuery(text: string) {
    if (text.trim().length === 0) {
      return errAsync<EmbeddingVector, EmbeddingError>({
        code: "INVALID_INPUT",
      })
    }

    return this.embed([text], "query").map((embeddings) => embeddings[0])
  }

  rerank(input: Parameters<RerankingPort["rerank"]>[0]) {
    const { query, candidates, limit } = input
    if (
      query.trim().length === 0 ||
      candidates.length === 0 ||
      candidates.length > MAX_BATCH_SIZE ||
      candidates.some(
        (candidate) =>
          candidate.id.trim().length === 0 || candidate.text.trim().length === 0
      ) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > candidates.length
    ) {
      return errAsync<readonly RerankedCandidate[], RerankingError>({
        code: "INVALID_INPUT",
      })
    }

    return this.request("/rerank", {
      query,
      documents: candidates.map((candidate) => candidate.text),
      model: RERANKING_MODEL,
      top_k: limit,
      return_documents: false,
    }).andThen((body) => {
      if (!isRecord(body) || !Array.isArray(body.data)) {
        return errAsync<readonly RerankedCandidate[], RerankingError>({
          code: "INVALID_RESPONSE",
        })
      }

      const seen = new Set<number>()
      const reranked: RerankedCandidate[] = []
      for (const item of body.data) {
        if (
          !isRecord(item) ||
          !Number.isInteger(item.index) ||
          (item.index as number) < 0 ||
          (item.index as number) >= candidates.length ||
          seen.has(item.index as number) ||
          !isFiniteNumber(item.relevance_score)
        ) {
          return errAsync<readonly RerankedCandidate[], RerankingError>({
            code: "INVALID_RESPONSE",
          })
        }

        const index = item.index as number
        seen.add(index)
        reranked.push({
          id: candidates[index].id,
          score: item.relevance_score,
        })
      }

      if (reranked.length !== limit) {
        return errAsync<readonly RerankedCandidate[], RerankingError>({
          code: "INVALID_RESPONSE",
        })
      }
      return okAsync<readonly RerankedCandidate[], RerankingError>(reranked)
    })
  }

  private embed(texts: readonly string[], inputType: "document" | "query") {
    return this.request("/embeddings", {
      input: texts,
      model: EMBEDDING_MODEL,
      input_type: inputType,
      output_dimension: this.embeddingDimension,
    }).andThen((body) => {
      if (!isRecord(body) || !Array.isArray(body.data)) {
        return errAsync<readonly EmbeddingVector[], EmbeddingError>({
          code: "INVALID_RESPONSE",
        })
      }

      const vectors: EmbeddingVector[] = Array(texts.length)
      const seen = new Set<number>()
      for (const item of body.data) {
        if (
          !isRecord(item) ||
          !Number.isInteger(item.index) ||
          (item.index as number) < 0 ||
          (item.index as number) >= texts.length ||
          seen.has(item.index as number) ||
          !Array.isArray(item.embedding) ||
          item.embedding.length !== this.embeddingDimension ||
          !item.embedding.every(isFiniteNumber)
        ) {
          return errAsync<readonly EmbeddingVector[], EmbeddingError>({
            code: "INVALID_RESPONSE",
          })
        }

        const index = item.index as number
        seen.add(index)
        vectors[index] = item.embedding
      }

      if (seen.size !== texts.length) {
        return errAsync<readonly EmbeddingVector[], EmbeddingError>({
          code: "INVALID_RESPONSE",
        })
      }
      return okAsync<readonly EmbeddingVector[], EmbeddingError>(vectors)
    })
  }

  private request(path: string, body: Record<string, unknown>) {
    return ResultAsync.fromPromise(
      (async () => {
        const response = await this.fetch(`${VOYAGE_API_URL}${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        })

        if (!response.ok) {
          throw new VoyageRequestError(mapStatus(response.status))
        }

        try {
          return await response.json()
        } catch {
          throw new VoyageRequestError({ code: "INVALID_RESPONSE" })
        }
      })(),
      mapRequestError
    )
  }
}
