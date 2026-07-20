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
