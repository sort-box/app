import { RAG } from "@convex-dev/rag"

import { createVoyageQueryEmbeddingModel } from "../../src/server/embeddings/providers/voyage/voyage-embedding-model.server"
import { EMBEDDING_DIMENSION } from "../../src/server/embeddings/document-types"
import type { EMBEDDING_VERSION } from "../../src/server/embeddings/document-types"
import { components } from "../_generated/api"
import { env } from "../_generated/server"

export type DocumentEntryMetadata = {
  contentType: string
  fileId: string
  version: typeof EMBEDDING_VERSION
}

export const documentRag = new RAG<
  Record<string, never>,
  DocumentEntryMetadata
>(components.rag, {
  embeddingDimension: EMBEDDING_DIMENSION,
  // Chunk embeddings are precomputed with document input mode by the chunker.
  // RAG uses this model only for search queries, which require query input mode.
  textEmbeddingModel: createVoyageQueryEmbeddingModel(env.VOYAGE_API_KEY),
})
