import { ResultAsync, errAsync } from "neverthrow"

import type { AiUsage } from "../../ai-provider"
import type { AiUsageError, AiUsageLedger } from "../../ai-usage"

type Fetch = typeof fetch

class LedgerRequestError {
  constructor(readonly error: AiUsageError) {}
}

function mapError(error: unknown): AiUsageError {
  if (error instanceof LedgerRequestError) return error.error
  return { code: "UNAVAILABLE", retryable: true }
}

export class ConvexAiUsageLedger implements AiUsageLedger {
  constructor(
    private readonly siteUrl: string,
    private readonly authToken: string,
    private readonly serviceSecret: string,
    private readonly fetch: Fetch = globalThis.fetch
  ) {}

  checkAllowance() {
    return this.request("check")
  }

  recordUsage(usage: AiUsage) {
    return this.request("record", usage)
  }

  private request(operation: "check" | "record", usage?: AiUsage) {
    if (
      !this.siteUrl ||
      !this.authToken ||
      !this.serviceSecret ||
      this.serviceSecret.length < 32
    ) {
      return errAsync<void, AiUsageError>({
        code: "UNAVAILABLE",
        retryable: true,
      })
    }
    return ResultAsync.fromPromise(
      this.fetch(`${this.siteUrl.replace(/\/$/, "")}/internal/ai/usage`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.authToken}`,
          "Content-Type": "application/json",
          "x-file-service-secret": this.serviceSecret,
        },
        body: JSON.stringify({ operation, ...usage }),
      }).then(async (response) => {
        if (response.ok) return
        const body = (await response.json().catch(() => null)) as {
          code?: unknown
        } | null
        if (body?.code === "AI_USAGE_LIMIT_EXCEEDED") {
          throw new LedgerRequestError({ code: "LIMIT_EXCEEDED" })
        }
        if (body?.code === "AI_ENTITLEMENT_NOT_CONFIGURED") {
          throw new LedgerRequestError({ code: "ENTITLEMENT_NOT_CONFIGURED" })
        }
        throw new LedgerRequestError({ code: "UNAVAILABLE", retryable: true })
      }),
      mapError
    )
  }
}
