import type { Doc } from "./_generated/dataModel"
import type { MutationCtx } from "./_generated/server"

export const DEFAULT_FILE_STORAGE_LIMIT_BYTES = 10 * 1024 ** 3

export async function getOrCreateFileUsage(
  ctx: MutationCtx,
  ownerTokenIdentifier: string
): Promise<Doc<"userUsage"> & { kind: "file" }> {
  const current = await ctx.db
    .query("userUsage")
    .withIndex("by_owner_and_kind", (q) =>
      q.eq("ownerTokenIdentifier", ownerTokenIdentifier).eq("kind", "file")
    )
    .unique()
  if (current?.kind === "file") return current

  const legacy = await ctx.db
    .query("fileUsage")
    .withIndex("by_owner", (q) =>
      q.eq("ownerTokenIdentifier", ownerTokenIdentifier)
    )
    .unique()
  const id = await ctx.db.insert("userUsage", {
    ownerTokenIdentifier,
    kind: "file",
    reservedBytes: legacy?.reservedBytes ?? 0,
    usedBytes: legacy?.usedBytes ?? 0,
  })
  return (await ctx.db.get(id)) as Doc<"userUsage"> & { kind: "file" }
}

export async function getOrCreateFileEntitlement(
  ctx: MutationCtx,
  ownerTokenIdentifier: string
): Promise<Doc<"userEntitlements"> & { kind: "file" }> {
  const current = await ctx.db
    .query("userEntitlements")
    .withIndex("by_owner_and_kind", (q) =>
      q.eq("ownerTokenIdentifier", ownerTokenIdentifier).eq("kind", "file")
    )
    .unique()
  if (current?.kind === "file") return current

  const id = await ctx.db.insert("userEntitlements", {
    ownerTokenIdentifier,
    kind: "file",
    storageLimitBytes: DEFAULT_FILE_STORAGE_LIMIT_BYTES,
  })
  return (await ctx.db.get(id)) as Doc<"userEntitlements"> & { kind: "file" }
}
