import type { AiProvider } from "./ai-provider"
import { AiUsageMiddleware } from "./ai-usage"
import { FileToolConversationService } from "./file-tool-conversation"
import type { FileToolExecutor } from "./file-tools"
import { ConvexAiUsageLedger } from "./providers/convex/convex-ai-usage-ledger.server"
import { OpenRouterAiProvider } from "./providers/openrouter/openrouter-ai-provider.server"

export type OpenRouterAiServiceContext = {
  authToken: string
  convexSiteUrl: string
  openRouterApiKey: string
  serviceSecret: string
}

export function createOpenRouterAiService(
  context: OpenRouterAiServiceContext,
  fileToolExecutor: FileToolExecutor
): AiProvider {
  return new FileToolConversationService(
    new AiUsageMiddleware(
      new OpenRouterAiProvider(context.openRouterApiKey),
      new ConvexAiUsageLedger(
        context.convexSiteUrl,
        context.authToken,
        context.serviceSecret
      )
    ),
    fileToolExecutor
  )
}
