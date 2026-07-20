import { auth } from "@clerk/tanstack-react-start/server"
import { createMiddleware } from "@tanstack/react-start"
import { ConvexHttpClient } from "convex/browser"
import { ResultAsync } from "neverthrow"
import type { ZodType } from "zod"

import { api } from "../../../convex/_generated/api"
import type { Id } from "../../../convex/_generated/dataModel"
import { getObjectStorage } from "../storage/storage.server"

export const MAX_FILE_SIZE = Math.floor(4.995 * 1024 ** 3)
const QUOTA_BYTES = 10 * 1024 ** 3
const UPLOAD_EXPIRY_SECONDS = 600
const DOWNLOAD_EXPIRY_SECONDS = 60
const MAX_JSON_BYTES = 16 * 1024

export type FileApiError = {
  code:
    | "NOT_AUTHENTICATED"
    | "FORBIDDEN"
    | "INVALID_INPUT"
    | "FILE_NOT_FOUND"
    | "INVALID_FILE_STATE"
    | "PATH_CONFLICT"
    | "QUOTA_EXCEEDED"
    | "RATE_LIMITED"
    | "STORAGE_UNAVAILABLE"
    | "CONFIGURATION_ERROR"
    | "INTERNAL_ERROR"
  message: string
  retryable: boolean
  retryAfter?: number
}

type Failure = { ok: false; error: FileApiError }
type Success<T> = { ok: true; value: T }
export type FileApiResult<T> = Success<T> | Failure

export type FileApiContext = {
  client: ConvexHttpClient
  requestId: string
  userId: string
}

function error(
  code: FileApiError["code"],
  message: string,
  retryable = false,
  retryAfter?: number
): Failure {
  return { ok: false, error: { code, message, retryable, retryAfter } }
}

function configuredOrigin(request: Request): string | null {
  const configured = process.env.FILE_API_ORIGIN
  if (!configured) {
    return import.meta.env.DEV ? new URL(request.url).origin : null
  }
  try {
    const origin = new URL(configured)
    if (
      origin.origin !== configured.replace(/\/$/, "") ||
      (origin.protocol !== "https:" &&
        !["localhost", "127.0.0.1"].includes(origin.hostname))
    ) {
      return null
    }
    return origin.origin
  } catch {
    return null
  }
}

function sameOrigin(request: Request): boolean {
  if (request.method === "GET" || request.method === "HEAD") return true
  const expected = configuredOrigin(request)
  if (!expected) return false
  const fetchSite = request.headers.get("sec-fetch-site")
  if (fetchSite && fetchSite !== "same-origin") return false
  const presented =
    request.headers.get("origin") ??
    (() => {
      const referer = request.headers.get("referer")
      return referer ? new URL(referer).origin : null
    })()
  return presented === expected
}

export const fileApiMiddleware = createMiddleware().server(
  async ({ next, request }) => {
    const requestId = crypto.randomUUID()
    if (!sameOrigin(request)) {
      return apiErrorResponse(
        requestId,
        error("FORBIDDEN", "The request origin is not allowed.").error
      )
    }
    const { userId, getToken } = await auth()
    if (!userId) {
      return apiErrorResponse(
        requestId,
        error("NOT_AUTHENTICATED", "Authentication is required.").error
      )
    }
    const token = await getToken()
    const convexUrl = import.meta.env.VITE_CONVEX_URL
    if (!token || !convexUrl) {
      return apiErrorResponse(
        requestId,
        error(
          "CONFIGURATION_ERROR",
          "The authenticated file service is not configured."
        ).error
      )
    }
    const client = new ConvexHttpClient(convexUrl)
    client.setAuth(token)
    const result = await next({
      context: {
        fileApi: { client, requestId, userId } satisfies FileApiContext,
      },
    })
    if (result instanceof Response) {
      result.headers.set("Cache-Control", "no-store")
      result.headers.set("X-Content-Type-Options", "nosniff")
      result.headers.set("Referrer-Policy", "no-referrer")
    }
    return result
  }
)

export function apiResponse<T>(context: FileApiContext, data: T, status = 200) {
  return Response.json(
    { data, requestId: context.requestId },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    }
  )
}

export function apiErrorResponse(requestId: string, value: FileApiError) {
  const statuses: Record<FileApiError["code"], number> = {
    NOT_AUTHENTICATED: 401,
    FORBIDDEN: 403,
    INVALID_INPUT: 400,
    FILE_NOT_FOUND: 404,
    INVALID_FILE_STATE: 409,
    PATH_CONFLICT: 409,
    QUOTA_EXCEEDED: 413,
    RATE_LIMITED: 429,
    STORAGE_UNAVAILABLE: 503,
    CONFIGURATION_ERROR: 503,
    INTERNAL_ERROR: 500,
  }
  return Response.json(
    { error: value, requestId },
    {
      status: statuses[value.code],
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        ...(value.retryAfter
          ? { "Retry-After": String(value.retryAfter) }
          : {}),
      },
    }
  )
}

export function resultResponse<T>(
  context: FileApiContext,
  result: FileApiResult<T>,
  status = 200
) {
  return result.ok
    ? apiResponse(context, result.value, status)
    : apiErrorResponse(context.requestId, result.error)
}

export async function jsonBody<T>(
  request: Request,
  schema: ZodType<T>
): Promise<FileApiResult<T>> {
  const contentType = request.headers.get("content-type")?.split(";")[0]
  if (contentType !== "application/json") {
    return error("INVALID_INPUT", "Content-Type must be application/json.")
  }
  const declared = Number(request.headers.get("content-length") ?? 0)
  if (declared > MAX_JSON_BYTES) {
    return error("INVALID_INPUT", "The request body is too large.")
  }
  try {
    const text = await request.text()
    if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) {
      return error("INVALID_INPUT", "The request body is too large.")
    }
    const parsed = schema.safeParse(JSON.parse(text))
    return parsed.success
      ? { ok: true, value: parsed.data }
      : error("INVALID_INPUT", "The request body is invalid.")
  } catch {
    return error("INVALID_INPUT", "The request body is invalid.")
  }
}

const encoder = new TextEncoder()

export function parseFilePath(input: string): FileApiResult<{
  path: string
  parentPath: string
  basename: string
}> {
  const path = input.normalize("NFC")
  if (
    !path.startsWith("/") ||
    path === "/" ||
    path.endsWith("/") ||
    path.includes("\\") ||
    Array.from(path).some((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127
    }) ||
    encoder.encode(path).byteLength > 1024
  ) {
    return error("INVALID_INPUT", "The file path is invalid.")
  }
  const segments = path.slice(1).split("/")
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        encoder.encode(segment).byteLength > 255
    )
  ) {
    return error("INVALID_INPUT", "The file path is invalid.")
  }
  return {
    ok: true,
    value: {
      path,
      basename: segments.at(-1)!,
      parentPath:
        segments.length === 1 ? "/" : `/${segments.slice(0, -1).join("/")}`,
    },
  }
}

export function parseDirectoryPath(input: string): FileApiResult<string> {
  if (!input) return error("INVALID_INPUT", "The directory path is invalid.")
  if (input === "/") return { ok: true, value: "/" }
  const file = parseFilePath(`${input.replace(/\/$/, "")}/placeholder`)
  return file.ok ? { ok: true, value: file.value.parentPath } : file
}

function mapFailure(value: unknown): Failure {
  const message = value instanceof Error ? value.message : String(value)
  if (message.includes("FILE_NOT_FOUND"))
    return error("FILE_NOT_FOUND", "The file was not found.")
  if (message.includes("PATH_CONFLICT"))
    return error("PATH_CONFLICT", "The destination path already exists.")
  if (message.includes("QUOTA_EXCEEDED"))
    return error("QUOTA_EXCEEDED", "The storage quota would be exceeded.")
  if (message.includes("INVALID_FILE_STATE"))
    return error("INVALID_FILE_STATE", "The file is not in the required state.")
  if (message.includes("NOT_AUTHENTICATED"))
    return error("NOT_AUTHENTICATED", "Authentication is required.")
  return error("INTERNAL_ERROR", "The file operation failed.")
}

function storageFailure(): Failure {
  return error(
    "STORAGE_UNAVAILABLE",
    "The file storage operation failed.",
    true
  )
}

async function convex<T>(promise: Promise<T>): Promise<FileApiResult<T>> {
  return ResultAsync.fromPromise(promise, mapFailure).match(
    (value) => ({ ok: true as const, value }),
    (failure) => failure
  )
}

export class FileRestService {
  constructor(private readonly context: FileApiContext) {}

  async rateLimit(bucket: "read" | "mutation" | "upload") {
    const limit = bucket === "read" ? 60 : bucket === "mutation" ? 20 : 10
    const result = await convex(
      this.context.client.mutation(api.fileRest.consumeRateLimit, {
        bucket,
        limit,
      })
    )
    if (!result.ok) return result
    return result.value.allowed
      ? ({ ok: true, value: null } as const)
      : error(
          "RATE_LIMITED",
          "Too many file requests.",
          true,
          result.value.retryAfter
        )
  }

  async createUpload(input: {
    path: string
    contentType: string
    size: number
  }): Promise<FileApiResult<unknown>> {
    const parsed = parseFilePath(input.path)
    if (!parsed.ok) return parsed
    const reservation = await convex(
      this.context.client.mutation(api.fileRest.createUpload, {
        ...parsed.value,
        contentType: input.contentType,
        size: input.size,
        quota: QUOTA_BYTES,
      })
    )
    if (!reservation.ok) return reservation
    const storage = getObjectStorage()
    if (storage.isErr())
      return error("CONFIGURATION_ERROR", storage.error.message)
    const signed = await storage.value.signPut({
      key: reservation.value.objectKey,
      contentType: input.contentType,
      contentLength: input.size,
      expiresInSeconds: UPLOAD_EXPIRY_SECONDS,
    })
    if (signed.isErr()) {
      await this.context.client
        .mutation(api.fileRest.failPending, {
          fileId: reservation.value.fileId,
          failureCode: "SIGNING_FAILED",
        })
        .catch(() => undefined)
      return storageFailure()
    }
    return {
      ok: true,
      value: {
        fileId: reservation.value.fileId,
        upload: { ...signed.value, method: "PUT" as const },
      },
    }
  }

  async complete(fileId: string): Promise<FileApiResult<unknown>> {
    const file = await convex(
      this.context.client.query(api.fileRest.getOwned, {
        fileId: fileId as Id<"files">,
      })
    )
    if (!file.ok) return file
    if (!file.value) return error("FILE_NOT_FOUND", "The file was not found.")
    if (file.value.status === "ready") return { ok: true, value: file.value }
    if (file.value.status !== "pending" || file.value.operation !== "upload") {
      return error("INVALID_FILE_STATE", "The file is not pending upload.")
    }
    const storage = getObjectStorage()
    if (storage.isErr())
      return error("CONFIGURATION_ERROR", storage.error.message)
    const object = await storage.value.headObject(file.value.objectKey)
    if (object.isErr()) return storageFailure()
    if (
      object.value.size !== file.value.declaredSize ||
      object.value.contentType !== file.value.declaredContentType
    ) {
      await storage.value.deleteObject({ key: file.value.objectKey })
      await this.context.client.mutation(api.fileRest.failPending, {
        fileId: file.value._id,
        failureCode: "UPLOAD_MISMATCH",
      })
      return error("INVALID_INPUT", "The uploaded object does not match.")
    }
    return convex(
      this.context.client.mutation(api.fileRest.completeUpload, {
        fileId: file.value._id,
        verifiedContentType: object.value.contentType!,
        verifiedSize: object.value.size,
        etag: object.value.etag,
      })
    )
  }

  async download(fileId: string): Promise<FileApiResult<unknown>> {
    const file = await convex(
      this.context.client.query(api.fileRest.getOwned, {
        fileId: fileId as Id<"files">,
      })
    )
    if (!file.ok) return file
    if (!file.value) return error("FILE_NOT_FOUND", "The file was not found.")
    if (file.value.status !== "ready") {
      return error("INVALID_FILE_STATE", "The file is not ready.")
    }
    const storage = getObjectStorage()
    if (storage.isErr())
      return error("CONFIGURATION_ERROR", storage.error.message)
    const signed = await storage.value.signGet({
      key: file.value.objectKey,
      downloadName: file.value.basename ?? file.value.originalName,
      expiresInSeconds: DOWNLOAD_EXPIRY_SECONDS,
    })
    return signed.isOk() ? { ok: true, value: signed.value } : storageFailure()
  }

  async list(input: {
    path: string
    recursive: boolean
    cursor: string | null
    limit: number
  }): Promise<FileApiResult<unknown>> {
    const path = parseDirectoryPath(input.path)
    if (!path.ok) return path
    return convex(
      this.context.client.query(api.fileRest.list, {
        parentPath: path.value,
        recursive: input.recursive,
        paginationOpts: { cursor: input.cursor, numItems: input.limit },
      })
    )
  }

  async move(fileId: string, destination: string) {
    const path = parseFilePath(destination)
    if (!path.ok) return path
    return convex(
      this.context.client.mutation(api.fileRest.move, {
        fileId: fileId as Id<"files">,
        ...path.value,
      })
    )
  }

  async copy(fileId: string, destination: string) {
    const path = parseFilePath(destination)
    if (!path.ok) return path
    const reserved = await convex(
      this.context.client.mutation(api.fileRest.reserveCopy, {
        sourceFileId: fileId as Id<"files">,
        ...path.value,
        quota: QUOTA_BYTES,
      })
    )
    if (!reserved.ok) return reserved
    const storage = getObjectStorage()
    if (storage.isErr())
      return error("CONFIGURATION_ERROR", storage.error.message)
    const copied = await storage.value.copyObject({
      sourceKey: reserved.value.sourceObjectKey,
      destinationKey: reserved.value.destinationObjectKey,
    })
    if (copied.isErr()) {
      await this.context.client
        .mutation(api.fileRest.failPending, {
          fileId: reserved.value.fileId,
          failureCode: "COPY_FAILED",
        })
        .catch(() => undefined)
      return storageFailure()
    }
    return convex(
      this.context.client.mutation(api.fileRest.completeCopy, {
        fileId: reserved.value.fileId,
        verifiedContentType:
          copied.value.contentType ?? "application/octet-stream",
        verifiedSize: copied.value.size,
        etag: copied.value.etag,
      })
    )
  }

  async delete(fileId: string): Promise<FileApiResult<null>> {
    const begun = await convex(
      this.context.client.mutation(api.fileRest.beginDelete, {
        fileId: fileId as Id<"files">,
      })
    )
    if (!begun.ok) return begun
    const storage = getObjectStorage()
    if (storage.isErr())
      return error("CONFIGURATION_ERROR", storage.error.message)
    const deleted = await storage.value.deleteObject({
      key: begun.value.objectKey,
    })
    if (deleted.isErr()) {
      await this.context.client
        .mutation(api.fileRest.cancelDelete, { fileId: begun.value._id })
        .catch(() => undefined)
      return storageFailure()
    }
    const completed = await convex(
      this.context.client.mutation(api.fileRest.completeDelete, {
        fileId: begun.value._id,
      })
    )
    return completed.ok ? { ok: true, value: null } : completed
  }
}
