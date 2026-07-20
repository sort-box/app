import { createFileRoute } from "@tanstack/react-router"

import {
  FileRestService,
  fileApiMiddleware,
  resultResponse,
} from "@/server/files/file-api.server"

export const Route = createFileRoute("/api/files/$fileId/download")({
  server: {
    middleware: [fileApiMiddleware],
    handlers: {
      GET: async ({ params, context }) => {
        const service = new FileRestService(context.fileApi)
        const limited = await service.rateLimit("read")
        if (!limited.ok) return resultResponse(context.fileApi, limited)
        return resultResponse(
          context.fileApi,
          await service.download(params.fileId)
        )
      },
    },
  },
})
