import { auth } from "@clerk/tanstack-react-start/server"
import { createServerFn } from "@tanstack/react-start"
import { ConvexHttpClient } from "convex/browser"
import { z } from "zod"

import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import { getObjectStorage } from "@/server/storage/storage.server"

const MAX_SINGLE_PART_SIZE = 5 * 1024 ** 3 - 5 * 1024 ** 2
const UPLOAD_EXPIRY_SECONDS = 600
const INCOMPLETE_UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1_000

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
  ApiResult<ConvexHttpClient>
> {
  const { userId, getToken } = await auth()
  if (!userId) {
    return failure("NOT_AUTHENTICATED", "You must sign in to manage files.")
  }

  const token = await getToken()
  const convexUrl = process.env.VITE_CONVEX_URL
  if (!token || !convexUrl) {
    return failure(
      "CONFIGURATION_ERROR",
      "The authenticated file service is not configured."
    )
  }

  const client = new ConvexHttpClient(convexUrl)
  client.setAuth(token)
  return { ok: true, value: client }
}

function storageFailure(error: { code: string; retryable?: boolean }): {
  ok: false
  error: FileApiError
} {
  if (error.code === "NOT_FOUND") {
    return failure("FILE_NOT_FOUND", "The uploaded object was not found.")
  }
  return failure(
    "STORAGE_UNAVAILABLE",
    "The file storage operation failed.",
    error.retryable ?? false
  )
}

function convexFailure(error: unknown): { ok: false; error: FileApiError } {
  const message = error instanceof Error ? error.message : ""
  if (message.includes("File not found")) {
    return failure("FILE_NOT_FOUND", "The file was not found.")
  }
  if (message.includes("Invalid file state")) {
    return failure(
      "INVALID_FILE_STATE",
      "The file is not in the required state."
    )
  }
  if (message.includes("Not authenticated")) {
    return failure("NOT_AUTHENTICATED", "You must sign in to manage files.")
  }
  return failure("INTERNAL_ERROR", "The file operation failed.")
}

export const createFileUpload = createServerFn({ method: "POST" })
  .validator(createUploadSchema)
  .handler(async ({ data }) => {
    const clientResult = await authenticatedConvexClient()
    if (!clientResult.ok) return clientResult

    const storageResult = getObjectStorage()
    if (storageResult.isErr()) {
      return failure("CONFIGURATION_ERROR", storageResult.error.message)
    }

    const objectKey = `files/${crypto.randomUUID()}`
    let fileId: Id<"files">
    try {
      fileId = await clientResult.value.mutation(api.files.createPending, {
        objectKey,
        originalName: data.originalName,
        declaredContentType: data.contentType,
        declaredSize: data.size,
      })
    } catch (error) {
      return convexFailure(error)
    }

    const signed = await storageResult.value.signPut({
      key: objectKey,
      contentType: data.contentType,
      expiresInSeconds: UPLOAD_EXPIRY_SECONDS,
    })
    if (signed.isErr()) {
      try {
        await clientResult.value.mutation(api.files.markFailed, {
          fileId,
          failureCode: "SIGNING_FAILED",
        })
      } catch {
        // The pending record is intentionally left for bounded cleanup.
      }
      return storageFailure(signed.error)
    }

    return {
      ok: true,
      value: {
        fileId,
        uploadUrl: signed.value.url,
        method: "PUT" as const,
        requiredHeaders: signed.value.requiredHeaders,
        expiresAt: signed.value.expiresAt,
      },
    }
  })

export const completeFileUpload = createServerFn({ method: "POST" })
  .validator(fileOperationSchema)
  .handler(async ({ data }) => {
    const clientResult = await authenticatedConvexClient()
    if (!clientResult.ok) return clientResult
    const fileId = data.fileId as Id<"files">

    let file: Awaited<
      ReturnType<typeof clientResult.value.query<typeof api.files.getOwned>>
    >
    try {
      file = await clientResult.value.query(api.files.getOwned, { fileId })
    } catch (error) {
      return convexFailure(error)
    }
    if (!file) return failure("FILE_NOT_FOUND", "The file was not found.")
    if (file.status === "ready") return { ok: true, value: file }
    if (file.status !== "pending" && file.status !== "failed") {
      return failure(
        "INVALID_FILE_STATE",
        "The file is not awaiting upload completion."
      )
    }

    const storageResult = getObjectStorage()
    if (storageResult.isErr()) {
      return failure("CONFIGURATION_ERROR", storageResult.error.message)
    }
    const observed = await storageResult.value.headObject(file.objectKey)
    if (observed.isErr()) return storageFailure(observed.error)

    if (
      observed.value.size !== file.declaredSize ||
      observed.value.contentType !== file.declaredContentType
    ) {
      try {
        await clientResult.value.mutation(api.files.markFailed, {
          fileId,
          failureCode: "UPLOAD_MISMATCH",
        })
      } catch {
        // Preserve the primary mismatch response.
      }
      return failure(
        "UPLOAD_MISMATCH",
        "The uploaded file does not match its declaration."
      )
    }

    try {
      const ready = await clientResult.value.mutation(api.files.markReady, {
        fileId,
        verifiedContentType: observed.value.contentType,
        verifiedSize: observed.value.size,
        etag: observed.value.etag,
      })
      return { ok: true, value: ready }
    } catch (error) {
      return convexFailure(error)
    }
  })

export const getFileDownload = createServerFn({ method: "POST" })
  .validator(fileOperationSchema)
  .handler(async ({ data }) => {
    const clientResult = await authenticatedConvexClient()
    if (!clientResult.ok) return clientResult
    const fileId = data.fileId as Id<"files">

    try {
      const file = await clientResult.value.query(api.files.getOwned, {
        fileId,
      })
      if (!file) return failure("FILE_NOT_FOUND", "The file was not found.")
      if (file.status !== "ready") {
        return failure("INVALID_FILE_STATE", "The file is not ready.")
      }

      const storageResult = getObjectStorage()
      if (storageResult.isErr()) {
        return failure("CONFIGURATION_ERROR", storageResult.error.message)
      }
      const signed = await storageResult.value.signGet({
        key: file.objectKey,
        downloadName: file.originalName,
      })
      return signed.match(
        (request) => ({ ok: true as const, value: request }),
        storageFailure
      )
    } catch (error) {
      return convexFailure(error)
    }
  })

export const deleteFile = createServerFn({ method: "POST" })
  .validator(fileOperationSchema)
  .handler(async ({ data }) => {
    const clientResult = await authenticatedConvexClient()
    if (!clientResult.ok) return clientResult
    const fileId = data.fileId as Id<"files">

    try {
      const file = await clientResult.value.mutation(api.files.beginDelete, {
        fileId,
      })
      const storageResult = getObjectStorage()
      if (storageResult.isErr()) {
        return failure("CONFIGURATION_ERROR", storageResult.error.message)
      }
      const deleted = await storageResult.value.deleteObject({
        key: file.objectKey,
      })
      if (deleted.isErr()) {
        await clientResult.value.mutation(api.files.markFailed, {
          fileId,
          failureCode: "DELETE_FAILED",
        })
        return storageFailure(deleted.error)
      }
      await clientResult.value.mutation(api.files.completeDelete, { fileId })
      return { ok: true, value: null }
    } catch (error) {
      return convexFailure(error)
    }
  })

export const listMyFiles = createServerFn({ method: "GET" })
  .validator(listFilesSchema)
  .handler(async ({ data }) => {
    const clientResult = await authenticatedConvexClient()
    if (!clientResult.ok) return clientResult
    try {
      const page = await clientResult.value.query(api.files.listMine, {
        status: data.status,
        paginationOpts: {
          cursor: data.cursor,
          numItems: data.limit,
        },
      })
      return { ok: true, value: page }
    } catch (error) {
      return convexFailure(error)
    }
  })

export const cleanupMyIncompleteUploads = createServerFn({ method: "POST" })
  .validator(z.object({ limit: z.number().int().min(1).max(50).default(25) }))
  .handler(async ({ data }) => {
    const clientResult = await authenticatedConvexClient()
    if (!clientResult.ok) return clientResult
    const storageResult = getObjectStorage()
    if (storageResult.isErr()) {
      return failure("CONFIGURATION_ERROR", storageResult.error.message)
    }

    try {
      const [pendingPage, failedPage] = await Promise.all([
        clientResult.value.query(api.files.listMine, {
          status: "pending",
          paginationOpts: { cursor: null, numItems: data.limit },
        }),
        clientResult.value.query(api.files.listMine, {
          status: "failed",
          paginationOpts: { cursor: null, numItems: data.limit },
        }),
      ])
      const cutoff = Date.now() - INCOMPLETE_UPLOAD_MAX_AGE_MS
      let cleaned = 0
      for (const file of [...pendingPage.page, ...failedPage.page].slice(
        0,
        data.limit
      )) {
        if (file._creationTime > cutoff) continue
        const deleted = await storageResult.value.deleteObject({
          key: file.objectKey,
        })
        if (deleted.isErr()) continue
        await clientResult.value.mutation(api.files.discardIncomplete, {
          fileId: file._id,
        })
        cleaned += 1
      }
      return { ok: true, value: { cleaned } }
    } catch (error) {
      return convexFailure(error)
    }
  })
