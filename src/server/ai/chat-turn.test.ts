import { errAsync, ok, okAsync } from "neverthrow"
import { describe, expect, it, vi } from "vitest"

import type { AiProvider, AiStream } from "./ai-provider"
import type { AiUsageLedger } from "./ai-usage"
import type { ChatHistoryPort } from "./chat-history"
import { ChatTurnService } from "./chat-turn"
import { FileToolConversationService } from "./file-tool-conversation"
import type { FileToolExecutor } from "./file-tools"

function history(): ChatHistoryPort {
  return {
    startTurn: vi.fn(() =>
      okAsync({
        conversationId: "chat-1",
        messages: [{ role: "user" as const, content: "Hello" }],
      })
    ),
    appendMessages: vi.fn(() => okAsync(undefined)),
  }
}

function usage(): AiUsageLedger {
  return {
    checkAllowance: vi.fn(() => okAsync(undefined)),
    recordUsage: vi.fn(() => okAsync(undefined)),
  }
}

function tools(): FileToolExecutor {
  const unavailable = () =>
    errAsync({
      code: "UNAVAILABLE" as const,
      message: "Unavailable.",
      retryable: true as const,
    })
  return {
    listFiles: vi.fn(unavailable),
    searchFiles: vi.fn(unavailable),
    findExactReferences: vi.fn(unavailable),
    readFile: vi.fn(unavailable),
  }
}

async function collect(stream: AiStream) {
  const results = []
  for await (const result of stream) results.push(result)
  return results
}

describe("ChatTurnService", () => {
  it("rejects allowance failures before writing history", async () => {
    const chatHistory = history()
    const ledger = usage()
    ledger.checkAllowance = vi.fn(() =>
      errAsync({ code: "LIMIT_EXCEEDED" as const })
    )
    const provider = {
      streamConversation: vi.fn(),
    } as unknown as AiProvider
    const service = new ChatTurnService(
      chatHistory,
      ledger,
      new FileToolConversationService(provider, tools())
    )

    const result = await service.startTurn({
      conversationId: null,
      content: "Hello",
    })

    expect(result.isErr() && result.error.code).toBe("USAGE_LIMIT_EXCEEDED")
    expect(chatHistory.startTurn).not.toHaveBeenCalled()
    expect(provider.streamConversation).not.toHaveBeenCalled()
  })

  it("starts the provider lazily after returning the conversation id", async () => {
    const chatHistory = history()
    const provider = {
      streamConversation: vi.fn(() =>
        errAsync<AiStream, never>({
          code: "UNAVAILABLE" as const,
          message: "The provider is unavailable.",
          retryable: true as const,
        } as never)
      ),
    } satisfies AiProvider
    const service = new ChatTurnService(
      chatHistory,
      usage(),
      new FileToolConversationService(provider, tools())
    )

    const result = await service.startTurn({
      conversationId: null,
      content: "Hello",
    })

    expect(result.isOk() && result.value.conversationId).toBe("chat-1")
    expect(provider.streamConversation).not.toHaveBeenCalled()
    if (result.isErr()) return
    const streamed = await collect(result.value.stream)
    expect(provider.streamConversation).toHaveBeenCalledOnce()
    expect(streamed).toHaveLength(1)
    expect(streamed[0]?.isErr() && streamed[0].error.code).toBe("UNAVAILABLE")
  })

  it("records terminal usage before exposing successful completion", async () => {
    const order: string[] = []
    async function* completed(): AiStream {
      yield ok({ type: "text-delta", text: "Hello" })
      yield ok({
        type: "finish",
        reason: "stop",
        usage: { inputTokens: 4, outputTokens: 2 },
      })
    }
    const ledger = usage()
    ledger.recordUsage = vi.fn(() => {
      order.push("record")
      return okAsync(undefined)
    })
    const service = new ChatTurnService(
      history(),
      ledger,
      new FileToolConversationService(
        {
          streamConversation: vi.fn(() => okAsync(completed())),
        },
        tools()
      )
    )
    const result = await service.startTurn({
      conversationId: null,
      content: "Hello",
    })

    if (result.isErr()) return
    const streamed = []
    for await (const event of result.value.stream) {
      if (event.isOk() && event.value.type === "finish") order.push("finish")
      streamed.push(event)
    }

    expect(streamed.every((event) => event.isOk())).toBe(true)
    expect(ledger.recordUsage).toHaveBeenCalledWith({
      inputTokens: 4,
      outputTokens: 2,
    })
    expect(order).toEqual(["record", "finish"])
  })

  it("converts missing usage and usage persistence failures to terminals", async () => {
    async function* completedWithoutUsage(): AiStream {
      yield ok({ type: "finish", reason: "stop" })
    }
    const missingLedger = usage()
    const missingService = new ChatTurnService(
      history(),
      missingLedger,
      new FileToolConversationService(
        {
          streamConversation: vi.fn(() => okAsync(completedWithoutUsage())),
        },
        tools()
      )
    )
    const missing = await missingService.startTurn({
      conversationId: null,
      content: "Hello",
    })
    if (missing.isErr()) return
    const missingEvents = await collect(missing.value.stream)
    const missingTerminal = missingEvents.at(-1)
    expect(missingTerminal?.isErr()).toBe(true)
    expect(missingTerminal?.isErr() && missingTerminal.error.code).toBe(
      "INVALID_RESPONSE"
    )
    expect(missingLedger.recordUsage).not.toHaveBeenCalled()

    async function* completedWithUsage(): AiStream {
      yield ok({
        type: "finish",
        reason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      })
    }
    const failedLedger = usage()
    failedLedger.recordUsage = vi.fn(() =>
      errAsync({ code: "UNAVAILABLE" as const, retryable: true as const })
    )
    const failedService = new ChatTurnService(
      history(),
      failedLedger,
      new FileToolConversationService(
        {
          streamConversation: vi.fn(() => okAsync(completedWithUsage())),
        },
        tools()
      )
    )
    const failed = await failedService.startTurn({
      conversationId: null,
      content: "Hello",
    })
    if (failed.isErr()) return
    const failedEvents = await collect(failed.value.stream)
    const failedTerminal = failedEvents.at(-1)
    expect(failedTerminal?.isErr()).toBe(true)
    expect(failedTerminal?.isErr() && failedTerminal.error.code).toBe(
      "USAGE_TRACKING_UNAVAILABLE"
    )
  })
})
