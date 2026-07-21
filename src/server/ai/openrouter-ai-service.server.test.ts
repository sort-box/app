import { afterEach, describe, expect, it, vi } from "vitest"

import type { FileApiContext } from "../files/file-api.server"
import { createChatTurnService } from "./openrouter-ai-service.server"

const fileApi = { authToken: "auth-token" } as FileApiContext

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("chat composition configuration", () => {
  it.each([
    ["", "openrouter-key", "s".repeat(32)],
    ["http://production.example.com", "openrouter-key", "s".repeat(32)],
    ["https://example.convex.site", "", "s".repeat(32)],
    ["https://example.convex.site", "openrouter-key", "short"],
  ])(
    "returns a typed configuration error for invalid settings",
    (siteUrl, openRouterKey, serviceSecret) => {
      vi.stubEnv("VITE_CONVEX_SITE_URL", siteUrl)
      vi.stubEnv("OPENROUTER_API_KEY", openRouterKey)
      vi.stubEnv("FILE_SERVICE_SECRET", serviceSecret)

      const result = createChatTurnService(fileApi)

      expect(result.isErr() && result.error).toEqual({
        code: "CONFIGURATION_ERROR",
        message: "The chat service is not configured.",
      })
    }
  )
})
