import { errAsync } from "neverthrow"

import type { FileApiContext } from "../files/file-api.server"
import { FileRestService } from "../files/file-api.server"
import { getSearchAdapters } from "../search/search.server"
import type { RerankingPort } from "../search/reranking"
import type { AiProvider } from "./ai-provider"
import type { AiMessageRecorder } from "./file-tool-conversation"
import { AiUsageMiddleware } from "./ai-usage"
import { FileToolConversationService } from "./file-tool-conversation"
import { FileToolExecutorService } from "./file-tool-executor"
import type { FileToolExecutor } from "./file-tools"
import { ConvexAiUsageLedger } from "./providers/convex/convex-ai-usage-ledger.server"
import { ConvexChatHistory } from "./providers/convex/convex-chat-history.server"
import { ConvexFileToolGateway } from "./providers/convex/convex-file-tool-gateway.server"
import { OpenRouterAiProvider } from "./providers/openrouter/openrouter-ai-provider.server"

export type OpenRouterAiServiceContext = {
  authToken: string
  convexSiteUrl: string
  openRouterApiKey: string
  serviceSecret: string
}

export function createOpenRouterAiService(
  context: OpenRouterAiServiceContext,
  fileToolExecutor: FileToolExecutor,
  recorder?: AiMessageRecorder
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
    fileToolExecutor,
    recorder
  )
}

const unavailableReranking: RerankingPort = {
  rerank: () => errAsync({ code: "CONFIGURATION_ERROR" }),
}

/**
 * Builds the chat AI service for one authenticated request. Search reranking
 * degrades to vector ordering when the reranking provider is not configured.
 */
export function createChatAiService(
  fileApi: FileApiContext,
  recorder?: AiMessageRecorder
): AiProvider {
  const context: OpenRouterAiServiceContext = {
    authToken: fileApi.authToken,
    convexSiteUrl: import.meta.env.VITE_CONVEX_SITE_URL ?? "",
    openRouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
    serviceSecret: process.env.FILE_SERVICE_SECRET ?? "",
  }
  const gateway = new ConvexFileToolGateway(new FileRestService(fileApi), {
    authToken: context.authToken,
    convexSiteUrl: context.convexSiteUrl,
    serviceSecret: context.serviceSecret,
  })
  const reranking = getSearchAdapters().match(
    (adapters) => adapters.reranking,
    () => unavailableReranking
  )
  return createOpenRouterAiService(
    context,
    new FileToolExecutorService(gateway, reranking),
    recorder
  )
}

export function createChatHistory(fileApi: FileApiContext) {
  return new ConvexChatHistory({
    authToken: fileApi.authToken,
    convexSiteUrl: import.meta.env.VITE_CONVEX_SITE_URL ?? "",
    serviceSecret: process.env.FILE_SERVICE_SECRET ?? "",
  })
}
