import { errAsync, okAsync } from "neverthrow"
import { describe, expect, it, vi } from "vitest"

import {
  FileWorkflowService,
  type FileMetadataPort,
  type FileObjectPort,
  type FileRecord,
} from "./file-workflow.server"

const pending: FileRecord = {
  id: "file-1",
  objectKey: "files/opaque",
  originalName: "report.pdf",
  declaredContentType: "application/pdf",
  declaredSize: 10,
  status: "pending",
}

function metadata(overrides: Partial<FileMetadataPort> = {}): FileMetadataPort {
  return {
    getOwned: () => okAsync(pending),
    markReady: (_id, object) =>
      okAsync({
        ...pending,
        status: "ready",
        verifiedSize: object.size,
      }),
    markFailed: () => okAsync(undefined),
    beginDelete: () => okAsync({ ...pending, status: "deleting" }),
    completeDelete: () => okAsync(undefined),
    ...overrides,
  }
}

function storage(overrides: Partial<FileObjectPort> = {}): FileObjectPort {
  return {
    headObject: () =>
      okAsync({
        key: pending.objectKey,
        size: 10,
        contentType: "application/pdf",
        metadata: {},
      }),
    deleteObject: () => okAsync(undefined),
    ...overrides,
  }
}

describe("FileWorkflowService", () => {
  it("verifies provider metadata before marking an upload ready", async () => {
    const markReady = vi.fn(metadata().markReady)
    const service = new FileWorkflowService(metadata({ markReady }), storage())

    const result = await service.completeUpload(pending.id)

    expect(result.isOk()).toBe(true)
    expect(markReady).toHaveBeenCalledWith(
      pending.id,
      expect.objectContaining({ size: 10, contentType: "application/pdf" })
    )
  })

  it("records and rejects mismatched uploads", async () => {
    const markFailed = vi.fn(() => okAsync(undefined))
    const service = new FileWorkflowService(
      metadata({ markFailed }),
      storage({
        headObject: () =>
          okAsync({
            key: pending.objectKey,
            size: 11,
            contentType: "application/pdf",
            metadata: {},
          }),
      })
    )

    const result = await service.completeUpload(pending.id)

    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.code).toBe("UPLOAD_MISMATCH")
    expect(markFailed).toHaveBeenCalledWith(pending.id, "UPLOAD_MISMATCH")
  })

  it("does not delete metadata when storage deletion fails", async () => {
    const completeDelete = vi.fn(() => okAsync(undefined))
    const markFailed = vi.fn(() => okAsync(undefined))
    const service = new FileWorkflowService(
      metadata({ completeDelete, markFailed }),
      storage({
        deleteObject: () =>
          errAsync({
            code: "PROVIDER_UNAVAILABLE",
            retryable: true,
            message: "unavailable",
          }),
      })
    )

    const result = await service.deleteFile(pending.id)

    expect(result.isErr()).toBe(true)
    expect(markFailed).toHaveBeenCalledWith(pending.id, "DELETE_FAILED")
    expect(completeDelete).not.toHaveBeenCalled()
  })

  it("rejects missing owned metadata before touching storage", async () => {
    const headObject = vi.fn(storage().headObject)
    const service = new FileWorkflowService(
      metadata({ getOwned: () => okAsync(null) }),
      storage({ headObject })
    )

    const result = await service.completeUpload("other-user-file")

    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.code).toBe("FILE_NOT_FOUND")
    expect(headObject).not.toHaveBeenCalled()
  })

  it("does not resurrect a failed deletion as a completed upload", async () => {
    const headObject = vi.fn(storage().headObject)
    const service = new FileWorkflowService(
      metadata({
        getOwned: () =>
          okAsync({
            ...pending,
            status: "failed",
            failureCode: "DELETE_FAILED",
            verifiedSize: pending.declaredSize,
          }),
      }),
      storage({ headObject })
    )

    const result = await service.completeUpload(pending.id)

    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.code).toBe("INVALID_FILE_STATE")
    expect(headObject).not.toHaveBeenCalled()
  })
})
