/// <reference types="vite/client" />
import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"

import { api, internal } from "./_generated/api"
import schema from "./schema"

const modules = import.meta.glob("./**/*.ts")

describe("files authorization", () => {
  it("rejects transition HTTP requests without the service identity", async () => {
    const t = convexTest(schema, modules)
    const response = await t.fetch("/internal/files/transition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operation: "markReady",
        fileId: "attacker-controlled",
      }),
    })

    expect(response.status).toBe(401)
  })

  it("allocates opaque unique keys inside Convex", async () => {
    const t = convexTest(schema, modules)
    const user = t.withIdentity({
      subject: "user_a",
      tokenIdentifier: "issuer|user_a",
    })

    const first = await user.mutation(api.files.createPending, {
      originalName: "first.txt",
      declaredContentType: "text/plain",
      declaredSize: 1,
    })
    const second = await user.mutation(api.files.createPending, {
      originalName: "second.txt",
      declaredContentType: "text/plain",
      declaredSize: 1,
    })

    expect(first.objectKey).toMatch(/^files\/[0-9a-f-]{36}$/)
    expect(second.objectKey).not.toBe(first.objectKey)
  })

  it("does not reveal another user's metadata", async () => {
    const t = convexTest(schema, modules)
    const owner = t.withIdentity({
      subject: "owner",
      tokenIdentifier: "issuer|owner",
    })
    const attacker = t.withIdentity({
      subject: "attacker",
      tokenIdentifier: "issuer|attacker",
    })
    const created = await owner.mutation(api.files.createPending, {
      originalName: "private.txt",
      declaredContentType: "text/plain",
      declaredSize: 1,
    })

    await expect(
      attacker.query(api.files.getOwned, { fileId: created.fileId })
    ).resolves.toBeNull()
  })

  it("rejects internal transitions for a different owner", async () => {
    const t = convexTest(schema, modules)
    const owner = t.withIdentity({
      subject: "owner",
      tokenIdentifier: "issuer|owner",
    })
    const created = await owner.mutation(api.files.createPending, {
      originalName: "private.txt",
      declaredContentType: "text/plain",
      declaredSize: 1,
    })

    await expect(
      t.mutation(internal.fileTransitions.markReady, {
        fileId: created.fileId,
        ownerTokenIdentifier: "issuer|attacker",
        verifiedContentType: "text/plain",
        verifiedSize: 1,
      })
    ).rejects.toThrow("File not found")
  })

  it("cannot mark a ready file as failed", async () => {
    const t = convexTest(schema, modules)
    const owner = t.withIdentity({
      subject: "owner",
      tokenIdentifier: "issuer|owner",
    })
    const created = await owner.mutation(api.files.createPending, {
      originalName: "complete.txt",
      declaredContentType: "text/plain",
      declaredSize: 1,
    })
    await t.mutation(internal.fileTransitions.markReady, {
      fileId: created.fileId,
      ownerTokenIdentifier: "issuer|owner",
      verifiedContentType: "text/plain",
      verifiedSize: 1,
    })

    await expect(
      t.mutation(internal.fileTransitions.markFailed, {
        fileId: created.fileId,
        ownerTokenIdentifier: "issuer|owner",
        failureCode: "FORGED",
      })
    ).rejects.toThrow("Invalid file state")
  })

  it("enforces owner-scoped paths and quota atomically", async () => {
    const t = convexTest(schema, modules)
    const owner = t.withIdentity({
      subject: "owner",
      tokenIdentifier: "issuer|owner",
    })
    const first = await owner.mutation(api.fileRest.createUpload, {
      path: "/private/report.pdf",
      parentPath: "/private",
      basename: "report.pdf",
      contentType: "application/pdf",
      size: 8,
      quota: 10,
    })

    await expect(
      owner.mutation(api.fileRest.createUpload, {
        path: "/private/report.pdf",
        parentPath: "/private",
        basename: "report.pdf",
        contentType: "application/pdf",
        size: 1,
        quota: 10,
      })
    ).rejects.toThrow("PATH_CONFLICT")
    await expect(
      owner.mutation(api.fileRest.createUpload, {
        path: "/private/other.pdf",
        parentPath: "/private",
        basename: "other.pdf",
        contentType: "application/pdf",
        size: 3,
        quota: 10,
      })
    ).rejects.toThrow("QUOTA_EXCEEDED")

    const attacker = t.withIdentity({
      subject: "attacker",
      tokenIdentifier: "issuer|attacker",
    })
    await expect(
      attacker.query(api.fileRest.getOwned, { fileId: first.fileId })
    ).resolves.toBeNull()
  })

  it("rate limits each authenticated user independently", async () => {
    const t = convexTest(schema, modules)
    const user = t.withIdentity({
      subject: "user",
      tokenIdentifier: "issuer|user",
    })
    const other = t.withIdentity({
      subject: "other",
      tokenIdentifier: "issuer|other",
    })

    expect(
      await user.mutation(api.fileRest.consumeRateLimit, {
        bucket: "upload",
        limit: 1,
      })
    ).toEqual({ allowed: true, retryAfter: 0 })
    expect(
      await user.mutation(api.fileRest.consumeRateLimit, {
        bucket: "upload",
        limit: 1,
      })
    ).toMatchObject({ allowed: false })
    expect(
      await other.mutation(api.fileRest.consumeRateLimit, {
        bucket: "upload",
        limit: 1,
      })
    ).toEqual({ allowed: true, retryAfter: 0 })
  })
})
