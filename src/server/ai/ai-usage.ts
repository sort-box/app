import type { ResultAsync } from "neverthrow"

import type { AiProviderError, AiUsage } from "./ai-provider"

export type AiUsageError =
  | { code: "LIMIT_EXCEEDED" }
  | { code: "ENTITLEMENT_NOT_CONFIGURED" }
  | { code: "UNAVAILABLE"; retryable: true }

export interface AiUsageLedger {
  checkAllowance: () => ResultAsync<void, AiUsageError>
  recordUsage: (usage: AiUsage) => ResultAsync<void, AiUsageError>
}

export function aiUsageProviderError(error: AiUsageError): AiProviderError {
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
