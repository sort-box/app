import type { EmbeddingModel } from "ai"

import type { EmbeddingError } from "../../../search/embedding"
import { VoyageSearchAdapter } from "../../../search/providers/voyage/voyage-search.server"
import { EMBEDDING_DIMENSION } from "../../document-types"

const MAX_PROVIDER_ATTEMPTS = 6
const MAX_BACKOFF_MS = 60_000
const INITIAL_BACKOFF_MS = 1_000
export const VOYAGE_DOCUMENT_BATCH_SIZE = 128

export type VoyageDocumentEmbeddingModel = Extract<
  EmbeddingModel,
  { specificationVersion: "v3" }
>

export class VoyageEmbeddingModelError extends Error {
  constructor(
    readonly code: EmbeddingError["code"],
    readonly retryable: boolean
  ) {
    super("Document embedding failed.")
  }
}

function retryable(error: EmbeddingError): boolean {
  return (
    error.code === "RATE_LIMITED" ||
    error.code === "UNAVAILABLE" ||
    error.code === "INVALID_RESPONSE"
  )
}

function backoffMs(attempt: number): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** attempt)
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2))
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export function createVoyageDocumentEmbeddingModel(
  apiKey: string
): VoyageDocumentEmbeddingModel {
  const adapter = new VoyageSearchAdapter(
    apiKey,
    globalThis.fetch,
    EMBEDDING_DIMENSION
  )

  return {
    specificationVersion: "v3",
    provider: "voyage",
    modelId: "voyage-4-large:document:1024",
    maxEmbeddingsPerCall: VOYAGE_DOCUMENT_BATCH_SIZE,
    supportsParallelCalls: false,
    async doEmbed({ values }) {
      for (let attempt = 0; attempt < MAX_PROVIDER_ATTEMPTS; attempt += 1) {
        const result = await adapter.embedDocuments(values)
        if (result.isOk()) {
          return {
            embeddings: result.value.map((embedding) => [...embedding]),
            warnings: [],
          }
        }

        const canRetry = retryable(result.error)
        if (!canRetry || attempt === MAX_PROVIDER_ATTEMPTS - 1) {
          throw new VoyageEmbeddingModelError(result.error.code, canRetry)
        }
        const delay = backoffMs(attempt)
        console.warn("Retrying document embedding provider request.", {
          attempt: attempt + 1,
          code: result.error.code,
          delay,
        })
        await wait(delay)
      }

      throw new VoyageEmbeddingModelError("UNAVAILABLE", true)
    },
  }
}
