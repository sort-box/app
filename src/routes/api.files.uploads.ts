import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import {
  FileRestService,
  MAX_FILE_SIZE,
  fileApiMiddleware,
  jsonBody,
  resultResponse,
} from "@/server/files/file-api.server"

const bodySchema = z.object({
  path: z.string(),
  contentType: z.string().trim().min(1).max(255),
  size: z.number().int().nonnegative().max(MAX_FILE_SIZE),
})

export const Route = createFileRoute("/api/files/uploads")({
  server: {
    middleware: [fileApiMiddleware],
    handlers: {
      POST: async ({ request, context }) => {
        const body = await jsonBody(request, bodySchema)
        if (!body.ok) return resultResponse(context.fileApi, body)
        const service = new FileRestService(context.fileApi)
        const limited = await service.rateLimit("upload")
        if (!limited.ok) return resultResponse(context.fileApi, limited)
        return resultResponse(
          context.fileApi,
          await service.createUpload(body.value),
          201
        )
      },
    },
  },
})
