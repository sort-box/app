import type { Result, ResultAsync } from "neverthrow"

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type AiToolCall = {
  id: string
  name: string
  arguments: JsonValue
}

/**
 * Provider-neutral conversation history.
 *
 * A tool result must reference the assistant tool call that requested it.
 * Callers send the complete ordered history again to continue a conversation.
 */
export type AiMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant"
      content: string
      toolCalls?: readonly AiToolCall[]
    }
  | { role: "tool"; toolCallId: string; content: string }

export type AiToolDefinition = {
  name: string
  description: string
  inputSchema: Record<string, JsonValue>
}

export type AiUsage = {
  inputTokens: number
  outputTokens: number
}

/** Events emitted in order for one assistant turn. */
export type AiStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; call: AiToolCall }
  | {
      type: "finish"
      reason: "stop" | "tool-calls" | "length"
      usage?: AiUsage
    }

/**
 * Expected AI failures with messages safe to return across a trust boundary.
 * Raw provider errors must not escape an adapter.
 */
export type AiProviderError =
  | { code: "INVALID_INPUT"; message: string }
  | { code: "CONFIGURATION_ERROR"; message: string }
  | { code: "AUTHENTICATION_FAILED"; message: string }
  | { code: "RATE_LIMITED"; message: string; retryable: true }
  | { code: "UNAVAILABLE"; message: string; retryable: true }
  | { code: "INVALID_RESPONSE"; message: string }
  | { code: "CANCELLED"; message: string }

/**
 * Each item is a Result because a provider request can fail after streaming
 * has already started.
 */
export type AiStream = AsyncIterable<Result<AiStreamEvent, AiProviderError>>

export type StreamConversationInput = {
  messages: readonly AiMessage[]
  systemPrompt?: string
  tools?: readonly AiToolDefinition[]
  abortSignal?: AbortSignal
}

/**
 * Provider-neutral port for streaming one turn of a multi-turn conversation.
 * Tool execution and conversation persistence belong to application services.
 */
export interface AiProvider {
  streamConversation: (
    input: StreamConversationInput
  ) => ResultAsync<AiStream, AiProviderError>
}
