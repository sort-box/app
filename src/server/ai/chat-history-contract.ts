import { z } from "zod"

export const MAX_STORED_MESSAGE_BYTES = 16_000
export const MAX_STORED_TOOL_RESULT_BYTES = 64_000
export const MAX_TOOL_RESULT_OUTPUT_BYTES = 48 * 1024
export const MAX_STORED_MESSAGES_PER_APPEND = 10
export const MAX_STORED_TOOL_CALLS = 8

const encoder = new TextEncoder()

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength
}

function boundedString(maxBytes: number) {
  return z.string().refine((value) => utf8ByteLength(value) <= maxBytes)
}

export const storedMessageSchema = z.discriminatedUnion("role", [
  z
    .object({
      role: z.literal("user"),
      content: boundedString(MAX_STORED_MESSAGE_BYTES),
    })
    .strict(),
  z
    .object({
      role: z.literal("assistant"),
      content: boundedString(MAX_STORED_MESSAGE_BYTES),
      toolCalls: z
        .array(
          z
            .object({
              id: z.string(),
              name: z.string(),
              argumentsJson: boundedString(MAX_STORED_MESSAGE_BYTES),
            })
            .strict()
        )
        .max(MAX_STORED_TOOL_CALLS)
        .optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal("tool"),
      toolCallId: z.string(),
      content: boundedString(MAX_STORED_TOOL_RESULT_BYTES),
    })
    .strict(),
])

export const chatHistoryRequestSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("start"),
      conversationId: z.string().nullable(),
      content: boundedString(MAX_STORED_MESSAGE_BYTES).refine(
        (content) => content.length > 0
      ),
    })
    .strict(),
  z
    .object({
      operation: z.literal("append"),
      conversationId: z.string(),
      messages: z
        .array(storedMessageSchema)
        .min(1)
        .max(MAX_STORED_MESSAGES_PER_APPEND),
    })
    .strict(),
])

export const chatHistoryStartResponseSchema = z
  .object({
    conversationId: z.string(),
    messages: z.array(storedMessageSchema),
  })
  .strict()
