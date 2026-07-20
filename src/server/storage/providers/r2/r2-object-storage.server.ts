import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { ResultAsync, errAsync } from "neverthrow"

import type {
  CopyObjectInput,
  DeleteObjectsResult,
  GetObjectInput,
  ListObjectsInput,
  ObjectDownload,
  ObjectInfo,
  ObjectStorage,
  PutObjectInput,
  StorageError,
} from "../../object-storage"
import type {
  ObjectStorageSigner,
  SignedObjectRequest,
} from "../../object-storage-signer"

const MAX_DELETE_BATCH = 1_000
const DEFAULT_EXPIRY_SECONDS = 600
const MAX_EXPIRY_SECONDS = 604_799

class ContentLengthMismatchError extends Error {}

function safeMessage(code: StorageError["code"]): string {
  switch (code) {
    case "NOT_FOUND":
      return "The requested object was not found."
    case "ACCESS_DENIED":
      return "Access to object storage was denied."
    case "INVALID_KEY":
      return "The object key is invalid."
    case "INVALID_CURSOR":
      return "The object listing cursor is invalid."
    case "INVALID_CONTENT_LENGTH":
      return "The declared content length is invalid."
    case "INVALID_RANGE":
      return "The requested object range is invalid."
    case "PROVIDER_UNAVAILABLE":
      return "Object storage is temporarily unavailable."
    case "UNKNOWN":
      return "The object storage operation failed."
  }
}

function mapStorageError(error: unknown, key?: string): StorageError {
  if (error instanceof ContentLengthMismatchError && key) {
    return {
      code: "INVALID_CONTENT_LENGTH",
      key,
      message: safeMessage("INVALID_CONTENT_LENGTH"),
    }
  }

  const value =
    typeof error === "object" && error !== null
      ? (error as { name?: string; $metadata?: { httpStatusCode?: number } })
      : {}
  const name = value.name
  const status = value.$metadata?.httpStatusCode

  if ((name === "NoSuchKey" || name === "NotFound" || status === 404) && key) {
    return { code: "NOT_FOUND", key, message: safeMessage("NOT_FOUND") }
  }
  if (name === "AccessDenied" || status === 401 || status === 403) {
    return { code: "ACCESS_DENIED", key, message: safeMessage("ACCESS_DENIED") }
  }
  if (name === "InvalidArgument" && key) {
    return { code: "INVALID_KEY", key, message: safeMessage("INVALID_KEY") }
  }
  if (name === "InvalidRange" || status === 416) {
    return {
      code: "INVALID_RANGE",
      key: key ?? "",
      message: safeMessage("INVALID_RANGE"),
    }
  }
  if (
    name === "InvalidToken" ||
    name === "InvalidContinuationToken" ||
    name === "InvalidCursor"
  ) {
    return { code: "INVALID_CURSOR", message: safeMessage("INVALID_CURSOR") }
  }
  if (status === 429 || (status !== undefined && status >= 500)) {
    return {
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
      message: safeMessage("PROVIDER_UNAVAILABLE"),
    }
  }
  return { code: "UNKNOWN", message: safeMessage("UNKNOWN") }
}

function normalizeEtag(etag: string | undefined): string | undefined {
  return etag?.replace(/^"|"$/g, "")
}

function objectInfo(
  key: string,
  value: {
    ContentLength?: number
    ContentType?: string
    ETag?: string
    LastModified?: Date
    Metadata?: Record<string, string>
    Size?: number
  }
): ObjectInfo {
  return {
    key,
    size: value.ContentLength ?? value.Size ?? 0,
    contentType: value.ContentType,
    etag: normalizeEtag(value.ETag),
    lastModified: value.LastModified,
    metadata: value.Metadata ?? {},
  }
}

function validateExpiry(value = DEFAULT_EXPIRY_SECONDS): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_EXPIRY_SECONDS) {
    throw new RangeError("Invalid presigned URL expiry.")
  }
  return value
}

function encodeCopySource(bucket: string, key: string): string {
  return `${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`
}

function toWebStream(body: unknown): ReadableStream<Uint8Array> {
  if (
    typeof body === "object" &&
    body !== null &&
    "transformToWebStream" in body
  ) {
    return (
      body as { transformToWebStream: () => ReadableStream<Uint8Array> }
    ).transformToWebStream()
  }
  if (body instanceof ReadableStream) return body
  throw new TypeError("R2 returned an unsupported response body.")
}

function checkedBody(input: PutObjectInput): PutObjectInput["body"] {
  const derivedLength =
    input.body instanceof Blob
      ? input.body.size
      : input.body instanceof Uint8Array
        ? input.body.byteLength
        : undefined

  if (
    (input.contentLength !== undefined &&
      (!Number.isInteger(input.contentLength) || input.contentLength < 0)) ||
    (derivedLength !== undefined &&
      input.contentLength !== undefined &&
      input.contentLength !== derivedLength)
  ) {
    throw new ContentLengthMismatchError()
  }
  if (input.body instanceof ReadableStream) {
    if (input.contentLength === undefined) {
      throw new ContentLengthMismatchError()
    }
    const reader = input.body.getReader()
    const expectedLength = input.contentLength
    let emittedLength = 0
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await reader.read()
        if (next.done) {
          if (emittedLength !== expectedLength) {
            controller.error(new ContentLengthMismatchError())
          } else {
            controller.close()
          }
          return
        }
        emittedLength += next.value.byteLength
        if (emittedLength > expectedLength) {
          await reader.cancel()
          controller.error(new ContentLengthMismatchError())
          return
        }
        controller.enqueue(next.value)
      },
      cancel(reason) {
        return reader.cancel(reason)
      },
    })
  }
  return input.body
}

export class R2ObjectStorage implements ObjectStorage, ObjectStorageSigner {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string
  ) {}

  putObject(input: PutObjectInput) {
    return ResultAsync.fromPromise(
      (async () => {
        const body = checkedBody(input)
        const result = await this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: input.key,
            Body: body,
            ContentLength: input.contentLength,
            ContentType: input.contentType,
            CacheControl: input.cacheControl,
            ContentDisposition: input.contentDisposition,
            Metadata: input.metadata,
          })
        )
        return {
          key: input.key,
          size:
            input.contentLength ??
            (body instanceof Blob
              ? body.size
              : body instanceof Uint8Array
                ? body.byteLength
                : 0),
          contentType: input.contentType,
          etag: normalizeEtag(result.ETag),
          metadata: input.metadata ?? {},
        }
      })(),
      (error) => mapStorageError(error, input.key)
    )
  }

  getObject(input: GetObjectInput) {
    return ResultAsync.fromPromise<ObjectDownload, StorageError>(
      (async () => {
        const range = input.range
          ? `bytes=${input.range.start}-${input.range.endInclusive ?? ""}`
          : undefined
        const result = await this.client.send(
          new GetObjectCommand({
            Bucket: this.bucket,
            Key: input.key,
            Range: range,
          })
        )
        if (!result.Body) throw new TypeError("R2 returned no object body.")

        const resolvedRange = result.ContentRange?.match(
          /^bytes (\d+)-(\d+)\/(\d+)$/
        )
        const fullSize = resolvedRange
          ? Number(resolvedRange[3])
          : result.ContentLength
        return {
          body: toWebStream(result.Body),
          object: objectInfo(input.key, {
            ...result,
            ContentLength: fullSize,
          }),
          contentLength: result.ContentLength ?? 0,
          range: resolvedRange
            ? {
                start: Number(resolvedRange[1]),
                endInclusive: Number(resolvedRange[2]),
              }
            : undefined,
        }
      })(),
      (error) => mapStorageError(error, input.key)
    )
  }

  listObjects(input: ListObjectsInput) {
    return ResultAsync.fromPromise(
      this.client
        .send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: input.prefix,
            Delimiter: input.delimiter,
            ContinuationToken: input.cursor,
            MaxKeys: input.limit,
          })
        )
        .then((result) => ({
          objects: (result.Contents ?? [])
            .filter((item): item is typeof item & { Key: string } =>
              Boolean(item.Key)
            )
            .map((item) => objectInfo(item.Key, item)),
          prefixes: (result.CommonPrefixes ?? [])
            .map((item) => item.Prefix)
            .filter((prefix): prefix is string => prefix !== undefined),
          nextCursor: result.NextContinuationToken,
        })),
      mapStorageError
    )
  }

  copyObject(input: CopyObjectInput) {
    if (
      input.sourceKey === input.destinationKey &&
      input.metadata?.mode !== "replace"
    ) {
      return errAsync({
        code: "INVALID_KEY" as const,
        key: input.destinationKey,
        message: safeMessage("INVALID_KEY"),
      })
    }

    return ResultAsync.fromPromise(
      this.client
        .send(
          new CopyObjectCommand({
            Bucket: this.bucket,
            Key: input.destinationKey,
            CopySource: encodeCopySource(this.bucket, input.sourceKey),
            MetadataDirective:
              input.metadata?.mode === "replace" ? "REPLACE" : "COPY",
            Metadata:
              input.metadata?.mode === "replace"
                ? input.metadata.values
                : undefined,
          })
        )
        .then(() =>
          this.client.send(
            new HeadObjectCommand({
              Bucket: this.bucket,
              Key: input.destinationKey,
            })
          )
        )
        .then((result) => objectInfo(input.destinationKey, result)),
      (error) => mapStorageError(error, input.destinationKey)
    )
  }

  deleteObject(input: { key: string }) {
    return ResultAsync.fromPromise(
      this.client
        .send(
          new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: input.key,
          })
        )
        .then(() => undefined),
      (error) => mapStorageError(error, input.key)
    )
  }

  deleteObjects(input: { keys: string[] }) {
    const run = async (): Promise<DeleteObjectsResult> => {
      const deleted: string[] = []
      const failed: DeleteObjectsResult["failed"] = []

      for (
        let index = 0;
        index < input.keys.length;
        index += MAX_DELETE_BATCH
      ) {
        const keys = input.keys.slice(index, index + MAX_DELETE_BATCH)
        const result = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: {
              Objects: keys.map((Key) => ({ Key })),
              Quiet: false,
            },
          })
        )
        deleted.push(
          ...(result.Deleted ?? [])
            .map((item) => item.Key)
            .filter((key): key is string => key !== undefined)
        )
        for (const item of result.Errors ?? []) {
          if (!item.Key) continue
          failed.push({
            key: item.Key,
            error: mapStorageError({ name: item.Code }, item.Key),
          })
        }
      }
      return { deleted, failed }
    }

    return ResultAsync.fromPromise(run(), mapStorageError)
  }

  headObject(key: string) {
    return ResultAsync.fromPromise(
      this.client
        .send(
          new HeadObjectCommand({
            Bucket: this.bucket,
            Key: key,
          })
        )
        .then((result) => objectInfo(key, result)),
      (error) => mapStorageError(error, key)
    )
  }

  signPut(input: {
    key: string
    contentType: string
    contentLength?: number
    expiresInSeconds?: number
  }) {
    return this.sign(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        ContentType: input.contentType,
        ContentLength: input.contentLength,
      }),
      input.expiresInSeconds,
      {
        "Content-Type": input.contentType,
        ...(input.contentLength === undefined
          ? {}
          : { "Content-Length": String(input.contentLength) }),
      },
      input.key
    )
  }

  signGet(input: {
    key: string
    downloadName: string
    expiresInSeconds?: number
  }) {
    const safeName = input.downloadName.replace(/["\\\r\n]/g, "_")
    return this.sign(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        ResponseContentDisposition: `attachment; filename="${safeName}"`,
      }),
      input.expiresInSeconds,
      {},
      input.key
    )
  }

  private sign(
    command: PutObjectCommand | GetObjectCommand,
    expiresInSeconds: number | undefined,
    requiredHeaders: Record<string, string>,
    key: string
  ): ResultAsync<SignedObjectRequest, StorageError> {
    let expiry: number
    try {
      expiry = validateExpiry(expiresInSeconds)
    } catch {
      return errAsync({
        code: "UNKNOWN",
        message: "The requested signed URL expiry is invalid.",
      })
    }
    const issuedAt = Date.now()
    return ResultAsync.fromPromise(
      getSignedUrl(this.client, command, { expiresIn: expiry }).then((url) => ({
        url,
        expiresAt: issuedAt + expiry * 1_000,
        requiredHeaders,
      })),
      (error) => mapStorageError(error, key)
    )
  }
}
