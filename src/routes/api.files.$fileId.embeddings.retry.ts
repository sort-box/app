import { createFileRoute } from "@tanstack/react-router"

import {
  FileRestService,
  fileApiMiddleware,
  resultResponse,
} from "@/server/files/file-api.server"

export const Route = createFileRoute("/api/files/$fileId/embeddings/retry")({
  server: {
    middleware: [fileApiMiddleware],
    handlers: {
      POST: async ({ params, context }) => {
        const service = new FileRestService(context.fileApi)
        const limited = await service.rateLimit("mutation")
        if (!limited.ok) return resultResponse(context.fileApi, limited)
        return resultResponse(
          context.fileApi,
          await service.retryEmbedding(params.fileId)
        )
      },
    },
  },
})
