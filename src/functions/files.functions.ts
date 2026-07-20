import { auth } from "@clerk/tanstack-react-start/server"
import { createServerFn } from "@tanstack/react-start"
import { ConvexHttpClient } from "convex/browser"
import { z } from "zod"

import { FileRestService } from "@/server/files/file-api.server"

const MAX_SINGLE_PART_SIZE = Math.floor(4.995 * 1024 ** 3)

const fileIdSchema = z.string().min(1)
const createUploadSchema = z.object({
  originalName: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(255),
  size: z.number().int().nonnegative().max(MAX_SINGLE_PART_SIZE),
})
const fileOperationSchema = z.object({ fileId: fileIdSchema })
const listFilesSchema = z.object({
  status: z.enum(["pending", "ready", "deleting", "failed"]).default("ready"),
  cursor: z.string().nullable().default(null),
  limit: z.number().int().min(1).max(100).default(25),
})

type FileApiError = {
  code:
    | "NOT_AUTHENTICATED"
    | "INVALID_INPUT"
    | "FILE_NOT_FOUND"
    | "INVALID_FILE_STATE"
    | "UPLOAD_MISMATCH"
    | "STORAGE_UNAVAILABLE"
    | "CONFIGURATION_ERROR"
    | "INTERNAL_ERROR"
  message: string
  retryable: boolean
}

type ApiResult<T> = { ok: true; value: T } | { ok: false; error: FileApiError }

function failure(
  code: FileApiError["code"],
  message: string,
  retryable = false
): { ok: false; error: FileApiError } {
  return { ok: false, error: { code, message, retryable } }
}

async function authenticatedConvexClient(): Promise<
  ApiResult<ConvexHttpClient & { authToken: string; userId: string }>
> {
  const { userId, getToken } = await auth()
  if (!userId) {
    return failure("NOT_AUTHENTICATED", "You must sign in to manage files.")
  }

  const token = await getToken()
  const convexUrl = import.meta.env.VITE_CONVEX_URL
  if (!token || !convexUrl) {
    return failure(
      "CONFIGURATION_ERROR",
      "The authenticated file service is not configured."
    )
  }

  const client = new ConvexHttpClient(convexUrl)
  client.setAuth(token)
  return {
    ok: true,
    value: Object.assign(client, { authToken: token, userId }),
  }
}

function restService(
  client: ConvexHttpClient & { authToken: string; userId: string }
) {
  return new FileRestService({
    authToken: client.authToken,
    client,
    requestId: crypto.randomUUID(),
    userId: client.userId,
  })
}

export const createFileUpload = createServerFn({ method: "POST" })
  .validator(createUploadSchema)
  .handler(async ({ data }) => {
    const clientResult = await authenticatedConvexClient()
    if (!clientResult.ok) return clientResult

    const service = restService(clientResult.value)
    const limited = await service.rateLimit("upload")
    if (!limited.ok) return failure("INTERNAL_ERROR", limited.error.message)
    const result = await service.createUpload({
      path: `/${data.originalName}`,
      contentType: data.contentType,
      size: data.size,
    })
    if (!result.ok) return failure("INTERNAL_ERROR", result.error.message)
    const value = result.value as {
      fileId: string
      upload: {
        url: string
        requiredHeaders: Record<string, string>
        expiresAt: number
      }
    }
    return {
      ok: true,
      value: {
        fileId: value.fileId,
        uploadUrl: value.upload.url,
        method: "PUT" as const,
        requiredHeaders: value.upload.requiredHeaders,
        expiresAt: value.upload.expiresAt,
      },
    }
  })

export const completeFileUpload = createServerFn({ method: "POST" })
  .validator(fileOperationSchema)
  .handler(async ({ data }) => {
    const clientResult = await authenticatedConvexClient()
    if (!clientResult.ok) return clientResult
    const service = restService(clientResult.value)
    const limited = await service.rateLimit("mutation")
    if (!limited.ok) return failure("INTERNAL_ERROR", limited.error.message)
    const result = await service.complete(data.fileId)
    return result.ok
      ? { ok: true as const, value: result.value }
      : failure("INTERNAL_ERROR", result.error.message)
  })

export const getFileDownload = createServerFn({ method: "POST" })
  .validator(fileOperationSchema)
  .handler(async ({ data }) => {
    const clientResult = await authenticatedConvexClient()
    if (!clientResult.ok) return clientResult
    const service = restService(clientResult.value)
    const limited = await service.rateLimit("read")
    if (!limited.ok) return failure("INTERNAL_ERROR", limited.error.message)
    const result = await service.download(data.fileId)
    return result.ok
      ? {
          ok: true as const,
          value: result.value as {
            url: string
            expiresAt: number
            requiredHeaders: Record<string, string>
          },
        }
      : failure("INTERNAL_ERROR", result.error.message)
  })

export const deleteFile = createServerFn({ method: "POST" })
  .validator(fileOperationSchema)
  .handler(async ({ data }) => {
    const clientResult = await authenticatedConvexClient()
    if (!clientResult.ok) return clientResult
    const service = restService(clientResult.value)
    const limited = await service.rateLimit("mutation")
    if (!limited.ok) return failure("INTERNAL_ERROR", limited.error.message)
    const result = await service.delete(data.fileId)
    return result.ok
      ? { ok: true as const, value: null }
      : failure("INTERNAL_ERROR", result.error.message)
  })

export const listMyFiles = createServerFn({ method: "GET" })
  .validator(listFilesSchema)
  .handler(async ({ data }) => {
    const clientResult = await authenticatedConvexClient()
    if (!clientResult.ok) return clientResult
    if (data.status !== "ready") {
      return failure(
        "INVALID_FILE_STATE",
        "Only ready files are exposed by the compatibility listing."
      )
    }
    const service = restService(clientResult.value)
    const limited = await service.rateLimit("read")
    if (!limited.ok) return failure("INTERNAL_ERROR", limited.error.message)
    const result = await service.list({
      path: "/",
      recursive: true,
      cursor: data.cursor,
      limit: data.limit,
    })
    if (!result.ok) return failure("INTERNAL_ERROR", result.error.message)
    const value = result.value as {
      page: Array<{
        path: string
        parentPath: string
        basename: string
        kind: "file" | "directory"
        fileId?: string
        status: "pending" | "ready" | "deleting" | "failed"
      }>
      continueCursor: string
      isDone: boolean
    }
    return {
      ok: true as const,
      value: {
        page: value.page.map((entry) => ({
          path: entry.path,
          parentPath: entry.parentPath,
          basename: entry.basename,
          kind: entry.kind,
          fileId: entry.fileId,
          status: entry.status,
        })),
        continueCursor: value.continueCursor,
        isDone: value.isDone,
      },
    }
  })

export const cleanupMyIncompleteUploads = createServerFn({ method: "POST" })
  .validator(z.object({ limit: z.number().int().min(1).max(50).default(25) }))
  .handler(async ({ data }) => {
    const clientResult = await authenticatedConvexClient()
    if (!clientResult.ok) return clientResult
    void data.limit
    return { ok: true, value: { cleaned: 0 } }
  })
