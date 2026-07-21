import type { ResultAsync } from "neverthrow"

import type { AiMessage, AiProviderError } from "./ai-provider"
import type { AiMessageRecorder } from "./message-recorder"

export type ChatHistoryError = {
  code: "NOT_FOUND" | "UNAVAILABLE"
  retryable: boolean
}

export interface ChatHistoryPort {
  startTurn: (input: {
    conversationId: string | null
    content: string
  }) => ResultAsync<
    { conversationId: string; messages: readonly AiMessage[] },
    ChatHistoryError
  >
  appendMessages: (input: {
    conversationId: string
    messages: readonly AiMessage[]
  }) => ResultAsync<void, ChatHistoryError>
}

/** Records one model turn into an already authorized conversation. */
export class ChatHistoryMessageRecorder implements AiMessageRecorder {
  constructor(
    private readonly history: ChatHistoryPort,
    private readonly conversationId: string
  ) {}

  recordMessages(messages: readonly AiMessage[]) {
    return this.history
      .appendMessages({ conversationId: this.conversationId, messages })
      .mapErr((): AiProviderError => ({
        code: "UNAVAILABLE",
        message: "The conversation history is temporarily unavailable.",
        retryable: true,
      }))
  }
}
