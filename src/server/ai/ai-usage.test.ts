import { errAsync, ok, okAsync } from "neverthrow"
import { describe, expect, it, vi } from "vitest"

import type { AiProvider, AiStream, AiUsage } from "./ai-provider"
import { AiUsageMiddleware, type AiUsageLedger } from "./ai-usage"

async function* streamWithUsage(usage?: AiUsage): AiStream {
  yield ok({ type: "text-delta", text: "Hello" })
  yield ok({ type: "finish", reason: "stop", ...(usage ? { usage } : {}) })
}

async function collect(stream: AiStream) {
  const results = []
  for await (const result of stream) results.push(result)
  return results
}

function provider(stream: AiStream) {
  return {
    streamConversation: vi.fn(() => okAsync(stream)),
  } satisfies AiProvider
}

function ledger(overrides: Partial<AiUsageLedger> = {}) {
  return {
    checkAllowance: vi.fn(() => okAsync(undefined)),
    recordUsage: vi.fn(() => okAsync(undefined)),
    ...overrides,
  } satisfies AiUsageLedger
}

describe("AiUsageMiddleware", () => {
  it("checks allowance before calling the provider", async () => {
    const inner = provider(streamWithUsage({ inputTokens: 1, outputTokens: 1 }))
    const usage = ledger({
      checkAllowance: vi.fn(() =>
        errAsync({ code: "LIMIT_EXCEEDED" as const })
      ),
    })

    const result = await new AiUsageMiddleware(inner, usage).streamConversation(
      { messages: [{ role: "user", content: "Hello" }] }
    )

    expect(result.isErr() && result.error.code).toBe("USAGE_LIMIT_EXCEEDED")
    expect(inner.streamConversation).not.toHaveBeenCalled()
    expect(usage.recordUsage).not.toHaveBeenCalled()
  })

  it("records provider-reported tokens before emitting finish", async () => {
    const reported = { inputTokens: 12, outputTokens: 3 }
    const usage = ledger()
    const result = await new AiUsageMiddleware(
      provider(streamWithUsage(reported)),
      usage
    ).streamConversation({ messages: [{ role: "user", content: "Hello" }] })

    expect(result.isOk()).toBe(true)
    if (result.isErr()) return
    const results = await collect(result.value)
    expect(results.every((item) => item.isOk())).toBe(true)
    expect(usage.recordUsage).toHaveBeenCalledWith(reported)
  })

  it("rejects a successful stream that omits token usage", async () => {
    const usage = ledger()
    const result = await new AiUsageMiddleware(
      provider(streamWithUsage()),
      usage
    ).streamConversation({ messages: [{ role: "user", content: "Hello" }] })

    expect(result.isOk()).toBe(true)
    if (result.isErr()) return
    const results = await collect(result.value)
    const last = results.at(-1)
    expect(last?.isErr()).toBe(true)
    expect(last?.isErr() && last.error.code).toBe("INVALID_RESPONSE")
    expect(usage.recordUsage).not.toHaveBeenCalled()
  })
})
