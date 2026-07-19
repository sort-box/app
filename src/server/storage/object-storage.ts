import type { ResultAsync } from "neverthrow"

export interface ObjectReference {
  key: string
}

export interface ObjectInfo extends ObjectReference {
  /** The full size of the stored object, not the size of a returned range. */
  size: number
  contentType?: string
  etag?: string
  lastModified?: Date
  metadata: Record<string, string>
}

interface PutObjectBase extends ObjectReference {
  contentType?: string
  cacheControl?: string
  contentDisposition?: string
  metadata?: Record<string, string>
}

export type PutObjectInput =
  | (PutObjectBase & {
      body: Blob | Uint8Array
      /**
       * If provided, this must be a non-negative integer matching the body's
       * derived byte length.
       */
      contentLength?: number
    })
  | (PutObjectBase & {
      body: ReadableStream<Uint8Array>
      /**
       * Must be a non-negative integer matching the number of bytes emitted.
       * Adapters must not buffer the stream to infer its length.
       */
      contentLength: number
    })

export interface ObjectRange {
  /** Zero-based index of the first byte of the range. */
  start: number
  /** Zero-based index of the last byte of the range, inclusive. */
  endInclusive?: number
}

export interface GetObjectInput extends ObjectReference {
  range?: ObjectRange
}

export interface ObjectDownload {
  body: ReadableStream<Uint8Array>
  /** Metadata for the complete stored object. */
  object: ObjectInfo
  /** Number of bytes returned in body. */
  contentLength: number
  /** The resolved range returned by the provider; absent for a full download. */
  range?: Required<ObjectRange>
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

export type CopyMetadata =
  | {
      /** Preserve the source object's user-defined metadata. */
      mode: "copy"
    }
  | {
      /** Replace all user-defined metadata, including with an empty object. */
      mode: "replace"
      values: Record<string, string>
    }

export interface CopyObjectInput {
  sourceKey: string
  destinationKey: string
  /** Omission is equivalent to { mode: "copy" }. */
  metadata?: CopyMetadata
}

export interface DeleteObjectsInput {
  keys: string[]
}

export interface DeleteObjectFailure {
  key: string
  error: StorageError
}

export interface DeleteObjectsResult {
  /**
   * Keys confirmed absent after the operation. This includes keys that did not
   * exist when deletion started.
   */
  deleted: string[]
  failed: DeleteObjectFailure[]
}

/**
 * Expected storage failure with a provider-neutral, boundary-safe message.
 *
 * Messages must not contain raw SDK error text, credentials, bucket
 * configuration, response bodies, request IDs, stack traces, or signed values.
 */
export type StorageError =
  | {
      code: "NOT_FOUND"
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
      /**
       * The declared length is invalid or differs from the bytes in a buffer or
       * emitted by a stream.
       */
      code: "INVALID_CONTENT_LENGTH"
      key: string
      message: string
    }
  | {
      code: "INVALID_RANGE"
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

  /**
   * Copies an object. Identical source and destination keys are allowed only
   * with metadata mode "replace", which updates metadata without re-uploading
   * the body. Other identical-key copies return INVALID_KEY.
   */
  copyObject: (input: CopyObjectInput) => ResultAsync<ObjectInfo, StorageError>

  /** Idempotently deletes a key. A key that is already absent returns Ok. */
  deleteObject: (input: ObjectReference) => ResultAsync<void, StorageError>

  /**
   * Idempotently deletes every requested key. Missing keys are included in
   * deleted. Implementations must split requests internally when a provider
   * imposes a per-request limit.
   */
  deleteObjects: (
    input: DeleteObjectsInput
  ) => ResultAsync<DeleteObjectsResult, StorageError>
}
