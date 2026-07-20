import { createFileRoute } from "@tanstack/react-router"

import { getObjectStorage } from "@/server/storage/storage.server"

const MAX_CLEANUP_BATCH = 100
const INCOMPLETE_UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1_000

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  )
}

async function authorized(request: Request, configured: string) {
  const presented = request.headers.get("x-file-service-secret")
  if (configured.length < 32 || !presented) return false
  const [configuredDigest, presentedDigest] = await Promise.all([
    sha256(configured),
    sha256(presented),
  ])
  let difference = 0
  for (let index = 0; index < configuredDigest.length; index += 1) {
    difference |= configuredDigest[index] ^ presentedDigest[index]
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
          !(await authorized(request, serviceSecret))
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
