import { describe, expect, it, vi } from "vitest"

import { ConvexAiUsageLedger } from "./convex-ai-usage-ledger.server"

describe("ConvexAiUsageLedger diagnostics", () => {
  it("logs invalid configuration without logging secret values", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const result = await new ConvexAiUsageLedger(
      "",
      "token",
      "short"
    ).checkAllowance()

    expect(result.isErr()).toBe(true)
    expect(error).toHaveBeenCalledWith("AI usage ledger request failed.", {
      operation: "check",
      reason: "INVALID_CONFIGURATION",
      hasSiteUrl: false,
      hasAuthToken: true,
      hasValidServiceSecret: false,
    })
    expect(JSON.stringify(error.mock.calls)).not.toContain("token")
    expect(JSON.stringify(error.mock.calls)).not.toContain("short")
    error.mockRestore()
  })

  it("logs the status for an unexpected HTTP response", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const fetch = vi.fn(async () =>
      Response.json({ code: "PRIVATE_PROVIDER_DETAIL" }, { status: 401 })
    )
    const ledger = new ConvexAiUsageLedger(
      "https://example.convex.site",
      "token",
      "s".repeat(32),
      fetch
    )

    const result = await ledger.checkAllowance()

    expect(result.isErr()).toBe(true)
    expect(error).toHaveBeenCalledWith("AI usage ledger request failed.", {
      operation: "check",
      reason: "HTTP_ERROR",
      status: 401,
      responseCode: "UNKNOWN",
    })
    expect(JSON.stringify(error.mock.calls)).not.toContain(
      "PRIVATE_PROVIDER_DETAIL"
    )
    error.mockRestore()
  })

  it("logs a sanitized fetch failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const fetch = vi.fn(async () => {
      throw new TypeError("secret provider response")
    })
    const ledger = new ConvexAiUsageLedger(
      "https://example.convex.site",
      "token",
      "s".repeat(32),
      fetch
    )

    const result = await ledger.checkAllowance()

    expect(result.isErr()).toBe(true)
    expect(error).toHaveBeenCalledWith("AI usage ledger request failed.", {
      operation: "check",
      reason: "FETCH_FAILED",
      errorType: "TypeError",
    })
    expect(JSON.stringify(error.mock.calls)).not.toContain(
      "secret provider response"
    )
    error.mockRestore()
  })
})
