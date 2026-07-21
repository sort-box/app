import { describe, expect, it } from "vitest"

import { aiUsageProviderError } from "./ai-usage"

describe("aiUsageProviderError", () => {
  it.each([
    ["LIMIT_EXCEEDED", "USAGE_LIMIT_EXCEEDED"],
    ["ENTITLEMENT_NOT_CONFIGURED", "CONFIGURATION_ERROR"],
    ["UNAVAILABLE", "USAGE_TRACKING_UNAVAILABLE"],
  ] as const)("maps %s to %s", (code, expected) => {
    const error =
      code === "UNAVAILABLE"
        ? ({ code, retryable: true } as const)
        : ({ code } as const)

    expect(aiUsageProviderError(error).code).toBe(expected)
  })
})
