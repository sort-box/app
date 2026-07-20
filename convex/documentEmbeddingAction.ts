"use node"

import { NonRetryableError } from "@convex-dev/workpool"

import { chunkExtractedBlocks } from "../src/server/embeddings/chunk-document"
import { DocumentExtractionService } from "../src/server/embeddings/document-extraction.server"
import { embeddableDocumentKind } from "../src/server/embeddings/document-types"
import {
  VOYAGE_DOCUMENT_BATCH_SIZE,
  VoyageEmbeddingModelError,
  createVoyageDocumentEmbeddingModel,
} from "../src/server/embeddings/providers/voyage/voyage-embedding-model.server"
import { getObjectStorage } from "../src/server/storage/storage.server"
import { internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { env } from "./_generated/server"
import { documentRag } from "./embeddings/rag"

async function documentBody(
  objectKey: string
): Promise<ReadableStream<Uint8Array>> {
  const storage = getObjectStorage()
  if (storage.isErr()) {
    throw new NonRetryableError("EMBEDDING_FAILED")
  }

  const downloaded = await storage.value.getObject({ key: objectKey })
  if (downloaded.isOk()) return downloaded.value.body
  if (
    downloaded.error.code === "PROVIDER_UNAVAILABLE" &&
    downloaded.error.retryable
  ) {
    throw new Error("EMBEDDING_FAILED")
  }
  if (downloaded.error.code === "UNKNOWN") {
    throw new Error("EMBEDDING_FAILED")
  }
  throw new NonRetryableError("EMBEDDING_FAILED")
}

export const chunkDocument = documentRag.defineChunkerAction(
  (ctx, { entry }) => {
    return (async function* () {
      const metadata = entry.metadata
      if (
        !metadata ||
        metadata.version === undefined ||
        typeof metadata.fileId !== "string" ||
        typeof metadata.contentType !== "string"
      ) {
        throw new NonRetryableError("EMBEDDING_FAILED")
      }
      const sourceMetadata = await ctx.runQuery(
        internal.documentEmbedding.getEmbeddingSourceMetadata,
        {
          fileId: metadata.fileId as Id<"files">,
          entryId: entry.entryId,
        }
      )
      if (
        !sourceMetadata ||
        sourceMetadata.contentType !== metadata.contentType
      ) {
        throw new NonRetryableError("EMBEDDING_FAILED")
      }
      const kind = embeddableDocumentKind(
        sourceMetadata.fileName,
        metadata.contentType
      )
      if (!kind) throw new NonRetryableError("UNSUPPORTED_TYPE")

      await ctx.runMutation(internal.documentEmbedding.setEmbeddingStage, {
        fileId: metadata.fileId as Id<"files">,
        entryId: entry.entryId,
        stage: "extracting",
      })
      const body = await documentBody(sourceMetadata.objectKey)
      const extracted = await new DocumentExtractionService().extract({
        body,
        contentType: metadata.contentType,
        fileName: sourceMetadata.fileName,
        kind,
        size: sourceMetadata.size,
      })
      if (extracted.isErr()) {
        throw new NonRetryableError(extracted.error.code)
      }
      const chunked = chunkExtractedBlocks(extracted.value)
      if (!chunked.ok) throw new NonRetryableError(chunked.error.code)

      await ctx.runMutation(internal.documentEmbedding.setEmbeddingStage, {
        fileId: metadata.fileId as Id<"files">,
        entryId: entry.entryId,
        stage: "embedding",
      })
      const model = createVoyageDocumentEmbeddingModel(env.VOYAGE_API_KEY)
      for (
        let offset = 0;
        offset < chunked.chunks.length;
        offset += VOYAGE_DOCUMENT_BATCH_SIZE
      ) {
        const batch = chunked.chunks.slice(
          offset,
          offset + VOYAGE_DOCUMENT_BATCH_SIZE
        )
        let embeddings: number[][]
        try {
          const result = await model.doEmbed({
            values: batch.map((chunk) => chunk.embeddingText),
          })
          embeddings = result.embeddings
        } catch (error) {
          if (error instanceof VoyageEmbeddingModelError) {
            console.error("Document embedding provider failed.", {
              code: error.code,
              retryable: error.retryable,
            })
          }
          if (error instanceof VoyageEmbeddingModelError && !error.retryable) {
            throw new NonRetryableError("EMBEDDING_FAILED")
          }
          throw new Error("EMBEDDING_FAILED")
        }
        for (let index = 0; index < batch.length; index += 1) {
          const chunk = batch[index]
          yield {
            text: chunk.text,
            keywords: chunk.embeddingText,
            embedding: embeddings[index],
            metadata: {
              embeddingText: chunk.embeddingText,
              headingPath: [...chunk.headingPath],
              order: chunk.order,
              provenance: chunk.provenance,
            },
          }
        }
      }
    })()
  }
)
