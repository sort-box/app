import { err, type ResultAsync } from "neverthrow"

import type {
  AiProvider,
  AiProviderError,
  AiStream,
  AiUsage,
  StreamConversationInput,
} from "./ai-provider"

export type AiUsageError =
  | { code: "LIMIT_EXCEEDED" }
  | { code: "ENTITLEMENT_NOT_CONFIGURED" }
  | { code: "UNAVAILABLE"; retryable: true }

export interface AiUsageLedger {
  checkAllowance: () => ResultAsync<void, AiUsageError>
  recordUsage: (usage: AiUsage) => ResultAsync<void, AiUsageError>
}

function providerError(error: AiUsageError): AiProviderError {
  if (error.code === "LIMIT_EXCEEDED") {
    return {
      code: "USAGE_LIMIT_EXCEEDED",
      message: "The AI usage limit has been reached.",
    }
  }
  if (error.code === "ENTITLEMENT_NOT_CONFIGURED") {
    return {
      code: "CONFIGURATION_ERROR",
      message: "AI usage is not configured for this account.",
    }
  }
  return {
    code: "USAGE_TRACKING_UNAVAILABLE",
    message: "AI usage tracking is temporarily unavailable.",
    retryable: true,
  }
}

async function* trackUsage(stream: AiStream, ledger: AiUsageLedger): AiStream {
  for await (const result of stream) {
    if (result.isErr() || result.value.type !== "finish") {
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
    const recorded = await ledger.recordUsage(result.value.usage)
    if (recorded.isErr()) {
      yield err(providerError(recorded.error))
      return
    }
    yield result
  }
}

/** Enforces and records usage around a provider without coupling it to Convex. */
export class AiUsageMiddleware implements AiProvider {
  constructor(
    private readonly provider: AiProvider,
    private readonly ledger: AiUsageLedger
  ) {}

  streamConversation(input: StreamConversationInput) {
    return this.ledger
      .checkAllowance()
      .mapErr(providerError)
      .andThen(() =>
        this.provider
          .streamConversation(input)
          .map((stream) => trackUsage(stream, this.ledger))
      )
  }
}
