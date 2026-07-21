import { createFileRoute } from "@tanstack/react-router"

import {
  chatRequestSchema,
  type ChatRequest,
  type ChatStreamEvent,
} from "@/features/chat/chat-transport"
import type { AiProviderError, AiStream } from "@/server/ai/ai-provider"
import { ChatHistoryMessageRecorder } from "@/server/ai/chat-history"
import {
  createChatAiService,
  createChatHistory,
} from "@/server/ai/openrouter-ai-service.server"
import { fileApiMiddleware } from "@/server/files/file-api.server"

const MAX_BODY_BYTES = 256 * 1024

const SYSTEM_PROMPT = [
  "You are Untie's assistant.",
  "You can browse, semantically search, and read the extracted text of the",
  "user's stored files with the provided tools. Use them whenever a question",
  "concerns the user's files; otherwise answer directly.",
  "Use find_exact_references, not semantic search, when the user asks for an",
  "exact term, every occurrence, all matching files, or whether a particular",
  "file contains a term. Follow next_cursor until complete when exhaustiveness",
  "is requested. Deduplicate file lists by path.",
  "Never claim that you searched, read, or found a file unless a tool result in",
  "this conversation proves it. Never claim exhaustive coverage unless the",
  "tool reports complete=true and unsearchable_ready_files=0. Clearly report",
  "partial results, pagination, indexing gaps, unavailable files, and warnings.",
  "For questions about the conversation itself, inspect the supplied messages",
  "literally. Distinguish the immediately previous message from text quoted",
  "inside it, and do not accept a correction that contradicts the transcript.",
  "Cite file paths and source locations when you rely on file content.",
  "Format responses in Markdown.",
].join(" ")

const errorStatuses: Record<AiProviderError["code"], number> = {
  INVALID_INPUT: 400,
  CONFIGURATION_ERROR: 503,
  AUTHENTICATION_FAILED: 502,
  USAGE_LIMIT_EXCEEDED: 429,
  USAGE_TRACKING_UNAVAILABLE: 503,
  RATE_LIMITED: 429,
  UNAVAILABLE: 503,
  INVALID_RESPONSE: 502,
  CANCELLED: 400,
}

function chatErrorResponse(requestId: string, error: AiProviderError) {
  return Response.json(
    { error: { code: error.code, message: error.message }, requestId },
    { status: errorStatuses[error.code] }
  )
}

function invalidInput(): AiProviderError {
  return { code: "INVALID_INPUT", message: "The chat request is invalid." }
}

async function chatBody(
  request: Request
): Promise<ChatRequest | AiProviderError> {
  const contentType = request.headers.get("content-type")?.split(";")[0]
  if (contentType !== "application/json") return invalidInput()
  const declared = Number(request.headers.get("content-length") ?? 0)
  if (declared > MAX_BODY_BYTES) return invalidInput()
  try {
    const text = await request.text()
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
      return invalidInput()
    }
    const parsed = chatRequestSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : invalidInput()
  } catch {
    return invalidInput()
  }
}

function sseResponse(stream: AiStream, conversationId: string): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChatStreamEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      try {
        send({ type: "conversation-id", conversationId })
        for await (const result of stream) {
          if (result.isErr()) {
            send({
              type: "error",
              error: {
                code: result.error.code,
                message: result.error.message,
              },
            })
            return
          }
          const event = result.value
          if (event.type === "text-delta") {
            send({ type: "text-delta", text: event.text })
          } else if (event.type === "tool-call") {
            send({ type: "tool-call", name: event.call.name })
          } else {
            send({ type: "done" })
          }
        }
      } catch {
        // The client disconnected; there is no reader left to notify.
      } finally {
        try {
          controller.close()
        } catch {
          // The stream was already closed by a disconnect.
        }
      }
    },
  })
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
    },
  })
}

export const Route = createFileRoute("/api/chat")({
  server: {
    middleware: [fileApiMiddleware],
    handlers: {
      POST: async ({ request, context }) => {
        const body = await chatBody(request)
        if ("code" in body) {
          return chatErrorResponse(context.fileApi.requestId, body)
        }
        const history = createChatHistory(context.fileApi)
        const started = await history.startTurn({
          conversationId: body.conversation_id ?? null,
          content: body.message,
        })
        if (started.isErr()) {
          return chatErrorResponse(
            context.fileApi.requestId,
            started.error.code === "NOT_FOUND"
              ? {
                  code: "INVALID_INPUT",
                  message: "The conversation was not found.",
                }
              : {
                  code: "UNAVAILABLE",
                  message:
                    "The conversation history is temporarily unavailable.",
                  retryable: true,
                }
          )
        }
        const service = createChatAiService(
          context.fileApi,
          new ChatHistoryMessageRecorder(history, started.value.conversationId)
        )
        const stream = await service.streamConversation({
          messages: started.value.messages,
          systemPrompt: SYSTEM_PROMPT,
          abortSignal: request.signal,
        })
        return stream.match(
          (aiStream) => sseResponse(aiStream, started.value.conversationId),
          (error) => chatErrorResponse(context.fileApi.requestId, error)
        )
      },
    },
  },
})
