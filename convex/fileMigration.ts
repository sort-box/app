import { v } from "convex/values"

import { internal } from "./_generated/api"
import { internalMutation } from "./_generated/server"
import { getOrCreateFileUsage } from "./userUsage"

const BATCH_SIZE = 50

function safeBasename(value: string) {
  const normalized = value
    .normalize("NFC")
    .replaceAll("\\", "_")
    .split("")
    .map((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127 || character === "/" ? "_" : character
    })
    .join("")
    .replace(/^\.+$/, "_")
    .slice(0, 200)
  return normalized || "file"
}

export const backfillFiles = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ processed: v.number(), done: v.boolean() }),
  handler: async (ctx, args) => {
    const page = await ctx.db.query("files").paginate({
      cursor: args.cursor ?? null,
      numItems: BATCH_SIZE,
    })
    for (const file of page.page) {
      let path = file.path
      if (!path) {
        const basename = safeBasename(file.originalName)
        path = `/${basename}`
        const conflict = await ctx.db
          .query("files")
          .withIndex("by_owner_and_path", (q) =>
            q
              .eq("ownerTokenIdentifier", file.ownerTokenIdentifier)
              .eq("path", path)
          )
          .first()
        if (conflict && conflict._id !== file._id) {
          path = `/${basename}-${file._id}`
        }
        await ctx.db.patch(file._id, {
          path,
          parentPath: "/",
          basename: path.slice(1),
          operation: "upload",
        })
      }
      if (!file.usageBackfilledAt) {
        const current = await getOrCreateFileUsage(
          ctx,
          file.ownerTokenIdentifier
        )
        const reserved = file.status === "pending" ? file.declaredSize : 0
        const used =
          file.status === "ready" || file.status === "deleting"
            ? (file.verifiedSize ?? file.declaredSize)
            : 0
        await ctx.db.patch(current._id, {
          reservedBytes: current.reservedBytes + reserved,
          usedBytes: current.usedBytes + used,
        })
        await ctx.db.patch(file._id, { usageBackfilledAt: Date.now() })
      }
      const entry = await ctx.db
        .query("fileEntries")
        .withIndex("by_owner_path", (q) =>
          q
            .eq("ownerTokenIdentifier", file.ownerTokenIdentifier)
            .eq("path", path!)
        )
        .first()
      if (!entry) {
        await ctx.db.insert("fileEntries", {
          ownerTokenIdentifier: file.ownerTokenIdentifier,
          path,
          parentPath: file.parentPath ?? "/",
          basename: file.basename ?? path.slice(1),
          kind: "file",
          fileId: file._id,
          status: file.status,
        })
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.fileMigration.backfillFiles, {
        cursor: page.continueCursor,
      })
    }
    return { processed: page.page.length, done: page.isDone }
  },
})
