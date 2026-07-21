import { z } from "zod"

import type { AiProviderError } from "@/server/ai/ai-provider"

export const MAX_CHAT_MESSAGE_LENGTH = 16_000

export const chatRequestSchema = z
  .object({
    conversation_id: z.string().min(1).nullable().optional(),
    message: z.string().trim().min(1).max(MAX_CHAT_MESSAGE_LENGTH),
    proposal_revision: z
      .object({
        proposal_id: z.string().min(1),
        feedback: z.string().trim().min(1).max(2_000),
      })
      .strict()
      .optional(),
  })
  .strict()

export type ChatRequest = z.infer<typeof chatRequestSchema>

export type ChatError = {
  code: AiProviderError["code"]
  message: string
}

/** Events streamed by /api/chat as JSON `data:` lines of an SSE response. */
export type ChatStreamEvent =
  | { type: "conversation-id"; conversationId: string }
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; name: string }
  | { type: "organization-proposal"; planId: string; revision: number }
  | { type: "error"; error: ChatError }
  | { type: "done" }
