import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3"
import { describe, expect, it, vi } from "vitest"

import { R2ObjectStorage } from "./r2-object-storage.server"

function storageWith(
  send: (command: unknown) => Promise<unknown>
): R2ObjectStorage {
  return new R2ObjectStorage({ send } as unknown as S3Client, "test-bucket")
}

describe("R2ObjectStorage", () => {
  it("maps buffered uploads to PutObject", async () => {
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(PutObjectCommand)
      expect((command as PutObjectCommand).input).toMatchObject({
        Bucket: "test-bucket",
        Key: "files/one",
        ContentLength: 3,
        ContentType: "text/plain",
      })
      return { ETag: '"etag-one"' }
    })
    const storage = storageWith(send)

    const result = await storage.putObject({
      key: "files/one",
      body: new Uint8Array([1, 2, 3]),
      contentLength: 3,
      contentType: "text/plain",
    })

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toMatchObject({
        key: "files/one",
        size: 3,
        etag: "etag-one",
      })
    }
  })

  it("rejects a mismatched buffered content length before upload", async () => {
    const send = vi.fn()
    const storage = storageWith(send)

    const result = await storage.putObject({
      key: "files/one",
      body: new Uint8Array([1, 2, 3]),
      contentLength: 2,
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error).toEqual({
        code: "INVALID_CONTENT_LENGTH",
        key: "files/one",
        message: "The declared content length is invalid.",
      })
    }
    expect(send).not.toHaveBeenCalled()
  })

  it("uses inclusive ranges and normalizes the returned range", async () => {
    const responseStream = new ReadableStream<Uint8Array>()
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(GetObjectCommand)
      expect((command as GetObjectCommand).input.Range).toBe("bytes=2-5")
      return {
        Body: { transformToWebStream: () => responseStream },
        ContentLength: 4,
        ContentRange: "bytes 2-5/10",
        ETag: '"etag-two"',
        Metadata: {},
      }
    })
    const storage = storageWith(send)

    const result = await storage.getObject({
      key: "files/two",
      range: { start: 2, endInclusive: 5 },
    })

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.range).toEqual({ start: 2, endInclusive: 5 })
      expect(result.value.contentLength).toBe(4)
      expect(result.value.object.size).toBe(10)
      expect(result.value.body).toBe(responseStream)
    }
  })

  it("chunks bulk deletes at 1000 keys", async () => {
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(DeleteObjectsCommand)
      const keys = (command as DeleteObjectsCommand).input.Delete?.Objects ?? []
      return { Deleted: keys }
    })
    const storage = storageWith(send)
    const keys = Array.from({ length: 1_001 }, (_, index) => `files/${index}`)

    const result = await storage.deleteObjects({ keys })

    expect(result.isOk()).toBe(true)
    expect(send).toHaveBeenCalledTimes(2)
    if (result.isOk()) expect(result.value.deleted).toEqual(keys)
  })

  it("normalizes listings and continuation cursors", async () => {
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(ListObjectsV2Command)
      expect((command as ListObjectsV2Command).input).toMatchObject({
        Prefix: "files/",
        ContinuationToken: "cursor-one",
        MaxKeys: 25,
      })
      return {
        Contents: [
          {
            Key: "files/one",
            Size: 12,
            ETag: '"etag-list"',
          },
        ],
        CommonPrefixes: [{ Prefix: "files/archive/" }],
        NextContinuationToken: "cursor-two",
      }
    })
    const storage = storageWith(send)

    const result = await storage.listObjects({
      prefix: "files/",
      cursor: "cursor-one",
      limit: 25,
    })

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.objects[0]).toMatchObject({
        key: "files/one",
        size: 12,
        etag: "etag-list",
      })
      expect(result.value.prefixes).toEqual(["files/archive/"])
      expect(result.value.nextCursor).toBe("cursor-two")
    }
  })

  it("heads the destination after copy to return complete metadata", async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof CopyObjectCommand) return {}
      expect(command).toBeInstanceOf(HeadObjectCommand)
      return {
        ContentLength: 42,
        ContentType: "text/plain",
        ETag: '"copied-etag"',
        Metadata: { category: "test" },
      }
    })
    const storage = storageWith(send)

    const result = await storage.copyObject({
      sourceKey: "files/source",
      destinationKey: "files/destination",
    })

    expect(result.isOk()).toBe(true)
    expect(send).toHaveBeenCalledTimes(2)
    if (result.isOk()) {
      expect(result.value).toMatchObject({
        key: "files/destination",
        size: 42,
        contentType: "text/plain",
        etag: "copied-etag",
        metadata: { category: "test" },
      })
    }
  })

  it("does not expose provider error details", async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error("secret endpoint and request id"), {
        name: "ServiceUnavailable",
        $metadata: { httpStatusCode: 503, requestId: "sensitive" },
      })
    })
    const storage = storageWith(send)

    const result = await storage.getObject({ key: "files/three" })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error).toEqual({
        code: "PROVIDER_UNAVAILABLE",
        retryable: true,
        message: "Object storage is temporarily unavailable.",
      })
      expect(JSON.stringify(result.error)).not.toContain("sensitive")
      expect(JSON.stringify(result.error)).not.toContain("secret endpoint")
    }
  })
})
