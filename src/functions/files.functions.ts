import { auth } from "@clerk/tanstack-react-start/server"
import { createServerFn } from "@tanstack/react-start"
import { ConvexHttpClient } from "convex/browser"
import { ResultAsync } from "neverthrow"
import { z } from "zod"

import { api } from "../../convex/_generated/api"
import type { Doc, Id } from "../../convex/_generated/dataModel"
import {
  FileWorkflowService,
  type FileMetadataPort,
  type FileRecord,
  type FileWorkflowError,
} from "@/server/files/file-workflow.server"
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
  ApiResult<ConvexHttpClient & { authToken: string }>
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
  return { ok: true, value: Object.assign(client, { authToken: token }) }
}

async function transition<T>(
  client: ConvexHttpClient & { authToken: string },
  input: Record<string, unknown>
): Promise<T> {
  const siteUrl = process.env.VITE_CONVEX_SITE_URL
  const serviceSecret = process.env.FILE_SERVICE_SECRET
  if (!siteUrl || !serviceSecret || serviceSecret.length < 32) {
    throw new Error("File transition service is not configured")
  }
  const response = await fetch(
    `${siteUrl.replace(/\/$/, "")}/internal/files/transition`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${client.authToken}`,
        "Content-Type": "application/json",
        "x-file-service-secret": serviceSecret,
      },
      body: JSON.stringify(input),
    }
  )
  if (!response.ok) throw new Error("File transition rejected")
  return (await response.json()) as T
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

function toFileRecord(file: Doc<"files">): FileRecord {
  return {
    id: file._id,
    objectKey: file.objectKey,
    originalName: file.originalName,
    declaredContentType: file.declaredContentType,
    declaredSize: file.declaredSize,
    verifiedSize: file.verifiedSize,
    status: file.status,
  }
}

function metadataPort(
  client: ConvexHttpClient & { authToken: string }
): FileMetadataPort {
  const metadataError = (): FileWorkflowError => ({ code: "METADATA_ERROR" })
  return {
    getOwned: (fileId) =>
      ResultAsync.fromPromise(
        client
          .query(api.files.getOwned, { fileId: fileId as Id<"files"> })
          .then((file) => (file ? toFileRecord(file) : null)),
        metadataError
      ),
    markReady: (fileId, object) =>
      ResultAsync.fromPromise(
        transition<Doc<"files">>(client, {
          operation: "markReady",
          fileId,
          verifiedContentType: object.contentType,
          verifiedSize: object.size,
          etag: object.etag,
        }).then(toFileRecord),
        metadataError
      ),
    markFailed: (fileId, failureCode) =>
      ResultAsync.fromPromise(
        transition<void>(client, {
          operation: "markFailed",
          fileId,
          failureCode,
        }),
        metadataError
      ),
    beginDelete: (fileId) =>
      ResultAsync.fromPromise(
        transition<Doc<"files">>(client, {
          operation: "beginDelete",
          fileId,
        }).then(toFileRecord),
        metadataError
      ),
    completeDelete: (fileId) =>
      ResultAsync.fromPromise(
        transition<void>(client, { operation: "completeDelete", fileId }),
        metadataError
      ),
  }
}

function workflowFailure(error: FileWorkflowError) {
  switch (error.code) {
    case "FILE_NOT_FOUND":
      return failure("FILE_NOT_FOUND", "The file was not found.")
    case "INVALID_FILE_STATE":
      return failure(
        "INVALID_FILE_STATE",
        "The file is not in the required state."
      )
    case "UPLOAD_MISMATCH":
      return failure(
        "UPLOAD_MISMATCH",
        "The uploaded file does not match its declaration."
      )
    case "STORAGE_ERROR":
      return storageFailure(error.error)
    case "METADATA_ERROR":
      return failure("INTERNAL_ERROR", "The file operation failed.")
  }
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

    let reservation: { fileId: Id<"files">; objectKey: string }
    try {
      reservation = await clientResult.value.mutation(api.files.createPending, {
        originalName: data.originalName,
        declaredContentType: data.contentType,
        declaredSize: data.size,
      })
    } catch (error) {
      return convexFailure(error)
    }

    const signed = await storageResult.value.signPut({
      key: reservation.objectKey,
      contentType: data.contentType,
      expiresInSeconds: UPLOAD_EXPIRY_SECONDS,
    })
    if (signed.isErr()) {
      try {
        await transition(clientResult.value, {
          operation: "markFailed",
          fileId: reservation.fileId,
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
        fileId: reservation.fileId,
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

    const storageResult = getObjectStorage()
    if (storageResult.isErr()) {
      return failure("CONFIGURATION_ERROR", storageResult.error.message)
    }
    const result = await new FileWorkflowService(
      metadataPort(clientResult.value),
      storageResult.value
    ).completeUpload(fileId)
    return result.match(
      (file) => ({ ok: true as const, value: file }),
      workflowFailure
    )
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

    const storageResult = getObjectStorage()
    if (storageResult.isErr()) {
      return failure("CONFIGURATION_ERROR", storageResult.error.message)
    }
    const result = await new FileWorkflowService(
      metadataPort(clientResult.value),
      storageResult.value
    ).deleteFile(fileId)
    return result.match(
      () => ({ ok: true as const, value: null }),
      workflowFailure
    )
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
        await transition(clientResult.value, {
          operation: "discardIncomplete",
          fileId: file._id,
        })
        cleaned += 1
      }
      return { ok: true, value: { cleaned } }
    } catch (error) {
      return convexFailure(error)
    }
  })
