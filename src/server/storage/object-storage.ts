import type { ResultAsync } from "neverthrow"

export type ObjectBody = Blob | Uint8Array | ReadableStream<Uint8Array>

export interface ObjectReference {
  key: string
}

export interface ObjectInfo extends ObjectReference {
  size: number
  contentType?: string
  etag?: string
  lastModified?: Date
  metadata: Record<string, string>
}

export interface PutObjectInput extends ObjectReference {
  body: ObjectBody
  contentType?: string
  contentLength?: number
  cacheControl?: string
  contentDisposition?: string
  metadata?: Record<string, string>
}

export interface GetObjectInput extends ObjectReference {
  range?: {
    start: number
    end?: number
  }
}

export interface ObjectDownload {
  body: ReadableStream<Uint8Array>
  object: ObjectInfo
}

export interface ListObjectsInput {
  prefix?: string
  delimiter?: string
  cursor?: string
  limit?: number
}

export interface ListObjectsResult {
  objects: ObjectInfo[]
  prefixes: string[]
  nextCursor?: string
}

export interface CopyObjectInput {
  sourceKey: string
  destinationKey: string
  metadata?: Record<string, string>
}

export interface DeleteObjectsInput {
  keys: string[]
}

export interface DeleteObjectFailure {
  key: string
  error: StorageError
}

export interface DeleteObjectsResult {
  deleted: string[]
  failed: DeleteObjectFailure[]
}

export type StorageError =
  | {
      code: "NOT_FOUND"
      key: string
      message: string
    }
  | {
      code: "ALREADY_EXISTS"
      key: string
      message: string
    }
  | {
      code: "ACCESS_DENIED"
      key?: string
      message: string
    }
  | {
      code: "INVALID_KEY"
      key: string
      message: string
    }
  | {
      code: "INVALID_CURSOR"
      message: string
    }
  | {
      code: "INVALID_RANGE"
      key: string
      message: string
    }
  | {
      code: "PRECONDITION_FAILED"
      key: string
      message: string
    }
  | {
      code: "PROVIDER_UNAVAILABLE"
      retryable: boolean
      message: string
    }
  | {
      code: "UNKNOWN"
      message: string
    }

/**
 * Provider-neutral object-storage port.
 *
 * Implementations translate these operations to a concrete provider and map
 * provider failures to StorageError. Composite workflows such as move,
 * rename, recursive deletion, and multi-object download belong in an
 * application service built on top of this port.
 */
export interface ObjectStorage {
  putObject: (input: PutObjectInput) => ResultAsync<ObjectInfo, StorageError>

  getObject: (
    input: GetObjectInput
  ) => ResultAsync<ObjectDownload, StorageError>

  listObjects: (
    input: ListObjectsInput
  ) => ResultAsync<ListObjectsResult, StorageError>

  copyObject: (input: CopyObjectInput) => ResultAsync<ObjectInfo, StorageError>

  deleteObject: (input: ObjectReference) => ResultAsync<void, StorageError>

  deleteObjects: (
    input: DeleteObjectsInput
  ) => ResultAsync<DeleteObjectsResult, StorageError>
}
