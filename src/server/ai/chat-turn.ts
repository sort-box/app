import { err, type ResultAsync } from "neverthrow"

import type { AiProviderError, AiStream } from "./ai-provider"
import { aiUsageProviderError, type AiUsageLedger } from "./ai-usage"
import {
  ChatHistoryMessageRecorder,
  type ChatHistoryError,
  type ChatHistoryPort,
} from "./chat-history"
import type { FileToolConversationService } from "./file-tool-conversation"

function historyError(error: ChatHistoryError): AiProviderError {
  return error.code === "NOT_FOUND"
    ? {
        code: "INVALID_INPUT",
        message: "The conversation was not found.",
      }
    : {
        code: "UNAVAILABLE",
        message: "The conversation history is temporarily unavailable.",
        retryable: true,
      }
}

async function* lazyConversation(input: {
  conversation: FileToolConversationService
  conversationId: string
  history: ChatHistoryPort
  usage: AiUsageLedger
  messages: Parameters<FileToolConversationService["streamConversation"]>[0]
}): AiStream {
  const started = await input.conversation.streamConversation(
    input.messages,
    new ChatHistoryMessageRecorder(input.history, input.conversationId)
  )
  if (started.isErr()) {
    yield err(started.error)
    return
  }
  for await (const result of started.value) {
    if (result.isErr()) {
      yield result
      return
    }
    if (result.value.type !== "finish") {
      yield result
      continue
    }
    if (!result.value.usage) {
      yield err({
        code: "INVALID_RESPONSE",
        message: "The AI provider did not report token usage.",
      })
      return
    }
    const recorded = await input.usage.recordUsage(result.value.usage)
    if (recorded.isErr()) {
      yield err(aiUsageProviderError(recorded.error))
      return
    }
    yield result
    return
  }
  yield err({
    code: "INVALID_RESPONSE",
    message: "The AI provider stream ended without a terminal outcome.",
  })
}

/** Coordinates the accepted lifecycle of one authenticated chat turn. */
export class ChatTurnService {
  constructor(
    private readonly history: ChatHistoryPort,
    private readonly usage: AiUsageLedger,
    private readonly conversation: FileToolConversationService
  ) {}

  startTurn(input: {
    conversationId: string | null
    content: string
    systemPrompt?: string
    abortSignal?: AbortSignal
  }): ResultAsync<
    { conversationId: string; stream: AiStream },
    AiProviderError
  > {
    return this.usage
      .checkAllowance()
      .mapErr(aiUsageProviderError)
      .andThen(() =>
        this.history
          .startTurn({
            conversationId: input.conversationId,
            content: input.content,
          })
          .mapErr(historyError)
      )
      .map((started) => ({
        conversationId: started.conversationId,
        stream: lazyConversation({
          conversation: this.conversation,
          conversationId: started.conversationId,
          history: this.history,
          usage: this.usage,
          messages: {
            messages: started.messages,
            systemPrompt: input.systemPrompt,
            abortSignal: input.abortSignal,
          },
        }),
      }))
  }
}
