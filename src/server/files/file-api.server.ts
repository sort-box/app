import { auth } from "@clerk/tanstack-react-start/server"
import { createMiddleware } from "@tanstack/react-start"
import { ConvexHttpClient } from "convex/browser"
import { ResultAsync } from "neverthrow"
import type { ZodType } from "zod"

import type { Doc, Id } from "../../../convex/_generated/dataModel"
import { getObjectStorage } from "../storage/storage.server"

export const MAX_FILE_SIZE = Math.floor(4.995 * 1024 ** 3)
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
  authToken: string
  getAuthToken?: () => Promise<string | null>
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
        fileApi: {
          authToken: token,
          getAuthToken: async () => {
            const latestAuth = await auth()
            return await latestAuth.getToken()
          },
          client,
          requestId,
          userId,
        } satisfies FileApiContext,
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
  if (message.includes("DIRECTORY_NOT_EMPTY"))
    return error("INVALID_FILE_STATE", "The folder is not empty.")
  if (message.includes("DIRECTORY_TOO_LARGE"))
    return error(
      "INVALID_INPUT",
      "This folder contains too many items to move."
    )
  if (message.includes("QUOTA_EXCEEDED"))
    return error("QUOTA_EXCEEDED", "The storage quota would be exceeded.")
  if (message.includes("INVALID_FILE_STATE"))
    return error("INVALID_FILE_STATE", "The file is not in the required state.")
  if (
    message.includes("INVALID_INPUT") ||
    message.includes("UPLOAD_MISMATCH") ||
    message.includes("Failed to parse cursor")
  ) {
    return error("INVALID_INPUT", "The file operation input is invalid.")
  }
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

export type PublicFile = {
  id: string
  createdAt: number
  path: string
  parentPath: string
  basename: string
  contentType: string
  size: number
  etag?: string
  status: "ready"
  completedAt: number
  embedding: PublicEmbeddingState
}

export type PublicEmbeddingState = {
  status:
    | "not_indexed"
    | "queued"
    | "extracting"
    | "embedding"
    | "ready"
    | "failed"
    | "unsupported"
  version?: string
  errorCode?:
    | "UNSUPPORTED_TYPE"
    | "OCR_REQUIRED"
    | "TOO_LARGE"
    | "NO_TEXT"
    | "ENCRYPTED"
    | "EXTRACTION_FAILED"
    | "EMBEDDING_FAILED"
  updatedAt?: number
}

export type PublicFileEntry = {
  _id: string
  _creationTime: number
  path: string
  parentPath: string
  basename: string
  kind: "file" | "directory"
  fileId?: string
  status: "ready"
  embedding?: PublicEmbeddingState
}

type ListedFileEntry = Doc<"fileEntries"> & {
  embeddingStatus?: PublicEmbeddingState["status"]
  embeddingVersion?: string
  embeddingErrorCode?: PublicEmbeddingState["errorCode"]
  embeddingUpdatedAt?: number
}

function publicEmbedding(file: {
  embeddingStatus?: PublicEmbeddingState["status"]
  embeddingVersion?: string
  embeddingErrorCode?: PublicEmbeddingState["errorCode"]
  embeddingUpdatedAt?: number
}): PublicEmbeddingState {
  return {
    status: file.embeddingStatus ?? "not_indexed",
    ...(file.embeddingVersion ? { version: file.embeddingVersion } : {}),
    ...(file.embeddingErrorCode ? { errorCode: file.embeddingErrorCode } : {}),
    ...(file.embeddingUpdatedAt ? { updatedAt: file.embeddingUpdatedAt } : {}),
  }
}

export function toPublicFileEntry(entry: ListedFileEntry): PublicFileEntry {
  return {
    _id: entry._id,
    _creationTime: entry._creationTime,
    path: entry.path,
    parentPath: entry.parentPath,
    basename: entry.basename,
    kind: entry.kind,
    fileId: entry.fileId,
    status: "ready",
    ...(entry.kind === "file" ? { embedding: publicEmbedding(entry) } : {}),
  }
}

export function toPublicFile(file: Doc<"files">): PublicFile {
  if (file.status !== "ready") throw new Error("File is not ready")
  return {
    id: file._id,
    createdAt: file._creationTime,
    path: file.path ?? `/${file.originalName}`,
    parentPath: file.parentPath ?? "/",
    basename: file.basename ?? file.originalName,
    contentType: file.verifiedContentType ?? file.declaredContentType,
    size: file.verifiedSize ?? file.declaredSize,
    etag: file.etag,
    status: "ready",
    completedAt: file.completedAt ?? file._creationTime,
    embedding: publicEmbedding(file),
  }
}

export class FileRestService {
  constructor(private readonly context: FileApiContext) {}

  private async privileged<T>(
    operation: string,
    input: Record<string, unknown> = {}
  ): Promise<FileApiResult<T>> {
    const siteUrl = import.meta.env.VITE_CONVEX_SITE_URL
    const serviceSecret = process.env.FILE_SERVICE_SECRET
    if (!siteUrl || !serviceSecret || serviceSecret.length < 32) {
      return error(
        "CONFIGURATION_ERROR",
        "The trusted file service is not configured."
      )
    }
    const authToken =
      (await this.context.getAuthToken?.()) ?? this.context.authToken
    return ResultAsync.fromPromise(
      fetch(`${siteUrl.replace(/\/$/, "")}/internal/files/rest`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
          "x-file-service-secret": serviceSecret,
        },
        body: JSON.stringify({ operation, ...input }),
      }).then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            code?: unknown
          } | null
          throw new Error(
            typeof body?.code === "string" ? body.code : "TRANSITION_REJECTED"
          )
        }
        return (await response.json()) as T
      }),
      mapFailure
    ).match(
      (value) => ({ ok: true as const, value }),
      (failure) => failure
    )
  }

  async rateLimit(bucket: "read" | "mutation" | "upload") {
    const result = await this.privileged<{
      allowed: boolean
      retryAfter: number
    }>("consumeRateLimit", { bucket })
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
    const reservation = await this.privileged<{
      fileId: Id<"files">
      objectKey: string
    }>("createUpload", {
      ...parsed.value,
      contentType: input.contentType,
      size: input.size,
    })
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
      await this.privileged("failPending", {
        fileId: reservation.value.fileId,
        failureCode: "SIGNING_FAILED",
      })
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

  async complete(fileId: string): Promise<FileApiResult<PublicFile>> {
    const file = await this.privileged<Doc<"files"> | null>("getOwned", {
      fileId: fileId as Id<"files">,
    })
    if (!file.ok) return file
    if (!file.value) return error("FILE_NOT_FOUND", "The file was not found.")
    if (file.value.status === "ready") {
      return { ok: true, value: toPublicFile(file.value) }
    }
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
      await this.privileged("failPending", {
        fileId: file.value._id,
        failureCode: "UPLOAD_MISMATCH",
      })
      return error("INVALID_INPUT", "The uploaded object does not match.")
    }
    const completed = await this.privileged<Doc<"files">>("completeUpload", {
      fileId: file.value._id,
      verifiedContentType: object.value.contentType!,
      verifiedSize: object.value.size,
      etag: object.value.etag,
    })
    return completed.ok
      ? { ok: true, value: toPublicFile(completed.value) }
      : completed
  }

  async download(fileId: string): Promise<FileApiResult<unknown>> {
    const file = await this.privileged<Doc<"files"> | null>("getOwned", {
      fileId: fileId as Id<"files">,
    })
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
  }): Promise<
    FileApiResult<{
      page: Array<PublicFileEntry>
      isDone: boolean
      continueCursor: string
    }>
  > {
    const path = parseDirectoryPath(input.path)
    if (!path.ok) return path
    const result = await this.privileged<{
      page: Array<Doc<"fileEntries">>
      isDone: boolean
      continueCursor: string
    }>("list", {
      parentPath: path.value,
      recursive: input.recursive,
      cursor: input.cursor,
      limit: input.limit,
    })
    if (!result.ok) return result
    return {
      ok: true,
      value: {
        page: result.value.page.map(toPublicFileEntry),
        isDone: result.value.isDone,
        continueCursor: result.value.continueCursor,
      },
    }
  }

  async move(
    fileId: string,
    destination: string
  ): Promise<FileApiResult<PublicFile>> {
    const path = parseFilePath(destination)
    if (!path.ok) return path
    const moved = await this.privileged<Doc<"files">>("move", {
      fileId: fileId as Id<"files">,
      ...path.value,
    })
    return moved.ok ? { ok: true, value: toPublicFile(moved.value) } : moved
  }

  async retryEmbedding(fileId: string): Promise<FileApiResult<PublicFile>> {
    const retried = await this.privileged<Doc<"files">>("retryEmbedding", {
      fileId: fileId as Id<"files">,
    })
    return retried.ok
      ? { ok: true, value: toPublicFile(retried.value) }
      : retried
  }

  async createFolder(path: string): Promise<FileApiResult<PublicFileEntry>> {
    const parsed = parseFilePath(path)
    if (!parsed.ok) return parsed
    const created = await this.privileged<Doc<"fileEntries">>(
      "createDirectory",
      parsed.value
    )
    return created.ok
      ? { ok: true, value: toPublicFileEntry(created.value) }
      : created
  }

  async moveFolder(
    path: string,
    destinationPath: string
  ): Promise<FileApiResult<PublicFileEntry>> {
    const source = parseFilePath(path)
    if (!source.ok) return source
    const destination = parseFilePath(destinationPath)
    if (!destination.ok) return destination
    const moved = await this.privileged<Doc<"fileEntries">>("moveDirectory", {
      sourcePath: source.value.path,
      ...destination.value,
    })
    return moved.ok
      ? { ok: true, value: toPublicFileEntry(moved.value) }
      : moved
  }

  async deleteFolder(path: string): Promise<FileApiResult<null>> {
    const parsed = parseFilePath(path)
    if (!parsed.ok) return parsed
    const deleted = await this.privileged<null>("deleteDirectory", {
      path: parsed.value.path,
    })
    return deleted.ok ? { ok: true, value: null } : deleted
  }

  async copy(
    fileId: string,
    destination: string
  ): Promise<FileApiResult<PublicFile>> {
    const path = parseFilePath(destination)
    if (!path.ok) return path
    const reserved = await this.privileged<{
      fileId: Id<"files">
      sourceObjectKey: string
      destinationObjectKey: string
    }>("reserveCopy", {
      sourceFileId: fileId as Id<"files">,
      ...path.value,
    })
    if (!reserved.ok) return reserved
    const storage = getObjectStorage()
    if (storage.isErr())
      return error("CONFIGURATION_ERROR", storage.error.message)
    const copied = await storage.value.copyObject({
      sourceKey: reserved.value.sourceObjectKey,
      destinationKey: reserved.value.destinationObjectKey,
    })
    if (copied.isErr()) {
      await this.privileged("failPending", {
        fileId: reserved.value.fileId,
        failureCode: "COPY_FAILED",
      })
      return storageFailure()
    }
    const completed = await this.privileged<Doc<"files">>("completeCopy", {
      fileId: reserved.value.fileId,
      verifiedContentType:
        copied.value.contentType ?? "application/octet-stream",
      verifiedSize: copied.value.size,
      etag: copied.value.etag,
    })
    return completed.ok
      ? { ok: true, value: toPublicFile(completed.value) }
      : completed
  }

  async delete(fileId: string): Promise<FileApiResult<null>> {
    const begun = await this.privileged<{
      _id: Id<"files">
      objectKey: string
    }>("beginDelete", { fileId: fileId as Id<"files"> })
    if (!begun.ok) return begun
    const storage = getObjectStorage()
    if (storage.isErr())
      return error("CONFIGURATION_ERROR", storage.error.message)
    const deleted = await storage.value.deleteObject({
      key: begun.value.objectKey,
    })
    if (deleted.isErr()) {
      await this.privileged("cancelDelete", { fileId: begun.value._id })
      return storageFailure()
    }
    const completed = await this.privileged<null>("completeDelete", {
      fileId: begun.value._id,
    })
    return completed.ok ? { ok: true, value: null } : completed
  }
}
