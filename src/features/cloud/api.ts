export type FileEntry = {
  _id: string
  _creationTime: number
  path: string
  parentPath: string
  basename: string
  kind: "file" | "directory"
  fileId?: string
}

export type FileListPage = {
  page: Array<FileEntry>
  isDone: boolean
  continueCursor: string
}

export type FileApiErrorCode =
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

export class FileApiError extends Error {
  constructor(
    readonly code: FileApiErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly retryAfter?: number
  ) {
    super(message)
    this.name = "FileApiError"
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (response.status === 204) return null as T
  const body = (await response.json().catch(() => null)) as
    | { data: T }
    | {
        error: {
          code: FileApiErrorCode
          message: string
          retryable: boolean
          retryAfter?: number
        }
      }
    | null
  if (!response.ok || !body || "error" in body) {
    const error = body && "error" in body ? body.error : null
    throw new FileApiError(
      error?.code ?? "INTERNAL_ERROR",
      error?.message ?? "The file service is unavailable.",
      error?.retryable ?? false,
      error?.retryAfter
    )
  }
  return body.data
}

const maxRateLimitRetries = 3

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Like `request`, but waits out RATE_LIMITED responses using the
 * server-provided retry delay so bulk uploads pace themselves instead of
 * failing.
 */
async function requestPaced<T>(
  url: string,
  init: RequestInit | undefined,
  onRateLimit?: (retryAfterSeconds: number) => void
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await request<T>(url, init)
    } catch (error) {
      if (
        !(error instanceof FileApiError) ||
        error.code !== "RATE_LIMITED" ||
        attempt >= maxRateLimitRetries
      ) {
        throw error
      }
      const seconds = Math.min(error.retryAfter ?? 15, 90)
      onRateLimit?.(seconds)
      await sleep(seconds * 1000 + Math.random() * 500)
    }
  }
}

export function listFiles(input: {
  path: string
  cursor?: string | null
}): Promise<FileListPage> {
  const params = new URLSearchParams({ path: input.path, limit: "50" })
  if (input.cursor) params.set("cursor", input.cursor)
  return request(`/api/files?${params}`)
}

export function moveFile(fileId: string, path: string): Promise<unknown> {
  return request(`/api/files/${fileId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  })
}

export function deleteFile(fileId: string): Promise<null> {
  return request(`/api/files/${fileId}`, { method: "DELETE" })
}

export function createDownload(fileId: string): Promise<{ url: string }> {
  return request(`/api/files/${fileId}/download`)
}

type UploadTicket = {
  fileId: string
  upload: {
    url: string
    method: "PUT"
    expiresAt: number
    requiredHeaders: Record<string, string>
  }
}

export async function uploadFile(
  path: string,
  file: File,
  options?: { onRateLimit?: (retryAfterSeconds: number) => void }
): Promise<void> {
  const contentType = file.type || "application/octet-stream"
  const ticket = await requestPaced<UploadTicket>(
    "/api/files/uploads",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, contentType, size: file.size }),
    },
    options?.onRateLimit
  )
  let stored: Response
  try {
    stored = await fetch(ticket.upload.url, {
      method: ticket.upload.method,
      headers: ticket.upload.requiredHeaders,
      body: file,
    })
  } catch (cause) {
    console.error("File storage PUT was blocked by the browser", cause)
    throw new FileApiError(
      "STORAGE_UNAVAILABLE",
      "The upload could not reach file storage.",
      true
    )
  }
  if (!stored.ok) {
    throw new FileApiError("STORAGE_UNAVAILABLE", "The upload failed.", true)
  }
  await requestPaced(
    `/api/files/${ticket.fileId}/complete`,
    { method: "POST" },
    options?.onRateLimit
  )
}

export function joinPath(directory: string, basename: string): string {
  return directory === "/" ? `/${basename}` : `${directory}/${basename}`
}
