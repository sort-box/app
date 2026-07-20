import { Migrations } from "@convex-dev/migrations"

import { components } from "./_generated/api"
import type { DataModel } from "./_generated/dataModel"
import { internalMutation } from "./_generated/server"
import { queueFileEmbedding } from "./documentEmbedding"
import { getOrCreateFileEntitlement, getOrCreateFileUsage } from "./userUsage"

const migrations = new Migrations<DataModel>(components.migrations, {
  internalMutation,
})

export const backfillFileEmbeddings = migrations.define({
  table: "files",
  batchSize: 10,
  migrateOne: async (ctx, file) => {
    if (file.embeddingStatus !== undefined) return
    if (file.status === "ready") {
      await queueFileEmbedding(ctx, file)
      return
    }
    await ctx.db.patch(file._id, {
      embeddingStatus: "not_indexed",
      embeddingUpdatedAt: Date.now(),
    })
  },
})

export const backfillUnifiedFileUsage = migrations.define({
  table: "fileUsage",
  migrateOne: async (ctx, legacy) => {
    const existing = await ctx.db
      .query("userUsage")
      .withIndex("by_owner_and_kind", (q) =>
        q
          .eq("ownerTokenIdentifier", legacy.ownerTokenIdentifier)
          .eq("kind", "file")
      )
      .unique()
    if (!existing) {
      await getOrCreateFileUsage(ctx, legacy.ownerTokenIdentifier)
    }
    await getOrCreateFileEntitlement(ctx, legacy.ownerTokenIdentifier)
  },
})
