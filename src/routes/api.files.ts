import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import {
  FileRestService,
  fileApiMiddleware,
  resultResponse,
} from "@/server/files/file-api.server"

const searchSchema = z.object({
  path: z.string().default("/"),
  recursive: z.enum(["true", "false"]).default("false"),
  cursor: z.string().min(1).nullable().default(null),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})

export const Route = createFileRoute("/api/files")({
  server: {
    middleware: [fileApiMiddleware],
    handlers: {
      GET: async ({ request, context }) => {
        const values = Object.fromEntries(new URL(request.url).searchParams)
        const input = searchSchema.safeParse(values)
        if (!input.success) {
          return resultResponse(context.fileApi, {
            ok: false,
            error: {
              code: "INVALID_INPUT",
              message: "The query parameters are invalid.",
              retryable: false,
            },
          })
        }
        const service = new FileRestService(context.fileApi)
        const limited = await service.rateLimit("read")
        if (!limited.ok) return resultResponse(context.fileApi, limited)
        return resultResponse(
          context.fileApi,
          await service.list({
            ...input.data,
            recursive: input.data.recursive === "true",
          })
        )
      },
    },
  },
})
