import { v } from "convex/values"

import type { Doc, Id } from "./_generated/dataModel"
import { mutation, query, type MutationCtx } from "./_generated/server"

const MAX_OPERATIONS = 1_000
const MAX_AFFECTED_ENTRIES = 1_000
const MAX_SUMMARY_LENGTH = 2_000
const MAX_WARNING_LENGTH = 500

const operationInput = v.object({
  beforePath: v.string(),
  afterPath: v.string(),
})

type PlanErrorCode =
  | "PLAN_NOT_FOUND"
  | "PLAN_NOT_APPLICABLE"
  | "PLAN_STALE"
  | "PATH_CONFLICT"
  | "SCOPE_TOO_LARGE"
  | "UNDO_CONFLICT"
  | "INVALID_INPUT"

type Failure = { ok: false; error: { code: PlanErrorCode; message: string } }

function failure(code: PlanErrorCode, message: string): Failure {
  return { ok: false, error: { code, message } }
}

function splitPath(path: string) {
  const segments = path.startsWith("/") ? path.slice(1).split("/") : []
  return {
    path,
    parentPath:
      segments.length <= 1 ? "/" : `/${segments.slice(0, -1).join("/")}`,
    basename: segments.at(-1) ?? "",
  }
}

function validPath(path: string): boolean {
  if (
    path === "/" ||
    !path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.normalize("NFC") !== path
  ) {
    return false
  }
  const segments = path.slice(1).split("/")
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      !Array.from(segment).some((character) => character.charCodeAt(0) < 32)
  )
}

async function ownedPlan(
  ctx: MutationCtx,
  planId: Id<"organizationPlans">,
  ownerTokenIdentifier: string
) {
  const plan = await ctx.db.get(planId)
  return plan?.ownerTokenIdentifier === ownerTokenIdentifier ? plan : null
}

async function planOperations(
  ctx: MutationCtx,
  planId: Id<"organizationPlans">
) {
  return await ctx.db
    .query("organizationPlanOperations")
    .withIndex("by_planId", (q) => q.eq("planId", planId))
    .collect()
}

async function ensureDirectories(
  ctx: MutationCtx,
  ownerTokenIdentifier: string,
  path: string
) {
  if (path === "/") return
  let current = ""
  for (const segment of path.slice(1).split("/")) {
    const parentPath = current || "/"
    current = `${current}/${segment}`
    const existing = await ctx.db
      .query("fileEntries")
      .withIndex("by_owner_path", (q) =>
        q.eq("ownerTokenIdentifier", ownerTokenIdentifier).eq("path", current)
      )
      .first()
    if (existing) continue
    await ctx.db.insert("fileEntries", {
      ownerTokenIdentifier,
      path: current,
      parentPath,
      basename: segment,
      kind: "directory",
      status: "ready",
    })
  }
}

async function pruneDirectories(
  ctx: MutationCtx,
  ownerTokenIdentifier: string,
  startingPath: string
) {
  let path = startingPath
  while (path !== "/") {
    const directory = await ctx.db
      .query("fileEntries")
      .withIndex("by_owner_path", (q) =>
        q.eq("ownerTokenIdentifier", ownerTokenIdentifier).eq("path", path)
      )
      .first()
    if (!directory || directory.kind !== "directory" || directory.explicit) {
      return
    }
    const child = await ctx.db
      .query("fileEntries")
      .withIndex("by_owner_parent_status_path", (q) =>
        q
          .eq("ownerTokenIdentifier", ownerTokenIdentifier)
          .eq("parentPath", path)
          .eq("status", "ready")
      )
      .first()
    if (child) return
    const parent = directory.parentPath
    await ctx.db.delete(directory._id)
    path = parent
  }
}

export const propose = mutation({
  args: {
    conversationId: v.id("chatConversations"),
    previousPlanId: v.optional(v.string()),
    summary: v.string(),
    warnings: v.array(v.string()),
    operations: v.array(operationInput),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity)
      return failure("PLAN_NOT_FOUND", "The conversation was not found.")
    const conversation = await ctx.db.get(args.conversationId)
    if (
      !conversation ||
      conversation.ownerTokenIdentifier !== identity.tokenIdentifier
    ) {
      return failure("PLAN_NOT_FOUND", "The conversation was not found.")
    }
    if (
      args.operations.length === 0 ||
      args.operations.length > MAX_OPERATIONS ||
      args.summary.trim().length === 0 ||
      args.summary.length > MAX_SUMMARY_LENGTH ||
      args.warnings.some((warning) => warning.length > MAX_WARNING_LENGTH)
    ) {
      return failure("SCOPE_TOO_LARGE", "The proposal is empty or too large.")
    }

    const sources = new Set<string>()
    const destinations = new Set<string>()
    const resolved: Array<Doc<"fileEntries">> = []
    for (const operation of args.operations) {
      if (!validPath(operation.beforePath)) {
        return failure(
          "INVALID_INPUT",
          `The source path is invalid: ${operation.beforePath}`
        )
      }
      if (!validPath(operation.afterPath)) {
        return failure(
          "INVALID_INPUT",
          `The destination path is invalid: ${operation.afterPath}`
        )
      }
      if (operation.beforePath === operation.afterPath) {
        return failure(
          "INVALID_INPUT",
          `Source and destination are identical: ${operation.beforePath}`
        )
      }
      if (sources.has(operation.beforePath)) {
        return failure(
          "INVALID_INPUT",
          `The source path is duplicated: ${operation.beforePath}`
        )
      }
      if (destinations.has(operation.afterPath)) {
        return failure(
          "INVALID_INPUT",
          `The destination path is duplicated: ${operation.afterPath}`
        )
      }
      if (
        [...sources].some(
          (path) =>
            operation.beforePath.startsWith(`${path}/`) ||
            path.startsWith(`${operation.beforePath}/`)
        )
      ) {
        return failure(
          "INVALID_INPUT",
          "A proposal cannot move both a folder and its descendant."
        )
      }
      const entry = await ctx.db
        .query("fileEntries")
        .withIndex("by_owner_path", (q) =>
          q
            .eq("ownerTokenIdentifier", identity.tokenIdentifier)
            .eq("path", operation.beforePath)
        )
        .first()
      if (!entry || entry.status !== "ready") {
        return failure(
          "PLAN_STALE",
          `The source no longer exists: ${operation.beforePath}`
        )
      }
      if (
        entry.kind === "directory" &&
        operation.afterPath.startsWith(`${operation.beforePath}/`)
      ) {
        return failure(
          "INVALID_INPUT",
          "A folder cannot be moved inside itself."
        )
      }
      sources.add(operation.beforePath)
      destinations.add(operation.afterPath)
      resolved.push(entry)
    }

    for (const destination of destinations) {
      const occupied = await ctx.db
        .query("fileEntries")
        .withIndex("by_owner_path", (q) =>
          q
            .eq("ownerTokenIdentifier", identity.tokenIdentifier)
            .eq("path", destination)
        )
        .first()
      if (occupied && !sources.has(occupied.path)) {
        return failure(
          "PATH_CONFLICT",
          `A file or folder already exists at ${destination}.`
        )
      }
      let parent = splitPath(destination).parentPath
      while (parent !== "/") {
        const ancestor = await ctx.db
          .query("fileEntries")
          .withIndex("by_owner_path", (q) =>
            q
              .eq("ownerTokenIdentifier", identity.tokenIdentifier)
              .eq("path", parent)
          )
          .first()
        if (ancestor?.kind === "file" && !sources.has(parent)) {
          return failure(
            "PATH_CONFLICT",
            `A destination folder is occupied by a file: ${parent}.`
          )
        }
        parent = splitPath(parent).parentPath
      }
    }

    let previous: Doc<"organizationPlans"> | null = null
    const previousPlanId = args.previousPlanId
      ? ctx.db.normalizeId("organizationPlans", args.previousPlanId)
      : null
    if (previousPlanId) {
      previous = await ctx.db.get(previousPlanId)
      if (
        !previous ||
        previous.ownerTokenIdentifier !== identity.tokenIdentifier ||
        previous.conversationId !== args.conversationId ||
        previous.status !== "draft"
      ) {
        return failure(
          "PLAN_NOT_APPLICABLE",
          "The proposal can no longer be revised."
        )
      }
    }
    const now = Date.now()
    const planId = await ctx.db.insert("organizationPlans", {
      ownerTokenIdentifier: identity.tokenIdentifier,
      conversationId: args.conversationId,
      ...(previous ? { previousPlanId: previous._id } : {}),
      revision: (previous?.revision ?? 0) + 1,
      status: "draft",
      summary: args.summary.trim(),
      warnings: args.warnings,
      createdAt: now,
    })
    for (const [index, operation] of args.operations.entries()) {
      const entry = resolved[index]
      await ctx.db.insert("organizationPlanOperations", {
        planId,
        ownerTokenIdentifier: identity.tokenIdentifier,
        entryId: entry._id,
        ...(entry.fileId ? { fileId: entry.fileId } : {}),
        kind: entry.kind,
        beforePath: operation.beforePath,
        afterPath: operation.afterPath,
      })
    }
    if (previous) await ctx.db.patch(previous._id, { status: "superseded" })
    return {
      ok: true as const,
      value: { planId, revision: (previous?.revision ?? 0) + 1 },
    }
  },
})

export const listForConversation = query({
  args: { conversationId: v.id("chatConversations") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity()
    const conversation = identity ? await ctx.db.get(args.conversationId) : null
    if (
      !identity ||
      !conversation ||
      conversation.ownerTokenIdentifier !== identity.tokenIdentifier
    ) {
      return []
    }
    const plans = await ctx.db
      .query("organizationPlans")
      .withIndex("by_conversationId_and_createdAt", (q) =>
        q.eq("conversationId", args.conversationId)
      )
      .collect()
    const latestApplied = [...plans]
      .filter((plan) => plan.status === "applied")
      .sort((a, b) => b.createdAt - a.createdAt)[0]?._id
    return await Promise.all(
      plans.map(async (plan) => ({
        planId: plan._id,
        revision: plan.revision,
        status: plan.status,
        summary: plan.summary,
        warnings: plan.warnings,
        createdAt: plan.createdAt,
        canUndo: plan._id === latestApplied,
        operations: (
          await ctx.db
            .query("organizationPlanOperations")
            .withIndex("by_planId", (q) => q.eq("planId", plan._id))
            .collect()
        ).map((operation) => ({
          operationId: operation._id,
          kind: operation.kind,
          beforePath: operation.beforePath,
          afterPath: operation.afterPath,
          undoStatus: operation.undoStatus ?? null,
          undoReason: operation.undoReason ?? null,
        })),
      }))
    )
  },
})

async function collectAffected(
  ctx: MutationCtx,
  ownerTokenIdentifier: string,
  operations: Array<Doc<"organizationPlanOperations">>,
  direction: "apply" | "undo"
) {
  const affected = new Map<
    Id<"fileEntries">,
    { entry: Doc<"fileEntries">; path: string }
  >()
  for (const operation of operations) {
    const entry = await ctx.db.get(operation.entryId)
    const sourcePath =
      direction === "apply" ? operation.beforePath : operation.afterPath
    const destinationPath =
      direction === "apply" ? operation.afterPath : operation.beforePath
    if (
      !entry ||
      entry.ownerTokenIdentifier !== ownerTokenIdentifier ||
      entry.path !== sourcePath
    ) {
      return null
    }
    affected.set(entry._id, { entry, path: destinationPath })
    if (entry.kind === "directory") {
      const prefix = `${sourcePath}/`
      const descendants = await ctx.db
        .query("fileEntries")
        .withIndex("by_owner_path", (q) =>
          q
            .eq("ownerTokenIdentifier", ownerTokenIdentifier)
            .gte("path", prefix)
            .lt("path", `${prefix}\uffff`)
        )
        .take(MAX_AFFECTED_ENTRIES + 1)
      for (const descendant of descendants) {
        affected.set(descendant._id, {
          entry: descendant,
          path: destinationPath + descendant.path.slice(sourcePath.length),
        })
      }
    }
    if (affected.size > MAX_AFFECTED_ENTRIES) return "too-large" as const
  }
  return affected
}

async function pathsAreAvailable(
  ctx: MutationCtx,
  ownerTokenIdentifier: string,
  affected: Map<Id<"fileEntries">, { entry: Doc<"fileEntries">; path: string }>
) {
  const finalPaths = new Set<string>()
  for (const { path } of affected.values()) {
    if (finalPaths.has(path)) return false
    finalPaths.add(path)
    const occupied = await ctx.db
      .query("fileEntries")
      .withIndex("by_owner_path", (q) =>
        q.eq("ownerTokenIdentifier", ownerTokenIdentifier).eq("path", path)
      )
      .first()
    if (occupied && !affected.has(occupied._id)) return false
  }
  return true
}

async function writePaths(
  ctx: MutationCtx,
  ownerTokenIdentifier: string,
  affected: Map<Id<"fileEntries">, { entry: Doc<"fileEntries">; path: string }>
) {
  const oldParents = new Set<string>()
  for (const { entry, path } of affected.values()) {
    oldParents.add(entry.parentPath)
    const parsed = splitPath(path)
    await ctx.db.patch(entry._id, {
      path,
      parentPath: parsed.parentPath,
      basename: parsed.basename,
    })
    if (entry.fileId) {
      await ctx.db.patch(entry.fileId, {
        path,
        parentPath: parsed.parentPath,
        basename: parsed.basename,
        originalName: parsed.basename,
      })
    }
  }
  for (const { path } of affected.values()) {
    await ensureDirectories(
      ctx,
      ownerTokenIdentifier,
      splitPath(path).parentPath
    )
  }
  for (const parent of oldParents)
    await pruneDirectories(ctx, ownerTokenIdentifier, parent)
}

export const confirm = mutation({
  args: { planId: v.id("organizationPlans") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity()
    const plan = identity
      ? await ownedPlan(ctx, args.planId, identity.tokenIdentifier)
      : null
    if (!identity || !plan)
      return failure("PLAN_NOT_FOUND", "The proposal was not found.")
    if (plan.status !== "draft")
      return failure(
        "PLAN_NOT_APPLICABLE",
        "The proposal can no longer be applied."
      )
    const operations = await planOperations(ctx, plan._id)
    const affected = await collectAffected(
      ctx,
      identity.tokenIdentifier,
      operations,
      "apply"
    )
    if (affected === "too-large")
      return failure(
        "SCOPE_TOO_LARGE",
        "The proposal affects too many entries."
      )
    if (
      !affected ||
      !(await pathsAreAvailable(ctx, identity.tokenIdentifier, affected))
    ) {
      await ctx.db.patch(plan._id, { status: "stale" })
      return failure(
        "PLAN_STALE",
        "Files changed after this proposal was created. Create a refreshed proposal."
      )
    }
    await writePaths(ctx, identity.tokenIdentifier, affected)
    await ctx.db.patch(plan._id, { status: "applied", appliedAt: Date.now() })
    return { ok: true as const, value: null }
  },
})

export const reject = mutation({
  args: { planId: v.id("organizationPlans") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity()
    const plan = identity
      ? await ownedPlan(ctx, args.planId, identity.tokenIdentifier)
      : null
    if (!plan) return failure("PLAN_NOT_FOUND", "The proposal was not found.")
    if (plan.status !== "draft")
      return failure(
        "PLAN_NOT_APPLICABLE",
        "The proposal can no longer be rejected."
      )
    await ctx.db.patch(plan._id, { status: "rejected" })
    return { ok: true as const, value: null }
  },
})

export const undo = mutation({
  args: { planId: v.id("organizationPlans") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity()
    const plan = identity
      ? await ownedPlan(ctx, args.planId, identity.tokenIdentifier)
      : null
    if (!identity || !plan)
      return failure("PLAN_NOT_FOUND", "The proposal was not found.")
    if (plan.status !== "applied")
      return failure("PLAN_NOT_APPLICABLE", "This proposal cannot be undone.")
    const newerApplied = await ctx.db
      .query("organizationPlans")
      .withIndex("by_conversationId_and_createdAt", (q) =>
        q
          .eq("conversationId", plan.conversationId)
          .gt("createdAt", plan.createdAt)
      )
      .filter((q) => q.eq(q.field("status"), "applied"))
      .first()
    if (newerApplied)
      return failure(
        "PLAN_NOT_APPLICABLE",
        "Only the latest applied proposal can be undone."
      )

    const operations = await planOperations(ctx, plan._id)
    const eligible: Array<Doc<"organizationPlanOperations">> = []
    let skipped = 0
    for (const operation of operations) {
      const entry = await ctx.db.get(operation.entryId)
      if (!entry || entry.path !== operation.afterPath) {
        skipped += 1
        await ctx.db.patch(operation._id, {
          undoStatus: "skipped",
          undoReason: "The item changed after the proposal was applied.",
        })
      } else {
        eligible.push(operation)
      }
    }
    const affected = await collectAffected(
      ctx,
      identity.tokenIdentifier,
      eligible,
      "undo"
    )
    if (affected === "too-large")
      return failure("SCOPE_TOO_LARGE", "The undo affects too many entries.")
    let restored = 0
    if (
      affected &&
      (await pathsAreAvailable(ctx, identity.tokenIdentifier, affected))
    ) {
      await writePaths(ctx, identity.tokenIdentifier, affected)
      for (const operation of eligible) {
        restored += 1
        await ctx.db.patch(operation._id, {
          undoStatus: "restored",
          undoReason: undefined,
        })
      }
    } else {
      for (const operation of eligible) {
        const individual = await collectAffected(
          ctx,
          identity.tokenIdentifier,
          [operation],
          "undo"
        )
        if (
          individual &&
          individual !== "too-large" &&
          (await pathsAreAvailable(ctx, identity.tokenIdentifier, individual))
        ) {
          await writePaths(ctx, identity.tokenIdentifier, individual)
          restored += 1
          await ctx.db.patch(operation._id, {
            undoStatus: "restored",
            undoReason: undefined,
          })
        } else {
          skipped += 1
          await ctx.db.patch(operation._id, {
            undoStatus: "skipped",
            undoReason: "The original path is occupied.",
          })
        }
      }
    }
    await ctx.db.patch(plan._id, {
      status: skipped === 0 ? "undone" : "partially_undone",
      undoneAt: Date.now(),
    })
    return { ok: true as const, value: { restored, skipped } }
  },
})
