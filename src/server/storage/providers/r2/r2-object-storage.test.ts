import {
  DeleteObjectsCommand,
  GetObjectCommand,
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
