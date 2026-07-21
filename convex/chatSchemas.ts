import { v } from "convex/values"

export const storedAiMessage = v.union(
  v.object({ role: v.literal("user"), content: v.string() }),
  v.object({
    role: v.literal("assistant"),
    content: v.string(),
    toolCalls: v.optional(
      v.array(
        v.object({
          id: v.string(),
          name: v.string(),
          argumentsJson: v.string(),
        })
      )
    ),
  }),
  v.object({
    role: v.literal("tool"),
    toolCallId: v.string(),
    content: v.string(),
  })
)
