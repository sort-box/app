import { errAsync, okAsync, type ResultAsync } from "neverthrow"

import type { ObjectInfo, StorageError } from "../storage/object-storage"

export type FileRecord = {
  id: string
  objectKey: string
  originalName: string
  declaredContentType: string
  declaredSize: number
  verifiedSize?: number
  status: "pending" | "ready" | "deleting" | "failed"
}

export type FileWorkflowError =
  | { code: "FILE_NOT_FOUND" }
  | { code: "INVALID_FILE_STATE" }
  | { code: "UPLOAD_MISMATCH" }
  | { code: "STORAGE_ERROR"; error: StorageError }
  | { code: "METADATA_ERROR" }

export interface FileMetadataPort {
  getOwned: (
    fileId: string
  ) => ResultAsync<FileRecord | null, FileWorkflowError>
  markReady: (
    fileId: string,
    object: ObjectInfo
  ) => ResultAsync<FileRecord, FileWorkflowError>
  markFailed: (
    fileId: string,
    failureCode: string
  ) => ResultAsync<void, FileWorkflowError>
  beginDelete: (fileId: string) => ResultAsync<FileRecord, FileWorkflowError>
  completeDelete: (fileId: string) => ResultAsync<void, FileWorkflowError>
}

export interface FileObjectPort {
  headObject: (key: string) => ResultAsync<ObjectInfo, StorageError>
  deleteObject: (input: { key: string }) => ResultAsync<void, StorageError>
}

export class FileWorkflowService {
  constructor(
    private readonly metadata: FileMetadataPort,
    private readonly storage: FileObjectPort
  ) {}

  completeUpload(fileId: string): ResultAsync<FileRecord, FileWorkflowError> {
    return this.metadata.getOwned(fileId).andThen((file) => {
      if (!file) return errAsync({ code: "FILE_NOT_FOUND" as const })
      if (file.status === "ready") return okAsync(file)
      if (file.status !== "pending" && file.status !== "failed") {
        return errAsync({ code: "INVALID_FILE_STATE" as const })
      }

      return this.storage
        .headObject(file.objectKey)
        .mapErr((error): FileWorkflowError => ({
          code: "STORAGE_ERROR",
          error,
        }))
        .andThen((object) => {
          if (
            object.size !== file.declaredSize ||
            object.contentType !== file.declaredContentType
          ) {
            return this.metadata
              .markFailed(fileId, "UPLOAD_MISMATCH")
              .andThen(() => errAsync({ code: "UPLOAD_MISMATCH" as const }))
          }
          return this.metadata.markReady(fileId, object)
        })
    })
  }

  deleteFile(fileId: string): ResultAsync<void, FileWorkflowError> {
    return this.metadata.beginDelete(fileId).andThen((file) =>
      this.storage
        .deleteObject({ key: file.objectKey })
        .mapErr((error): FileWorkflowError => ({
          code: "STORAGE_ERROR",
          error,
        }))
        .orElse((error) =>
          this.metadata
            .markFailed(fileId, "DELETE_FAILED")
            .andThen(() => errAsync(error))
        )
        .andThen(() => this.metadata.completeDelete(fileId))
    )
  }
}
