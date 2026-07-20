import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import {
  FileRestService,
  fileApiMiddleware,
  jsonBody,
  resultResponse,
} from "@/server/files/file-api.server"

const bodySchema = z.object({ destinationPath: z.string() })

export const Route = createFileRoute("/api/files/$fileId/copies")({
  server: {
    middleware: [fileApiMiddleware],
    handlers: {
      POST: async ({ request, params, context }) => {
        const body = await jsonBody(request, bodySchema)
        if (!body.ok) return resultResponse(context.fileApi, body)
        const service = new FileRestService(context.fileApi)
        const limited = await service.rateLimit("mutation")
        if (!limited.ok) return resultResponse(context.fileApi, limited)
        return resultResponse(
          context.fileApi,
          await service.copy(params.fileId, body.value.destinationPath),
          201
        )
      },
    },
  },
})
