import { query } from "./_generated/server"

export const current = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity()

    return {
      authenticated: identity !== null,
      subject: identity?.subject ?? null,
      service: "convex",
    }
  },
})
