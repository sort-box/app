import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import {
  FileRestService,
  fileApiMiddleware,
  jsonBody,
  resultResponse,
} from "@/server/files/file-api.server"

const bodySchema = z.object({ path: z.string() })

export const Route = createFileRoute("/api/files/$fileId")({
  server: {
    middleware: [fileApiMiddleware],
    handlers: {
      PATCH: async ({ request, params, context }) => {
        const body = await jsonBody(request, bodySchema)
        if (!body.ok) return resultResponse(context.fileApi, body)
        const service = new FileRestService(context.fileApi)
        const limited = await service.rateLimit("mutation")
        if (!limited.ok) return resultResponse(context.fileApi, limited)
        return resultResponse(
          context.fileApi,
          await service.move(params.fileId, body.value.path)
        )
      },
      DELETE: async ({ params, context }) => {
        const service = new FileRestService(context.fileApi)
        const limited = await service.rateLimit("mutation")
        if (!limited.ok) return resultResponse(context.fileApi, limited)
        const result = await service.delete(params.fileId)
        if (!result.ok) return resultResponse(context.fileApi, result)
        return new Response(null, {
          status: 204,
          headers: {
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
          },
        })
      },
    },
  },
})
