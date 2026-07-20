import { createFileRoute } from "@tanstack/react-router"

import { getObjectStorage } from "@/server/storage/storage.server"

const MAX_CLEANUP_BATCH = 100
const INCOMPLETE_UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1_000

async function fileServiceAuthorized(
  request: Request,
  configured: string | undefined
): Promise<boolean> {
  const presented = request.headers.get("x-file-service-secret")
  if (!configured || configured.length < 32 || !presented) return false

  const encode = (value: string) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  const [configuredDigest, presentedDigest] = await Promise.all([
    encode(configured),
    encode(presented),
  ])
  const expected = new Uint8Array(configuredDigest)
  const actual = new Uint8Array(presentedDigest)
  let difference = 0
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected[index] ^ actual[index]
  }
  return difference === 0
}

async function convexCleanupRequest<T>(
  siteUrl: string,
  serviceSecret: string,
  body: Record<string, unknown>
): Promise<T> {
  const response = await fetch(
    `${siteUrl.replace(/\/$/, "")}/internal/files/cleanup`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-file-service-secret": serviceSecret,
      },
      body: JSON.stringify(body),
    }
  )
  if (!response.ok) throw new Error("Convex cleanup operation failed.")
  return (await response.json()) as T
}

export const Route = createFileRoute("/api/files/cleanup")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const serviceSecret = process.env.FILE_SERVICE_SECRET
        const siteUrl = import.meta.env.VITE_CONVEX_SITE_URL
        if (
          !serviceSecret ||
          !siteUrl ||
          !(await fileServiceAuthorized(request, serviceSecret))
        ) {
          return new Response("Unauthorized", { status: 401 })
        }

        const storage = getObjectStorage()
        if (storage.isErr()) {
          return new Response("Storage is not configured", { status: 503 })
        }

        const candidates = await convexCleanupRequest<
          Array<{ fileId: string; objectKey: string }>
        >(siteUrl, serviceSecret, {
          operation: "list",
          cutoff: Date.now() - INCOMPLETE_UPLOAD_MAX_AGE_MS,
          limit: MAX_CLEANUP_BATCH,
        })

        let cleaned = 0
        for (const candidate of candidates) {
          const deleted = await storage.value.deleteObject({
            key: candidate.objectKey,
          })
          if (deleted.isErr()) continue
          await convexCleanupRequest(siteUrl, serviceSecret, {
            operation: "complete",
            fileId: candidate.fileId,
            objectKey: candidate.objectKey,
          })
          cleaned += 1
        }
        return Response.json({ cleaned, examined: candidates.length })
      },
    },
  },
})
