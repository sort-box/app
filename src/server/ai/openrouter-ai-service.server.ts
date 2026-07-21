import { err, errAsync, ok, type Result } from "neverthrow"

import type { FileApiContext } from "../files/file-api.server"
import { FileRestService } from "../files/file-api.server"
import type { RerankingPort } from "../search/reranking"
import { getSearchAdapters } from "../search/search.server"
import type { AiProviderError } from "./ai-provider"
import { ChatTurnService } from "./chat-turn"
import { FileToolConversationService } from "./file-tool-conversation"
import { FileToolExecutorService } from "./file-tool-executor"
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

const unavailableReranking: RerankingPort = {
  rerank: () => errAsync({ code: "CONFIGURATION_ERROR" }),
}

function chatConfiguration(
  fileApi: FileApiContext
): Result<OpenRouterAiServiceContext, AiProviderError> {
  const context: OpenRouterAiServiceContext = {
    authToken: fileApi.authToken,
    convexSiteUrl: import.meta.env.VITE_CONVEX_SITE_URL ?? "",
    openRouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
    serviceSecret: process.env.FILE_SERVICE_SECRET ?? "",
  }
  try {
    const site = new URL(context.convexSiteUrl)
    const isLocal = ["localhost", "127.0.0.1", "::1"].includes(site.hostname)
    if (site.protocol !== "https:" && !(site.protocol === "http:" && isLocal)) {
      throw new Error("invalid site URL")
    }
  } catch {
    return err({
      code: "CONFIGURATION_ERROR",
      message: "The chat service is not configured.",
    })
  }
  if (
    context.openRouterApiKey.trim().length === 0 ||
    context.serviceSecret.trim().length < 32
  ) {
    return err({
      code: "CONFIGURATION_ERROR",
      message: "The chat service is not configured.",
    })
  }
  return ok(context)
}

/** Builds the complete application service for one authenticated chat turn. */
export function createChatTurnService(
  fileApi: FileApiContext
): Result<ChatTurnService, AiProviderError> {
  return chatConfiguration(fileApi).map((context) => {
    const gateway = new ConvexFileToolGateway(new FileRestService(fileApi), {
      authToken: context.authToken,
      convexSiteUrl: context.convexSiteUrl,
      serviceSecret: context.serviceSecret,
    })
    const reranking = getSearchAdapters().match(
      (adapters) => adapters.reranking,
      () => unavailableReranking
    )
    const usage = new ConvexAiUsageLedger(
      context.convexSiteUrl,
      context.authToken,
      context.serviceSecret
    )
    const history = new ConvexChatHistory({
      authToken: context.authToken,
      convexSiteUrl: context.convexSiteUrl,
      serviceSecret: context.serviceSecret,
    })
    const conversation = new FileToolConversationService(
      new OpenRouterAiProvider(context.openRouterApiKey),
      new FileToolExecutorService(gateway, reranking)
    )
    return new ChatTurnService(history, usage, conversation)
  })
}
