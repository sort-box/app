/// <reference types="vite/client" />
import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { components, internal } from "./_generated/api"
import schema from "./schema"

const objectStorageMock = vi.hoisted(() => ({
  body: undefined as Uint8Array | undefined,
}))

vi.mock("../src/server/storage/storage.server", () => ({
  getObjectStorage: () => ({
    isErr: () => false,
    value: {
      getObject: async ({ key }: { key: string }) => {
        const body = objectStorageMock.body
        if (!body) {
          return {
            isOk: () => false,
            error: {
              code: "NOT_FOUND",
              key,
              message: "The requested object was not found.",
            },
          }
        }
        return {
          isOk: () => true,
          value: {
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(body)
                controller.close()
              },
            }),
            contentLength: body.byteLength,
            object: {
              key,
              size: body.byteLength,
              metadata: {},
            },
          },
        }
      },
    },
  }),
}))

// Keep optional component test exports out of Vite's static import resolution.
const ragTestModule = "@convex-dev/rag/" + "test"
const { default: ragTest } = (await import(ragTestModule)) as {
  default: { register: (test: ReturnType<typeof convexTest>) => void }
}
const migrationsTestModule = "@convex-dev/migrations/" + "test"
const { default: migrationsTest } = (await import(migrationsTestModule)) as {
  default: { register: (test: ReturnType<typeof convexTest>) => void }
}

const modules = import.meta.glob("./**/*.ts")
function testBackend() {
  const t = convexTest(schema, modules)
  ragTest.register(t)
  migrationsTest.register(t)
  return t
}

const owner = {
  ownerClerkUserId: "owner",
  ownerTokenIdentifier: "issuer|owner",
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  objectStorageMock.body = undefined
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("files authorization", () => {
  it("rejects trusted file HTTP requests without the service identity", async () => {
    const t = testBackend()
    const response = await t.fetch("/internal/files/rest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "createUpload" }),
    })

    expect(response.status).toBe(401)
  })

  it("allocates opaque unique keys inside trusted mutations", async () => {
    const t = testBackend()
    const first = await t.mutation(internal.fileRest.createUpload, {
      ...owner,
      path: "/first.txt",
      parentPath: "/",
      basename: "first.txt",
      contentType: "text/plain",
      size: 1,
    })
    const second = await t.mutation(internal.fileRest.createUpload, {
      ...owner,
      path: "/second.txt",
      parentPath: "/",
      basename: "second.txt",
      contentType: "text/plain",
      size: 1,
    })

    expect(first.objectKey).toMatch(/^files\/[0-9a-f-]{36}$/)
    expect(second.objectKey).not.toBe(first.objectKey)
  })

  it("does not reveal another user's metadata", async () => {
    const t = testBackend()
    const created = await t.mutation(internal.fileRest.createUpload, {
      ...owner,
      path: "/private.txt",
      parentPath: "/",
      basename: "private.txt",
      contentType: "text/plain",
      size: 1,
    })
    await expect(
      t.query(internal.fileRest.getOwned, {
        ownerTokenIdentifier: "issuer|attacker",
        fileId: created.fileId,
      })
    ).resolves.toBeNull()
  })

  it("rejects internal transitions for a different owner", async () => {
    const t = testBackend()
    const created = await t.mutation(internal.fileRest.createUpload, {
      ...owner,
      path: "/private.txt",
      parentPath: "/",
      basename: "private.txt",
      contentType: "text/plain",
      size: 1,
    })

    await expect(
      t.mutation(internal.fileRest.completeUpload, {
        fileId: created.fileId,
        ownerTokenIdentifier: "issuer|attacker",
        verifiedContentType: "text/plain",
        verifiedSize: 1,
      })
    ).rejects.toThrow("FILE_NOT_FOUND")
  })

  it("enforces owner-scoped paths and the fixed quota atomically", async () => {
    const t = testBackend()
    const fourGiB = 4 * 1024 ** 3
    const report = await t.mutation(internal.fileRest.createUpload, {
      ...owner,
      path: "/private/report.pdf",
      parentPath: "/private",
      basename: "report.pdf",
      contentType: "application/pdf",
      size: fourGiB,
    })
    await t.mutation(internal.fileRest.completeUpload, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      fileId: report.fileId,
      verifiedContentType: "application/pdf",
      verifiedSize: fourGiB,
    })
    await t.mutation(internal.fileRest.createUpload, {
      ...owner,
      path: "/private/second.pdf",
      parentPath: "/private",
      basename: "second.pdf",
      contentType: "application/pdf",
      size: fourGiB,
    })

    await expect(
      t.mutation(internal.fileRest.createUpload, {
        ...owner,
        path: "/private/report.pdf",
        parentPath: "/private",
        basename: "report.pdf",
        contentType: "application/pdf",
        size: 1,
      })
    ).rejects.toThrow("PATH_CONFLICT")
    await expect(
      t.mutation(internal.fileRest.createUpload, {
        ...owner,
        path: "/private/other.pdf",
        parentPath: "/private",
        basename: "other.pdf",
        contentType: "application/pdf",
        size: 3 * 1024 ** 3,
      })
    ).rejects.toThrow("QUOTA_EXCEEDED")
  })

  it("enforces the user's file entitlement and records unified usage", async () => {
    const t = testBackend()
    await t.run(async (ctx) => {
      await ctx.db.insert("userEntitlements", {
        ownerTokenIdentifier: owner.ownerTokenIdentifier,
        kind: "file",
        storageLimitBytes: 10,
      })
    })

    await t.mutation(internal.fileRest.createUpload, {
      ...owner,
      path: "/within-limit.txt",
      parentPath: "/",
      basename: "within-limit.txt",
      contentType: "text/plain",
      size: 10,
    })
    await expect(
      t.mutation(internal.fileRest.createUpload, {
        ...owner,
        path: "/over-limit.txt",
        parentPath: "/",
        basename: "over-limit.txt",
        contentType: "text/plain",
        size: 1,
      })
    ).rejects.toThrow("QUOTA_EXCEEDED")

    const usage = await t.run(async (ctx) =>
      ctx.db
        .query("userUsage")
        .withIndex("by_owner_and_kind", (q) =>
          q
            .eq("ownerTokenIdentifier", owner.ownerTokenIdentifier)
            .eq("kind", "file")
        )
        .unique()
    )
    expect(usage).toMatchObject({
      kind: "file",
      reservedBytes: 10,
      usedBytes: 0,
    })
  })

  it("lets a retry supersede a stale pending upload at the same path", async () => {
    const t = testBackend()
    const fourGiB = 4 * 1024 ** 3
    const first = await t.mutation(internal.fileRest.createUpload, {
      ...owner,
      path: "/retry.pdf",
      parentPath: "/",
      basename: "retry.pdf",
      contentType: "application/pdf",
      size: fourGiB,
    })

    const second = await t.mutation(internal.fileRest.createUpload, {
      ...owner,
      path: "/retry.pdf",
      parentPath: "/",
      basename: "retry.pdf",
      contentType: "application/pdf",
      size: fourGiB,
    })
    expect(second.fileId).not.toBe(first.fileId)

    await expect(
      t.mutation(internal.fileRest.completeUpload, {
        ownerTokenIdentifier: owner.ownerTokenIdentifier,
        fileId: first.fileId,
        verifiedContentType: "application/pdf",
        verifiedSize: fourGiB,
      })
    ).rejects.toThrow("INVALID_FILE_STATE")

    // Fits the 10 GiB quota only if the superseded reservation was refunded.
    await t.mutation(internal.fileRest.createUpload, {
      ...owner,
      path: "/third.pdf",
      parentPath: "/",
      basename: "third.pdf",
      contentType: "application/pdf",
      size: fourGiB,
    })
  })

  it("uses a fixed rate limit instead of a caller-provided limit", async () => {
    const t = testBackend()
    for (let request = 0; request < 60; request += 1) {
      await expect(
        t.mutation(internal.fileRest.consumeRateLimit, {
          ownerTokenIdentifier: owner.ownerTokenIdentifier,
          bucket: "upload",
        })
      ).resolves.toEqual({ allowed: true, retryAfter: 0 })
    }
    await expect(
      t.mutation(internal.fileRest.consumeRateLimit, {
        ownerTokenIdentifier: owner.ownerTokenIdentifier,
        bucket: "upload",
      })
    ).resolves.toMatchObject({ allowed: false })
  })

  it("does not prune a directory that still contains a deleting file", async () => {
    const t = testBackend()
    const deleting = await t.mutation(internal.fileRest.createUpload, {
      ...owner,
      path: "/reports/deleting.txt",
      parentPath: "/reports",
      basename: "deleting.txt",
      contentType: "text/plain",
      size: 1,
    })
    const moving = await t.mutation(internal.fileRest.createUpload, {
      ...owner,
      path: "/reports/moving.txt",
      parentPath: "/reports",
      basename: "moving.txt",
      contentType: "text/plain",
      size: 1,
    })
    for (const fileId of [deleting.fileId, moving.fileId]) {
      await t.mutation(internal.fileRest.completeUpload, {
        ownerTokenIdentifier: owner.ownerTokenIdentifier,
        fileId,
        verifiedContentType: "text/plain",
        verifiedSize: 1,
      })
    }
    await t.mutation(internal.fileRest.beginDelete, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      fileId: deleting.fileId,
    })
    await t.mutation(internal.fileRest.move, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      fileId: moving.fileId,
      path: "/moving.txt",
      parentPath: "/",
      basename: "moving.txt",
    })

    const root = await t.query(internal.fileRest.list, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      parentPath: "/",
      recursive: false,
      paginationOpts: { cursor: null, numItems: 25 },
    })
    expect(root.page).toContainEqual(
      expect.objectContaining({ kind: "directory", path: "/reports" })
    )
  })
})

describe("directories", () => {
  async function uploadReady(t: ReturnType<typeof convexTest>, path: string) {
    const segments = path.slice(1).split("/")
    const created = await t.mutation(internal.fileRest.createUpload, {
      ...owner,
      path,
      parentPath:
        segments.length === 1 ? "/" : `/${segments.slice(0, -1).join("/")}`,
      basename: segments.at(-1)!,
      contentType: "text/plain",
      size: 1,
    })
    await t.mutation(internal.fileRest.completeUpload, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      fileId: created.fileId,
      verifiedContentType: "text/plain",
      verifiedSize: 1,
    })
    return created.fileId
  }

  function listDirectory(t: ReturnType<typeof convexTest>, parentPath: string) {
    return t.query(internal.fileRest.list, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      parentPath,
      recursive: false,
      paginationOpts: { cursor: null, numItems: 25 },
    })
  }

  it("keeps an explicitly created folder when it becomes empty", async () => {
    const t = testBackend()
    await t.mutation(internal.fileRest.createDirectory, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      path: "/projects",
      parentPath: "/",
      basename: "projects",
    })
    const fileId = await uploadReady(t, "/projects/a.txt")
    await t.mutation(internal.fileRest.move, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      fileId,
      path: "/a.txt",
      parentPath: "/",
      basename: "a.txt",
    })

    const root = await listDirectory(t, "/")
    expect(root.page).toContainEqual(
      expect.objectContaining({ kind: "directory", path: "/projects" })
    )
  })

  it("marks an existing implicit folder explicit instead of conflicting", async () => {
    const t = testBackend()
    const fileId = await uploadReady(t, "/docs/a.txt")
    await t.mutation(internal.fileRest.createDirectory, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      path: "/docs",
      parentPath: "/",
      basename: "docs",
    })
    await t.mutation(internal.fileRest.move, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      fileId,
      path: "/a.txt",
      parentPath: "/",
      basename: "a.txt",
    })

    const root = await listDirectory(t, "/")
    expect(root.page).toContainEqual(
      expect.objectContaining({ kind: "directory", path: "/docs" })
    )
  })

  it("rejects creating a folder over a file or an explicit folder", async () => {
    const t = testBackend()
    await uploadReady(t, "/taken.txt")
    await expect(
      t.mutation(internal.fileRest.createDirectory, {
        ownerTokenIdentifier: owner.ownerTokenIdentifier,
        path: "/taken.txt",
        parentPath: "/",
        basename: "taken.txt",
      })
    ).rejects.toThrow("PATH_CONFLICT")

    await t.mutation(internal.fileRest.createDirectory, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      path: "/kept",
      parentPath: "/",
      basename: "kept",
    })
    await expect(
      t.mutation(internal.fileRest.createDirectory, {
        ownerTokenIdentifier: owner.ownerTokenIdentifier,
        path: "/kept",
        parentPath: "/",
        basename: "kept",
      })
    ).rejects.toThrow("PATH_CONFLICT")
  })

  it("rejects creating or moving an entry over an existing folder", async () => {
    const t = testBackend()
    await uploadReady(t, "/source/a.txt")
    await t.mutation(internal.fileRest.createDirectory, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      path: "/destination/source",
      parentPath: "/destination",
      basename: "source",
    })

    await expect(
      t.mutation(internal.fileRest.moveDirectory, {
        ownerTokenIdentifier: owner.ownerTokenIdentifier,
        sourcePath: "/source",
        path: "/destination/source",
        parentPath: "/destination",
        basename: "source",
      })
    ).rejects.toThrow("PATH_CONFLICT")

    await expect(
      t.mutation(internal.fileRest.createUpload, {
        ...owner,
        path: "/destination/source",
        parentPath: "/destination",
        basename: "source",
        contentType: "text/plain",
        size: 1,
      })
    ).rejects.toThrow("PATH_CONFLICT")
  })

  it("deletes an empty folder and prunes its implicit ancestors", async () => {
    const t = testBackend()
    await t.mutation(internal.fileRest.createDirectory, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      path: "/a/b",
      parentPath: "/a",
      basename: "b",
    })
    await t.mutation(internal.fileRest.deleteDirectory, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      path: "/a/b",
    })

    const root = await listDirectory(t, "/")
    expect(root.page).toEqual([])
  })

  it("refuses to delete a non-empty folder or another user's folder", async () => {
    const t = testBackend()
    await uploadReady(t, "/full/a.txt")
    await expect(
      t.mutation(internal.fileRest.deleteDirectory, {
        ownerTokenIdentifier: owner.ownerTokenIdentifier,
        path: "/full",
      })
    ).rejects.toThrow("DIRECTORY_NOT_EMPTY")
    await expect(
      t.mutation(internal.fileRest.deleteDirectory, {
        ownerTokenIdentifier: "issuer|attacker",
        path: "/full",
      })
    ).rejects.toThrow("FILE_NOT_FOUND")
  })

  it("moves a folder and re-paths everything inside it", async () => {
    const t = testBackend()
    const nested = await uploadReady(t, "/a/b/c.txt")
    await uploadReady(t, "/a/d.txt")

    const moved = await t.mutation(internal.fileRest.moveDirectory, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      sourcePath: "/a",
      path: "/x/a",
      parentPath: "/x",
      basename: "a",
    })
    expect(moved).toMatchObject({ path: "/x/a", parentPath: "/x" })

    const movedRoot = await listDirectory(t, "/x/a")
    expect(movedRoot.page).toEqual([
      expect.objectContaining({ kind: "directory", path: "/x/a/b" }),
      expect.objectContaining({ kind: "file", path: "/x/a/d.txt" }),
    ])
    const movedNested = await listDirectory(t, "/x/a/b")
    expect(movedNested.page).toEqual([
      expect.objectContaining({ kind: "file", path: "/x/a/b/c.txt" }),
    ])
    const file = await t.query(internal.fileRest.getOwned, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      fileId: nested,
    })
    expect(file).toMatchObject({ path: "/x/a/b/c.txt", parentPath: "/x/a/b" })
    const root = await listDirectory(t, "/")
    expect(root.page).not.toContainEqual(
      expect.objectContaining({ path: "/a" })
    )
  })

  it("rejects invalid folder moves", async () => {
    const t = testBackend()
    await uploadReady(t, "/a/b/c.txt")

    await expect(
      t.mutation(internal.fileRest.moveDirectory, {
        ownerTokenIdentifier: owner.ownerTokenIdentifier,
        sourcePath: "/a",
        path: "/a/b/a",
        parentPath: "/a/b",
        basename: "a",
      })
    ).rejects.toThrow("INVALID_PATH")

    await uploadReady(t, "/x/a")
    await expect(
      t.mutation(internal.fileRest.moveDirectory, {
        ownerTokenIdentifier: owner.ownerTokenIdentifier,
        sourcePath: "/a",
        path: "/x/a",
        parentPath: "/x",
        basename: "a",
      })
    ).rejects.toThrow("PATH_CONFLICT")

    await expect(
      t.mutation(internal.fileRest.moveDirectory, {
        ownerTokenIdentifier: "issuer|attacker",
        sourcePath: "/a",
        path: "/moved",
        parentPath: "/",
        basename: "moved",
      })
    ).rejects.toThrow("FILE_NOT_FOUND")

    await t.mutation(internal.fileRest.createUpload, {
      ...owner,
      path: "/a/pending.txt",
      parentPath: "/a",
      basename: "pending.txt",
      contentType: "text/plain",
      size: 1,
    })
    await expect(
      t.mutation(internal.fileRest.moveDirectory, {
        ownerTokenIdentifier: owner.ownerTokenIdentifier,
        sourcePath: "/a",
        path: "/moved",
        parentPath: "/",
        basename: "moved",
      })
    ).rejects.toThrow("INVALID_FILE_STATE")
  })

  it("keeps a moved explicit folder explicit", async () => {
    const t = testBackend()
    await t.mutation(internal.fileRest.createDirectory, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      path: "/keep",
      parentPath: "/",
      basename: "keep",
    })

    const moved = await t.mutation(internal.fileRest.moveDirectory, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      sourcePath: "/keep",
      path: "/archive/keep",
      parentPath: "/archive",
      basename: "keep",
    })
    expect(moved.explicit).toBe(true)
  })
})

describe("document embedding lifecycle", () => {
  async function completeTextUpload() {
    const t = testBackend()
    const created = await t.mutation(internal.fileRest.createUpload, {
      ...owner,
      path: "/embedded.txt",
      parentPath: "/",
      basename: "embedded.txt",
      contentType: "text/plain",
      size: 12,
    })
    const completed = await t.mutation(internal.fileRest.completeUpload, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      fileId: created.fileId,
      verifiedContentType: "text/plain",
      verifiedSize: 12,
      etag: "content-etag",
    })
    return { completed, created, t }
  }

  it("queues a supported file with versioned RAG entry metadata", async () => {
    const { completed, created, t } = await completeTextUpload()

    expect(completed).toMatchObject({
      embeddingStatus: "queued",
      embeddingVersion: "v1:voyage-4-large:1024:passage-100",
    })
    expect(completed.embeddingEntryId).toBeTypeOf("string")
    const entry = await t.query(components.rag.entries.get, {
      entryId: completed.embeddingEntryId!,
    })
    expect(entry).toMatchObject({
      key: created.fileId,
      status: "pending",
      metadata: {
        contentType: "text/plain",
        fileId: created.fileId,
        version: "v1:voyage-4-large:1024:passage-100",
      },
    })
  })

  it("marks media unsupported without making the uploaded file unavailable", async () => {
    const t = testBackend()
    const created = await t.mutation(internal.fileRest.createUpload, {
      ...owner,
      path: "/photo.png",
      parentPath: "/",
      basename: "photo.png",
      contentType: "image/png",
      size: 20,
    })
    const completed = await t.mutation(internal.fileRest.completeUpload, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      fileId: created.fileId,
      verifiedContentType: "image/png",
      verifiedSize: 20,
    })

    expect(completed).toMatchObject({
      status: "ready",
      embeddingStatus: "unsupported",
      embeddingErrorCode: "UNSUPPORTED_TYPE",
    })
    expect(completed.embeddingEntryId).toBeUndefined()
  })

  it("restarts failed and stalled embeddings", async () => {
    const { completed, created, t } = await completeTextUpload()
    await t.run(async (ctx) => {
      await ctx.db.patch(created.fileId, {
        embeddingStatus: "failed",
        embeddingErrorCode: "EMBEDDING_FAILED",
      })
    })

    const retried = await t.mutation(internal.fileRest.retryEmbedding, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      fileId: created.fileId,
    })
    const repeated = await t.mutation(internal.fileRest.retryEmbedding, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      fileId: created.fileId,
    })

    expect(retried.embeddingStatus).toBe("queued")
    expect(retried.embeddingEntryId).not.toBe(completed.embeddingEntryId)
    expect(repeated.embeddingEntryId).not.toBe(retried.embeddingEntryId)
  })

  it("deletes a file whose embedding previously failed", async () => {
    const { completed, created, t } = await completeTextUpload()
    const entry = await t.query(components.rag.entries.get, {
      entryId: completed.embeddingEntryId!,
    })
    const namespace = await t.query(components.rag.namespaces.get, {
      namespace: owner.ownerTokenIdentifier,
      modelId: "voyage-4-large:document:1024",
      dimension: 1_024,
      filterNames: [],
    })

    await t.mutation(internal.documentEmbedding.completeEmbedding, {
      namespace: namespace! as never,
      entry: entry! as never,
      error: "NO_TEXT",
    })
    const failed = await t.query(internal.fileRest.getOwned, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      fileId: created.fileId,
    })
    expect(failed).toMatchObject({
      embeddingStatus: "failed",
      embeddingErrorCode: "NO_TEXT",
    })
    expect(failed?.embeddingEntryId).toBeUndefined()

    await t.mutation(internal.fileRest.beginDelete, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      fileId: created.fileId,
    })
    await t.mutation(internal.fileRest.completeDelete, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      fileId: created.fileId,
    })

    expect(
      await t.query(internal.fileRest.getOwned, {
        ownerTokenIdentifier: owner.ownerTokenIdentifier,
        fileId: created.fileId,
      })
    ).toBeNull()
  })

  it("does not re-embed a moved file", async () => {
    const { completed, created, t } = await completeTextUpload()
    const moved = await t.mutation(internal.fileRest.move, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      fileId: created.fileId,
      path: "/archive/embedded.txt",
      parentPath: "/archive",
      basename: "embedded.txt",
    })

    expect(moved.embeddingEntryId).toBe(completed.embeddingEntryId)
    expect(moved.embeddingStatus).toBe("queued")
  })

  it("extracts, embeds, and stores clean passage metadata asynchronously", async () => {
    const sourceText =
      "Architecture\n\nThe ingestion worker stores deterministic passages."
    const sourceBytes = new TextEncoder().encode(sourceText)
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url
        if (url === "https://api.voyageai.com/v1/embeddings") {
          const body = JSON.parse(String(init?.body)) as {
            input: string[]
            input_type: string
            output_dimension: number
          }
          expect(body).toMatchObject({
            input_type: "document",
            output_dimension: 1_024,
          })
          return Response.json({
            data: body.input.map((_, index) => ({
              index,
              embedding: Array.from({ length: 1_024 }, () => 0.01),
            })),
          })
        }
        return new Response(null, { status: 500 })
      }
    )
    vi.stubGlobal("fetch", fetchMock)
    objectStorageMock.body = sourceBytes
    process.env.VOYAGE_API_KEY = "voyage-test-key"

    try {
      const t = testBackend()
      const created = await t.mutation(internal.fileRest.createUpload, {
        ...owner,
        path: "/pipeline.txt",
        parentPath: "/",
        basename: "pipeline.txt",
        contentType: "text/plain",
        size: sourceBytes.byteLength,
      })
      const queued = await t.mutation(internal.fileRest.completeUpload, {
        ownerTokenIdentifier: owner.ownerTokenIdentifier,
        fileId: created.fileId,
        verifiedContentType: "text/plain",
        verifiedSize: sourceBytes.byteLength,
      })

      await t.finishAllScheduledFunctions(vi.runAllTimers)

      const file = await t.query(internal.fileRest.getOwned, {
        ownerTokenIdentifier: owner.ownerTokenIdentifier,
        fileId: created.fileId,
      })
      expect(file?.embeddingStatus).toBe("ready")
      const chunks = await t.query(components.rag.chunks.list, {
        entryId: queued.embeddingEntryId!,
        order: "asc",
        paginationOpts: { cursor: null, numItems: 10 },
      })
      expect(chunks.page).toEqual([
        {
          text: sourceText.replace(/\n\n/gu, " "),
          order: 0,
          state: "ready",
          metadata: {
            embeddingText: sourceText.replace(/\n\n/gu, " "),
            headingPath: [],
            order: 0,
            provenance: { kind: "text", start: 0, end: sourceText.length },
          },
        },
      ])
    } finally {
      vi.unstubAllGlobals()
      objectStorageMock.body = undefined
      delete process.env.VOYAGE_API_KEY
    }
  })

  it("ignores a callback that no longer owns the file embedding state", async () => {
    const { completed, created, t } = await completeTextUpload()
    const entry = await t.query(components.rag.entries.get, {
      entryId: completed.embeddingEntryId!,
    })
    const namespace = await t.query(components.rag.namespaces.get, {
      namespace: owner.ownerTokenIdentifier,
      modelId: "voyage-4-large:document:1024",
      dimension: 1_024,
      filterNames: [],
    })
    expect(entry).not.toBeNull()
    expect(namespace).not.toBeNull()
    await t.run(async (ctx) => {
      await ctx.db.patch(created.fileId, {
        embeddingEntryId: "replacement-entry",
        embeddingStatus: "embedding",
      })
    })

    await t.mutation(internal.documentEmbedding.completeEmbedding, {
      namespace: namespace! as never,
      entry: entry! as never,
      error: "NO_TEXT",
    })

    const file = await t.query(internal.fileRest.getOwned, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      fileId: created.fileId,
    })
    expect(file).toMatchObject({
      embeddingEntryId: "replacement-entry",
      embeddingStatus: "embedding",
    })
  })
})

describe("unified usage migration", () => {
  it("backfills file usage and the default entitlement idempotently", async () => {
    const t = testBackend()
    await t.run(async (ctx) => {
      await ctx.db.insert("fileUsage", {
        ownerTokenIdentifier: owner.ownerTokenIdentifier,
        reservedBytes: 25,
        usedBytes: 75,
      })
    })

    await t.mutation(internal.migrations.backfillUnifiedFileUsage, {})
    await t.mutation(internal.migrations.backfillUnifiedFileUsage, {
      reset: true,
    })

    const result = await t.run(async (ctx) => ({
      usage: await ctx.db
        .query("userUsage")
        .withIndex("by_owner_and_kind", (q) =>
          q
            .eq("ownerTokenIdentifier", owner.ownerTokenIdentifier)
            .eq("kind", "file")
        )
        .unique(),
      entitlement: await ctx.db
        .query("userEntitlements")
        .withIndex("by_owner_and_kind", (q) =>
          q
            .eq("ownerTokenIdentifier", owner.ownerTokenIdentifier)
            .eq("kind", "file")
        )
        .unique(),
    }))
    expect(result.usage).toMatchObject({
      kind: "file",
      reservedBytes: 25,
      usedBytes: 75,
    })
    expect(result.entitlement).toMatchObject({
      kind: "file",
      storageLimitBytes: 10 * 1024 ** 3,
    })

    await t.run(async (ctx) => {
      await ctx.db.patch(result.usage!._id, { usedBytes: 100 })
    })
    await t.mutation(internal.migrations.backfillUnifiedFileUsage, {
      reset: true,
    })
    const current = await t.run(async (ctx) => ctx.db.get(result.usage!._id))
    expect(current).toMatchObject({ usedBytes: 100 })
  })
})

describe("embedding backfill migration", () => {
  it("is dry-run safe, resumable, and idempotent", async () => {
    const t = testBackend()
    const [supported, unsupported, pending] = await t.run(async (ctx) => {
      const base = {
        ownerClerkUserId: owner.ownerClerkUserId,
        ownerTokenIdentifier: owner.ownerTokenIdentifier,
        declaredSize: 10,
        usageBackfilledAt: Date.now(),
      }
      return await Promise.all([
        ctx.db.insert("files", {
          ...base,
          objectKey: "files/legacy-supported",
          originalName: "legacy.txt",
          declaredContentType: "text/plain",
          verifiedContentType: "text/plain",
          verifiedSize: 10,
          status: "ready",
        }),
        ctx.db.insert("files", {
          ...base,
          objectKey: "files/legacy-unsupported",
          originalName: "legacy.png",
          declaredContentType: "image/png",
          verifiedContentType: "image/png",
          verifiedSize: 10,
          status: "ready",
        }),
        ctx.db.insert("files", {
          ...base,
          objectKey: "files/legacy-pending",
          originalName: "pending.txt",
          declaredContentType: "text/plain",
          status: "pending",
        }),
      ])
    })

    await t.mutation(internal.migrations.backfillFileEmbeddings, {
      dryRun: true,
    })
    expect(
      await t.run(async (ctx) =>
        Promise.all([
          ctx.db.get(supported),
          ctx.db.get(unsupported),
          ctx.db.get(pending),
        ])
      )
    ).toSatisfy((files: Array<{ embeddingStatus?: string } | null>) =>
      files.every((file) => file?.embeddingStatus === undefined)
    )

    await t.mutation(internal.migrations.backfillFileEmbeddings, {})
    const after = await t.run(async (ctx) =>
      Promise.all([
        ctx.db.get(supported),
        ctx.db.get(unsupported),
        ctx.db.get(pending),
      ])
    )
    expect(after.map((file) => file?.embeddingStatus)).toEqual([
      "queued",
      "unsupported",
      "not_indexed",
    ])
    const activeEntry = after[0]?.embeddingEntryId

    await t.mutation(internal.migrations.backfillFileEmbeddings, {})
    const repeated = await t.run(async (ctx) => ctx.db.get(supported))
    expect(repeated?.embeddingEntryId).toBe(activeEntry)
  })
})
