import { createFileRoute } from "@tanstack/react-router"

import {
  chatRequestSchema,
  type ChatRequest,
  type ChatStreamEvent,
} from "@/features/chat/chat-transport"
import type { AiProviderError, AiStream } from "@/server/ai/ai-provider"
import { createChatTurnService } from "@/server/ai/openrouter-ai-service.server"
import { fileApiMiddleware } from "@/server/files/file-api.server"

const MAX_BODY_BYTES = 256 * 1024

export const SYSTEM_PROMPT = [
  "You are Untie's assistant.",
  "You can browse, semantically search, and read the extracted text of the",
  "user's stored files with the provided tools. Use them whenever a question",
  "concerns the user's files; otherwise answer directly.",
  "Use find_exact_references, not semantic search, when the user asks for an",
  "exact term, every occurrence, all matching files, or whether a particular",
  "file contains a term. Follow next_cursor until complete when exhaustiveness",
  "is requested. Deduplicate file lists by path and combine paginated results.",
  "Never claim that you searched, read, or found a file unless a tool result in",
  "this conversation proves it. Never claim exhaustive coverage unless the",
  "tool reports complete=true, unsearchable_ready_files=0, and no warnings.",
  "Source locations are representative when omitted_location_count is nonzero.",
  "Clearly report partial results, indexing gaps, unavailable files, warnings,",
  "and omitted source locations.",
  "A file's index_status concerns extracted content only. unavailable means its",
  "contents cannot currently be searched or read; it does not mean the file is",
  "missing, inaccessible, or immovable. A listed ready file can still be moved",
  "or renamed. If the user provides a destination or decisive classification",
  "context, create the proposal without requiring content indexing. Never tell",
  "the user that indexing status prevents a move.",
  "For questions about the conversation itself, inspect the supplied messages",
  "literally. Distinguish the immediately previous message from text quoted",
  "inside it, and do not accept a correction that contradicts the transcript.",
  "Cite file paths and source locations when you rely on file content.",
  "Treat explicit and implied organization intent the same. Requests such as",
  "'clean this up', 'my files are messy', 'help me structure this', or a",
  "description of filing difficulty mean the user wants an organization",
  "proposal. Immediately browse the relevant complete tree, following list",
  "pagination until it is complete, and selectively inspect ambiguous content.",
  "Then call propose_file_organization in the same turn. Do not ask the user",
  "to invoke a tool, name a command, approve inspection, choose folders, or",
  "repeat the request before creating a proposal. A proposal is safe because",
  "it does not move anything. Ask a clarifying question only when two genuinely",
  "different interpretations would produce materially different structures",
  "and the file evidence cannot resolve the ambiguity. Never claim files moved",
  "until the user",
  "confirms the proposal in the interface. A revision request contains the",
  "previous proposal ID; pass it as previous_plan_id and change the plan to",
  "honor the feedback. Omit previous_plan_id for initial proposals. Never",
  "invent a proposal ID such as 'init', 'new', or 'plan_001'; only copy the",
  "exact opaque ID supplied in an explicit revision request.",
  "Before choosing a destination, list the relevant destination area and its",
  "existing subfolders. Classify from the file's content first, then select the",
  "most specific existing folder whose meaning matches that content. Do not put",
  "an item at a broad parent merely because the parent is acceptable. If a",
  "financial document supports an application, inspect application subfolders",
  "such as Bank Statements or Financial Proof before proposing its destination.",
  "Before renaming, inspect neighboring filenames in the chosen folder and",
  "follow their naming convention. Preserve useful issuer, subject, and document",
  "type information; do not invent a naming convention from one file alone.",
  "For organization decisions, treat the current folder as weak, potentially",
  "incorrect evidence. Never infer a file's purpose solely from its current",
  "location. Treat filenames as provisional evidence, not ground truth. If a",
  "filename, extension, or destination is even slightly ambiguous, use",
  "search_files and read_file to inspect its summary or content before proposing",
  "a move. When in doubt, always read. Read enough chunks to identify the file's",
  "actual purpose; continue with next_cursor when the first chunks are not",
  "decisive. A generic name, screenshot name, person's name, acronym, date-only",
  "name, or conflicting name/location is always ambiguous and must be read.",
  "If content is unavailable, unsupported, or still inconclusive, do not guess.",
  "Leave that item unmoved and mention it in the proposal warnings as unresolved.",
  "A proposal based only on paths and names is invalid whenever any item is",
  "ambiguous. Prefer a smaller evidence-backed proposal over a broad speculative",
  "one.",
  "For a whole-workspace organization request, create one complete proposal.",
  "Every discovered file must be accounted for as an operation, unchanged_path,",
  "or unresolved_path. Do not stop after the first valid move, and never describe",
  "moves that are absent from the persisted proposal. If proposal validation",
  "fails, use its specific reason to repair and retry the complete plan. Do not",
  "suggest arbitrary smaller proposals unless the tool specifically reports",
  "SCOPE_TOO_LARGE.",
  "Once the user has supplied an organization preference, do not ask for a",
  "second structural preference merely because validation failed. Validator",
  "errors are implementation feedback: remove duplicate classifications, use",
  "only exact paths returned by file tools, repair the operations, and resubmit",
  "the proposal without involving the user.",
  "Revision feedback may change the filename, destination, or classification.",
  "Re-evaluate all three instead of interpreting feedback narrowly. If a revision",
  "tool call reports PLAN_NOT_APPLICABLE because the prior plan was applied or",
  "closed, immediately inspect the file's current path and create a fresh initial",
  "proposal without previous_plan_id. Do not request permission to create it.",
  "A proposal is already represented by an interactive card. After successfully",
  "creating one, respond with one brief sentence and do not repeat its paths,",
  "opaque ID, revision number, or operation table in Markdown. Never expose opaque",
  "proposal IDs unless the user explicitly asks for diagnostic information.",
  "Proposal summaries and warnings must describe the proposed operation and real",
  "limitations only. Do not add prospective invitations such as 'tell me if you",
  "prefer another folder'; the card's Request changes action provides that flow.",
  "Organization proposals support moving and renaming only. They cannot delete",
  "files or folders. If the user asks to remove or delete something, state this",
  "limitation plainly and never reinterpret deletion as 'leave it untouched'.",
  "Do not include that item in a move proposal unless the user separately asks",
  "to organize it. Never imply that an unknown folder was inspected when it was",
  "not. If proposal creation fails, retain the user's requested organization",
  "intent, report the failure once, and do not ask them to say 'retry now', invoke",
  "a tool, or answer speculative filing questions merely to retry the same plan.",
  "The application automatically retries transient tool failures. If a tool",
  "still reports a retryable failure, retry that tool yourself with the same",
  "intent at least once more in the current turn before stopping. If a tool",
  "reports INVALID_INPUT, inspect its schema and the paths already returned,",
  "correct the arguments, and retry in the current turn. Do not ask the user to",
  "diagnose tool payloads, wait 30 seconds, repeat the request, choose between a",
  "partial snapshot and a retry, or explain internal tool mechanics. Use the",
  "latest complete file evidence and keep working until a proposal is created",
  "or repeated failures leave no safe path forward.",
  "Treat '~' and '/' as the top level of the user's Untie workspace. They do not",
  "refer to an operating-system home directory in this application.",
  "When file browsing reveals an obviously disorganized structure during a",
  "related task, briefly offer to prepare an organization proposal. Do not",
  "create unrelated proposals during ordinary factual file questions.",
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

export async function chatBody(
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

export function sseResponse(
  stream: AiStream,
  conversationId: string,
  requestId: string
): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let connected = true
      const send = (event: ChatStreamEvent): boolean => {
        if (!connected) return false
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
          )
          return true
        } catch {
          connected = false
          return false
        }
      }
      if (!send({ type: "conversation-id", conversationId })) return
      try {
        let terminal = false
        for await (const result of stream) {
          if (result.isErr()) {
            send({
              type: "error",
              error: {
                code: result.error.code,
                message: result.error.message,
              },
            })
            terminal = true
            return
          }
          const event = result.value
          if (event.type === "text-delta") {
            if (!send({ type: "text-delta", text: event.text })) return
          } else if (event.type === "tool-call") {
            if (!send({ type: "tool-call", name: event.call.name })) return
          } else if (event.type === "organization-proposal") {
            if (
              !send({
                type: "organization-proposal",
                planId: event.planId,
                revision: event.revision,
              })
            ) {
              return
            }
          } else {
            if (!send({ type: "done" })) return
            terminal = true
            return
          }
        }
        if (!terminal) {
          send({
            type: "error",
            error: {
              code: "INVALID_RESPONSE",
              message: "The AI provider stream ended unexpectedly.",
            },
          })
        }
      } catch (cause) {
        console.error("Chat stream failed unexpectedly.", { requestId, cause })
        send({
          type: "error",
          error: {
            code: "UNAVAILABLE",
            message: "The assistant is temporarily unavailable.",
          },
        })
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
        const service = createChatTurnService(context.fileApi)
        if (service.isErr()) {
          return chatErrorResponse(context.fileApi.requestId, service.error)
        }
        const content = body.proposal_revision
          ? body.proposal_revision.feedback
          : body.message === "/organize"
            ? "Organize my files into a clear structure. Review the relevant file tree, inspect ambiguous files when useful, and create a proposal for me to confirm."
            : body.message
        const systemPrompt = body.proposal_revision
          ? [
              SYSTEM_PROMPT,
              "This turn is an organization proposal revision.",
              `Use this exact previous_plan_id: ${body.proposal_revision.proposal_id}.`,
              "The user message is the revision feedback. Inspect the current tree as needed and create the replacement proposal.",
            ].join(" ")
          : SYSTEM_PROMPT
        const started = await service.value.startTurn({
          conversationId: body.conversation_id ?? null,
          content,
          systemPrompt,
          abortSignal: request.signal,
        })
        if (started.isErr()) {
          return chatErrorResponse(context.fileApi.requestId, started.error)
        }
        return sseResponse(
          started.value.stream,
          started.value.conversationId,
          context.fileApi.requestId
        )
      },
    },
  },
})
