import { S3Client } from "@aws-sdk/client-s3"
import { err, ok, type Result } from "neverthrow"

import { R2ObjectStorage } from "./providers/r2/r2-object-storage.server"

export type StorageConfigurationError = {
  code: "INVALID_STORAGE_CONFIGURATION"
  message: string
}

type R2Configuration = {
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
}

function readR2Configuration(): Result<
  R2Configuration,
  StorageConfigurationError
> {
  const endpoint = process.env.CLOUDFLARE_R2_EUROPE_ENDPOINT
  const accessKeyId = process.env.CLOUDFLARE_ACCESS_KEY_ID
  const secretAccessKey = process.env.CLOUDFLARE_SECRET_ACCESS_KEY
  const bucket = process.env.CLOUDFLARE_R2_BUCKET_NAME

  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    return err({
      code: "INVALID_STORAGE_CONFIGURATION",
      message: "Required object storage configuration is missing.",
    })
  }

  try {
    const url = new URL(endpoint)
    if (
      url.protocol !== "https:" ||
      !url.hostname.endsWith(".eu.r2.cloudflarestorage.com")
    ) {
      return err({
        code: "INVALID_STORAGE_CONFIGURATION",
        message: "The configured object storage endpoint is invalid.",
      })
    }
  } catch {
    return err({
      code: "INVALID_STORAGE_CONFIGURATION",
      message: "The configured object storage endpoint is invalid.",
    })
  }

  return ok({ endpoint, accessKeyId, secretAccessKey, bucket })
}

let storage: R2ObjectStorage | undefined

export function getObjectStorage(): Result<
  R2ObjectStorage,
  StorageConfigurationError
> {
  if (storage) return ok(storage)

  return readR2Configuration().map((configuration) => {
    storage = new R2ObjectStorage(
      new S3Client({
        endpoint: configuration.endpoint,
        region: "auto",
        credentials: {
          accessKeyId: configuration.accessKeyId,
          secretAccessKey: configuration.secretAccessKey,
        },
      }),
      configuration.bucket
    )
    return storage
  })
}
