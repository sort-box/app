/// <reference types="vite/client" />
import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { internal } from "./_generated/api"
import schema from "./schema"

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
  vi.useRealTimers()
})

describe("ai file tools", () => {
  it("rejects AI file requests without the service identity", async () => {
    const t = testBackend()
    const response = await t.fetch("/internal/ai/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "search", query: "hello", limit: 5 }),
    })

    expect(response.status).toBe(401)
  })

  it("does not read chunks of another user's file", async () => {
    const t = testBackend()
    const created = await t.mutation(internal.fileRest.createUpload, {
      ...owner,
      path: "/notes.txt",
      parentPath: "/",
      basename: "notes.txt",
      contentType: "text/plain",
      size: 5,
    })

    await expect(
      t.query(internal.aiFileTools.readOwnedFileChunks, {
        ownerTokenIdentifier: "issuer|someone-else",
        fileId: created.fileId,
        cursor: null,
        numItems: 5,
      })
    ).rejects.toThrow(/FILE_NOT_FOUND/)
  })

  it("reports content that has not finished indexing", async () => {
    const t = testBackend()
    const created = await t.mutation(internal.fileRest.createUpload, {
      ...owner,
      path: "/notes.txt",
      parentPath: "/",
      basename: "notes.txt",
      contentType: "text/plain",
      size: 5,
    })
    await t.mutation(internal.fileRest.completeUpload, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      fileId: created.fileId,
      verifiedContentType: "text/plain",
      verifiedSize: 5,
      etag: "etag",
    })

    await expect(
      t.query(internal.aiFileTools.readOwnedFileChunks, {
        ownerTokenIdentifier: owner.ownerTokenIdentifier,
        fileId: created.fileId,
        cursor: null,
        numItems: 5,
      })
    ).rejects.toThrow(/CONTENT_NOT_INDEXED/)
  })

  it.each(["/notes.txt", "notes.txt"])(
    "resolves an owned file path passed as %s",
    async (fileId) => {
      const t = testBackend()
      const created = await t.mutation(internal.fileRest.createUpload, {
        ...owner,
        path: "/notes.txt",
        parentPath: "/",
        basename: "notes.txt",
        contentType: "text/plain",
        size: 5,
      })
      await t.mutation(internal.fileRest.completeUpload, {
        ownerTokenIdentifier: owner.ownerTokenIdentifier,
        fileId: created.fileId,
        verifiedContentType: "text/plain",
        verifiedSize: 5,
        etag: "etag",
      })

      await expect(
        t.query(internal.aiFileTools.readOwnedFileChunks, {
          ownerTokenIdentifier: owner.ownerTokenIdentifier,
          fileId,
          cursor: null,
          numItems: 5,
        })
      ).rejects.toThrow(/CONTENT_NOT_INDEXED/)
    }
  )

  it("only hydrates search results for the owner's ready files", async () => {
    const t = testBackend()
    const created = await t.mutation(internal.fileRest.createUpload, {
      ...owner,
      path: "/notes.txt",
      parentPath: "/",
      basename: "notes.txt",
      contentType: "text/plain",
      size: 5,
    })

    const pending = await t.query(internal.aiFileTools.getOwnedReadyFiles, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      fileIds: [created.fileId],
    })
    expect(pending).toEqual([])

    await t.mutation(internal.fileRest.completeUpload, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      fileId: created.fileId,
      verifiedContentType: "text/plain",
      verifiedSize: 5,
      etag: "etag",
    })

    const ready = await t.query(internal.aiFileTools.getOwnedReadyFiles, {
      ownerTokenIdentifier: owner.ownerTokenIdentifier,
      fileIds: [created.fileId],
    })
    expect(ready).toEqual([{ fileId: created.fileId, path: "/notes.txt" }])

    const foreign = await t.query(internal.aiFileTools.getOwnedReadyFiles, {
      ownerTokenIdentifier: "issuer|someone-else",
      fileIds: [created.fileId],
    })
    expect(foreign).toEqual([])
  })
})
