/// <reference types="vite/client" />
import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"

import { internal } from "./_generated/api"
import schema from "./schema"

const modules = import.meta.glob("./**/*.ts")
const owner = {
  ownerClerkUserId: "owner",
  ownerTokenIdentifier: "issuer|owner",
}

describe("files authorization", () => {
  it("rejects trusted file HTTP requests without the service identity", async () => {
    const t = convexTest(schema, modules)
    const response = await t.fetch("/internal/files/rest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "createUpload" }),
    })

    expect(response.status).toBe(401)
  })

  it("allocates opaque unique keys inside trusted mutations", async () => {
    const t = convexTest(schema, modules)
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
    const t = convexTest(schema, modules)
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
    const t = convexTest(schema, modules)
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
    const t = convexTest(schema, modules)
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

  it("lets a retry supersede a stale pending upload at the same path", async () => {
    const t = convexTest(schema, modules)
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
    const t = convexTest(schema, modules)
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
    const t = convexTest(schema, modules)
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
    const t = convexTest(schema, modules)
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
    const t = convexTest(schema, modules)
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
    const t = convexTest(schema, modules)
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

  it("deletes an empty folder and prunes its implicit ancestors", async () => {
    const t = convexTest(schema, modules)
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
    const t = convexTest(schema, modules)
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
    const t = convexTest(schema, modules)
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
    const t = convexTest(schema, modules)
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
    const t = convexTest(schema, modules)
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
