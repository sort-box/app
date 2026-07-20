import type { ResultAsync } from "neverthrow"

import type { ObjectInfo, StorageError } from "./object-storage"

export interface SignedObjectRequest {
  url: string
  expiresAt: number
  requiredHeaders: Record<string, string>
}

export interface ObjectStorageSigner {
  signPut: (input: {
    key: string
    contentType: string
    contentLength?: number
    expiresInSeconds?: number
  }) => ResultAsync<SignedObjectRequest, StorageError>

  signGet: (input: {
    key: string
    downloadName: string
    expiresInSeconds?: number
  }) => ResultAsync<SignedObjectRequest, StorageError>

  headObject: (key: string) => ResultAsync<ObjectInfo, StorageError>
}
