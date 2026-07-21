/// <reference types="vite/client" />
import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"

import { api } from "./_generated/api"
import schema from "./schema"

const modules = import.meta.glob("./**/*.ts")
const identity = { tokenIdentifier: "issuer|owner" }

async function seed() {
  const t = convexTest(schema, modules)
  const ids = await t.run(async (ctx) => {
    const conversationId = await ctx.db.insert("chatConversations", {
      ownerTokenIdentifier: identity.tokenIdentifier,
      nextSequence: 0,
      updatedAt: Date.now(),
    })
    const fileId = await ctx.db.insert("files", {
      ownerClerkUserId: "owner",
      ownerTokenIdentifier: identity.tokenIdentifier,
      objectKey: "files/report",
      originalName: "report.pdf",
      declaredContentType: "application/pdf",
      declaredSize: 10,
      verifiedContentType: "application/pdf",
      verifiedSize: 10,
      status: "ready",
      path: "/report.pdf",
      parentPath: "/",
      basename: "report.pdf",
    })
    const entryId = await ctx.db.insert("fileEntries", {
      ownerTokenIdentifier: identity.tokenIdentifier,
      path: "/report.pdf",
      parentPath: "/",
      basename: "report.pdf",
      kind: "file",
      fileId,
      status: "ready",
    })
    return { conversationId, fileId, entryId }
  })
  return { t, asOwner: t.withIdentity(identity), ...ids }
}

describe("organization proposals", () => {
  it("creates a preview without moving files, then applies and undoes it", async () => {
    const { t, asOwner, conversationId, fileId } = await seed()
    const proposed = await asOwner.mutation(api.organizationPlans.propose, {
      conversationId,
      summary: "Put reports together.",
      warnings: [],
      operations: [
        { beforePath: "/report.pdf", afterPath: "/Work/report.pdf" },
      ],
    })
    expect(proposed.ok).toBe(true)
    if (!proposed.ok) return

    expect((await t.run((ctx) => ctx.db.get(fileId)))?.path).toBe("/report.pdf")
    await expect(
      asOwner.mutation(api.organizationPlans.confirm, {
        planId: proposed.value.planId,
      })
    ).resolves.toEqual({ ok: true, value: null })
    expect((await t.run((ctx) => ctx.db.get(fileId)))?.path).toBe(
      "/Work/report.pdf"
    )

    const undone = await asOwner.mutation(api.organizationPlans.undo, {
      planId: proposed.value.planId,
    })
    expect(undone).toEqual({ ok: true, value: { restored: 1, skipped: 0 } })
    expect((await t.run((ctx) => ctx.db.get(fileId)))?.path).toBe("/report.pdf")
  })

  it("ignores an invented previous-plan placeholder on an initial proposal", async () => {
    const { asOwner, conversationId } = await seed()
    const proposed = await asOwner.mutation(api.organizationPlans.propose, {
      conversationId,
      previousPlanId: "init",
      summary: "Create an initial proposal.",
      warnings: [],
      operations: [
        { beforePath: "/report.pdf", afterPath: "/Work/report.pdf" },
      ],
    })

    expect(proposed).toMatchObject({
      ok: true,
      value: { revision: 1 },
    })
  })

  it("marks a proposal stale and makes no changes when its source moved", async () => {
    const { t, asOwner, conversationId, fileId, entryId } = await seed()
    const proposed = await asOwner.mutation(api.organizationPlans.propose, {
      conversationId,
      summary: "Move the report.",
      warnings: [],
      operations: [
        { beforePath: "/report.pdf", afterPath: "/Work/report.pdf" },
      ],
    })
    if (!proposed.ok) throw new Error("proposal failed")
    await t.run(async (ctx) => {
      await ctx.db.patch(fileId, {
        path: "/changed.pdf",
        parentPath: "/",
        basename: "changed.pdf",
      })
      await ctx.db.patch(entryId, {
        path: "/changed.pdf",
        parentPath: "/",
        basename: "changed.pdf",
      })
    })

    const result = await asOwner.mutation(api.organizationPlans.confirm, {
      planId: proposed.value.planId,
    })
    expect(result).toMatchObject({ ok: false, error: { code: "PLAN_STALE" } })
    expect((await t.run((ctx) => ctx.db.get(fileId)))?.path).toBe(
      "/changed.pdf"
    )
  })

  it("undoes unchanged items and skips an item changed later", async () => {
    const { t, asOwner, conversationId, fileId, entryId } = await seed()
    const second = await t.run(async (ctx) => {
      const secondFileId = await ctx.db.insert("files", {
        ownerClerkUserId: "owner",
        ownerTokenIdentifier: identity.tokenIdentifier,
        objectKey: "files/notes",
        originalName: "notes.txt",
        declaredContentType: "text/plain",
        declaredSize: 2,
        status: "ready",
        path: "/notes.txt",
        parentPath: "/",
        basename: "notes.txt",
      })
      const secondEntryId = await ctx.db.insert("fileEntries", {
        ownerTokenIdentifier: identity.tokenIdentifier,
        path: "/notes.txt",
        parentPath: "/",
        basename: "notes.txt",
        kind: "file",
        fileId: secondFileId,
        status: "ready",
      })
      return { secondFileId, secondEntryId }
    })
    const proposed = await asOwner.mutation(api.organizationPlans.propose, {
      conversationId,
      summary: "Sort two files.",
      warnings: [],
      operations: [
        { beforePath: "/report.pdf", afterPath: "/Work/report.pdf" },
        { beforePath: "/notes.txt", afterPath: "/Notes/notes.txt" },
      ],
    })
    if (!proposed.ok) throw new Error("proposal failed")
    await asOwner.mutation(api.organizationPlans.confirm, {
      planId: proposed.value.planId,
    })
    await t.run(async (ctx) => {
      await ctx.db.patch(entryId, {
        path: "/Elsewhere/report.pdf",
        parentPath: "/Elsewhere",
      })
      await ctx.db.patch(fileId, {
        path: "/Elsewhere/report.pdf",
        parentPath: "/Elsewhere",
      })
    })

    const result = await asOwner.mutation(api.organizationPlans.undo, {
      planId: proposed.value.planId,
    })
    expect(result).toEqual({ ok: true, value: { restored: 1, skipped: 1 } })
    expect((await t.run((ctx) => ctx.db.get(second.secondFileId)))?.path).toBe(
      "/notes.txt"
    )
    expect((await t.run((ctx) => ctx.db.get(fileId)))?.path).toBe(
      "/Elsewhere/report.pdf"
    )
    expect(
      await t.run((ctx) => ctx.db.get(second.secondEntryId))
    ).not.toBeNull()
  })
})
