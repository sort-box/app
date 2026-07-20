import { Migrations } from "@convex-dev/migrations"

import { components } from "./_generated/api"
import type { DataModel } from "./_generated/dataModel"
import { internalMutation } from "./_generated/server"
import { queueFileEmbedding } from "./documentEmbedding"

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
