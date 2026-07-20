import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import {
  FileRestService,
  fileApiMiddleware,
  jsonBody,
  resultResponse,
} from "@/server/files/file-api.server"

const createSchema = z.object({ path: z.string() })
const moveSchema = z.object({
  path: z.string(),
  destinationPath: z.string(),
})

export const Route = createFileRoute("/api/folders")({
  server: {
    middleware: [fileApiMiddleware],
    handlers: {
      POST: async ({ request, context }) => {
        const body = await jsonBody(request, createSchema)
        if (!body.ok) return resultResponse(context.fileApi, body)
        const service = new FileRestService(context.fileApi)
        const limited = await service.rateLimit("mutation")
        if (!limited.ok) return resultResponse(context.fileApi, limited)
        return resultResponse(
          context.fileApi,
          await service.createFolder(body.value.path),
          201
        )
      },
      PATCH: async ({ request, context }) => {
        const body = await jsonBody(request, moveSchema)
        if (!body.ok) return resultResponse(context.fileApi, body)
        const service = new FileRestService(context.fileApi)
        const limited = await service.rateLimit("mutation")
        if (!limited.ok) return resultResponse(context.fileApi, limited)
        return resultResponse(
          context.fileApi,
          await service.moveFolder(body.value.path, body.value.destinationPath)
        )
      },
      DELETE: async ({ request, context }) => {
        const path = new URL(request.url).searchParams.get("path")
        const service = new FileRestService(context.fileApi)
        if (!path) {
          return resultResponse(context.fileApi, {
            ok: false,
            error: {
              code: "INVALID_INPUT",
              message: "The directory path is invalid.",
              retryable: false,
            },
          })
        }
        const limited = await service.rateLimit("mutation")
        if (!limited.ok) return resultResponse(context.fileApi, limited)
        const result = await service.deleteFolder(path)
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
