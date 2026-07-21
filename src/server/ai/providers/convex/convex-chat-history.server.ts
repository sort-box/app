import { errAsync, okAsync, ResultAsync } from "neverthrow"
import { z } from "zod"

import type { AiMessage, JsonValue } from "../../ai-provider"
import {
  chatHistoryRequestSchema,
  chatHistoryStartResponseSchema,
} from "../../chat-history-contract"
import type { storedMessageSchema } from "../../chat-history-contract"
import type { ChatHistoryError, ChatHistoryPort } from "../../chat-history"

type Fetch = typeof fetch

class ChatHistoryRequestError {
  constructor(readonly error: ChatHistoryError) {}
}

function historyError(code: ChatHistoryError["code"]): ChatHistoryError {
  return { code, retryable: code === "UNAVAILABLE" }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true
  }
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every(isJsonValue)
  )
}

function toAiMessage(
  message: z.infer<typeof storedMessageSchema>
): AiMessage | null {
  if (message.role !== "assistant") return message
  if (!message.toolCalls) {
    return { role: "assistant", content: message.content }
  }
  const toolCalls = message.toolCalls.flatMap((call) => {
    try {
      const argumentsValue: unknown = JSON.parse(call.argumentsJson)
      return isJsonValue(argumentsValue)
        ? [{ id: call.id, name: call.name, arguments: argumentsValue }]
        : []
    } catch {
      return []
    }
  })
  return toolCalls.length === message.toolCalls.length
    ? { role: "assistant", content: message.content, toolCalls }
    : null
}

function toStoredMessage(message: AiMessage) {
  if (message.role !== "assistant" || !message.toolCalls) return message
  return {
    role: "assistant" as const,
    content: message.content,
    toolCalls: message.toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      argumentsJson: JSON.stringify(call.arguments),
    })),
  }
}

export type ConvexChatHistoryContext = {
  authToken: string
  convexSiteUrl: string
  serviceSecret: string
}

/** Persists trusted model history through the authenticated Convex endpoint. */
export class ConvexChatHistory implements ChatHistoryPort {
  constructor(
    private readonly context: ConvexChatHistoryContext,
    private readonly fetch: Fetch = globalThis.fetch
  ) {}

  startTurn(input: { conversationId: string | null; content: string }) {
    return this.request(
      { operation: "start", ...input },
      chatHistoryStartResponseSchema
    ).andThen((response) => {
      const messages = response.messages.map(toAiMessage)
      if (messages.some((message) => message === null)) {
        return errAsync(historyError("UNAVAILABLE"))
      }
      return okAsync({
        conversationId: response.conversationId,
        messages: messages as AiMessage[],
      })
    })
  }

  appendMessages(input: {
    conversationId: string
    messages: readonly AiMessage[]
  }) {
    return this.request(
      {
        operation: "append",
        conversationId: input.conversationId,
        messages: input.messages.map(toStoredMessage),
      },
      z.null()
    ).map(() => undefined)
  }

  private request<T>(body: Record<string, unknown>, schema: z.ZodType<T>) {
    const siteUrl = this.context.convexSiteUrl.replace(/\/$/, "")
    return ResultAsync.fromPromise(
      this.fetch(`${siteUrl}/internal/ai/chat-history`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.context.authToken}`,
          "Content-Type": "application/json",
          "x-file-service-secret": this.context.serviceSecret,
        },
        body: JSON.stringify(chatHistoryRequestSchema.parse(body)),
      }).then(async (response) => {
        if (!response.ok) {
          throw new ChatHistoryRequestError(
            historyError(response.status === 404 ? "NOT_FOUND" : "UNAVAILABLE")
          )
        }
        const parsed = schema.safeParse(await response.json())
        if (!parsed.success) {
          throw new ChatHistoryRequestError(historyError("UNAVAILABLE"))
        }
        return parsed.data
      }),
      (error) =>
        error instanceof ChatHistoryRequestError
          ? error.error
          : historyError("UNAVAILABLE")
    )
  }
}
