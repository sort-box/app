import { ConvexError, v } from "convex/values"

import { internalMutation, type MutationCtx } from "./_generated/server"

async function currentUsage(ctx: MutationCtx, ownerTokenIdentifier: string) {
  return await ctx.db
    .query("userUsage")
    .withIndex("by_owner_and_kind", (q) =>
      q.eq("ownerTokenIdentifier", ownerTokenIdentifier).eq("kind", "ai")
    )
    .unique()
}

export const checkAllowance = internalMutation({
  args: { ownerTokenIdentifier: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const entitlement = await ctx.db
      .query("userEntitlements")
      .withIndex("by_owner_and_kind", (q) =>
        q.eq("ownerTokenIdentifier", args.ownerTokenIdentifier).eq("kind", "ai")
      )
      .unique()
    if (!entitlement || entitlement.kind !== "ai") {
      throw new ConvexError("AI_ENTITLEMENT_NOT_CONFIGURED")
    }
    const usage = await currentUsage(ctx, args.ownerTokenIdentifier)
    if (
      usage?.kind === "ai" &&
      usage.inputTokens + usage.outputTokens >= entitlement.tokenLimit
    ) {
      throw new ConvexError("AI_USAGE_LIMIT_EXCEEDED")
    }
    return null
  },
})

export const record = internalMutation({
  args: {
    ownerTokenIdentifier: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (
      !Number.isInteger(args.inputTokens) ||
      args.inputTokens < 0 ||
      !Number.isInteger(args.outputTokens) ||
      args.outputTokens < 0
    ) {
      throw new ConvexError("INVALID_AI_USAGE")
    }
    const usage = await currentUsage(ctx, args.ownerTokenIdentifier)
    if (usage?.kind === "ai") {
      await ctx.db.patch(usage._id, {
        inputTokens: usage.inputTokens + args.inputTokens,
        outputTokens: usage.outputTokens + args.outputTokens,
      })
    } else {
      await ctx.db.insert("userUsage", {
        ownerTokenIdentifier: args.ownerTokenIdentifier,
        kind: "ai",
        inputTokens: args.inputTokens,
        outputTokens: args.outputTokens,
      })
    }
    return null
  },
})
