import { err, errAsync, ok, type ResultAsync } from "neverthrow"

import {
  MAX_STORED_MESSAGE_BYTES,
  MAX_TOOL_RESULT_OUTPUT_BYTES,
  utf8ByteLength,
} from "./chat-history-contract"
import type {
  AiMessage,
  AiProvider,
  AiProviderError,
  AiStream,
  AiStreamEvent,
  AiToolCall,
  AiUsage,
  StreamConversationInput,
} from "./ai-provider"
import {
  fileToolDefinitions,
  findExactReferencesInputSchema,
  listFilesInputSchema,
  proposeFileOrganizationInputSchema,
  readFileInputSchema,
  searchFilesInputSchema,
  type FileToolError,
  type FileToolExecutor,
} from "./file-tools"
import type { AiMessageRecorder } from "./message-recorder"

const MAX_TOOL_CALLS_PER_ROUND = 8
const MAX_TRANSIENT_TOOL_ATTEMPTS = 3

type FileToolSession = {
  discoveredFiles: Set<string>
  listCursors: Map<string, string>
}

async function executeWithRetry<T>(run: () => ResultAsync<T, FileToolError>) {
  let result = await run()
  for (
    let attempt = 1;
    result.isErr() &&
    result.error.retryable &&
    attempt < MAX_TRANSIENT_TOOL_ATTEMPTS;
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, attempt * 100))
    result = await run()
  }
  return result
}

function invalidResponse(message: string): AiProviderError {
  return { code: "INVALID_RESPONSE", message }
}

function serializeToolResult(value: unknown): string {
  const serialized = JSON.stringify(value)
  if (utf8ByteLength(serialized) <= MAX_TOOL_RESULT_OUTPUT_BYTES) {
    return serialized
  }
  return JSON.stringify({
    ok: false,
    error: {
      code: "UNAVAILABLE",
      message: "The file tool result exceeded the response limit.",
      retryable: false,
    },
  })
}

function invalidToolCall(): { ok: false; error: FileToolError } {
  return {
    ok: false,
    error: {
      code: "INVALID_INPUT",
      message: "The file tool call was invalid.",
      retryable: false,
    },
  }
}

function proposalInputError(
  input: typeof proposeFileOrganizationInputSchema._output
): string | undefined {
  const sources = new Set<string>()
  const destinations = new Set<string>()
  const unchanged = new Set(input.unchanged_paths ?? [])
  const unresolved = new Set(input.unresolved_paths ?? [])
  for (const operation of input.operations) {
    if (operation.before_path === operation.after_path) {
      return `Source and destination are identical: ${operation.before_path}. Remove this operation and account for it as unchanged.`
    }
    if (sources.has(operation.before_path)) {
      return `Duplicate source path: ${operation.before_path}. Include each source in exactly one operation.`
    }
    if (destinations.has(operation.after_path)) {
      return `Duplicate destination path: ${operation.after_path}. Give each item a unique destination.`
    }
    if (unchanged.has(operation.before_path)) {
      return `Path is both moved and unchanged: ${operation.before_path}. Keep it in exactly one category.`
    }
    if (unresolved.has(operation.before_path)) {
      return `Path is both moved and unresolved: ${operation.before_path}. Keep it in exactly one category.`
    }
    const overlappingSource = [...sources].find(
      (source) =>
        operation.before_path.startsWith(`${source}/`) ||
        source.startsWith(`${operation.before_path}/`)
    )
    if (overlappingSource) {
      return `Overlapping source paths: ${overlappingSource} and ${operation.before_path}. Move the folder or its descendant, not both.`
    }
    sources.add(operation.before_path)
    destinations.add(operation.after_path)
  }
  const duplicatedClassification = [...unchanged].find((path) =>
    unresolved.has(path)
  )
  if (duplicatedClassification) {
    return `Path is both unchanged and unresolved: ${duplicatedClassification}. Keep it in exactly one category.`
  }
  return undefined
}

async function executeToolCall(
  call: AiToolCall,
  executor: FileToolExecutor,
  conversationId: string,
  session: FileToolSession
): Promise<{
  content: string
  proposal?: { planId: string; revision: number }
}> {
  const content = (value: string) => ({ content: value })
  if (call.name === "list_files") {
    const input = listFilesInputSchema.safeParse(call.arguments)
    if (!input.success) return content(JSON.stringify(invalidToolCall()))
    const path = input.data.path ?? "/"
    const cursor = input.data.cursor
      ? (session.listCursors.get(path) ?? null)
      : null
    const result = await executeWithRetry(() =>
      executor.listFiles({ ...input.data, cursor })
    )
    if (result.isOk()) {
      for (const entry of result.value.entries) {
        if (entry.kind === "file") session.discoveredFiles.add(entry.path)
      }
      if (result.value.next_cursor) {
        session.listCursors.set(path, result.value.next_cursor)
      } else {
        session.listCursors.delete(path)
      }
    }
    return content(
      serializeToolResult(
        result.match(
          (value) => ({ ok: true as const, value }),
          (error) => ({ ok: false as const, error })
        )
      )
    )
  }

  if (call.name === "search_files") {
    const input = searchFilesInputSchema.safeParse(call.arguments)
    if (!input.success) return content(JSON.stringify(invalidToolCall()))
    return content(
      serializeToolResult(
        (await executeWithRetry(() => executor.searchFiles(input.data))).match(
          (value) => ({ ok: true as const, value }),
          (error) => ({ ok: false as const, error })
        )
      )
    )
  }

  if (call.name === "find_exact_references") {
    const input = findExactReferencesInputSchema.safeParse(call.arguments)
    if (!input.success) return content(JSON.stringify(invalidToolCall()))
    return content(
      serializeToolResult(
        (
          await executeWithRetry(() => executor.findExactReferences(input.data))
        ).match(
          (value) => ({ ok: true as const, value }),
          (error) => ({ ok: false as const, error })
        )
      )
    )
  }

  if (call.name === "read_file") {
    const input = readFileInputSchema.safeParse(call.arguments)
    if (!input.success) return content(JSON.stringify(invalidToolCall()))
    return content(
      serializeToolResult(
        (await executeWithRetry(() => executor.readFile(input.data))).match(
          (value) => ({ ok: true as const, value }),
          (error) => ({ ok: false as const, error })
        )
      )
    )
  }

  if (call.name === "propose_file_organization") {
    const input = proposeFileOrganizationInputSchema.safeParse(call.arguments)
    if (!input.success) return content(JSON.stringify(invalidToolCall()))
    const inputError = proposalInputError(input.data)
    if (inputError) {
      return content(
        serializeToolResult({
          ok: false,
          error: {
            code: "INVALID_INPUT",
            message: inputError,
            retryable: false,
          },
        })
      )
    }
    const accounted = new Set([
      ...input.data.operations.map((operation) => operation.before_path),
      ...(input.data.unchanged_paths ?? []),
      ...(input.data.unresolved_paths ?? []),
    ])
    const missing = [...session.discoveredFiles].filter(
      (path) => !accounted.has(path)
    )
    if (missing.length > 0) {
      return content(
        serializeToolResult({
          ok: false,
          error: {
            code: "INVALID_INPUT",
            message: `The proposal omitted ${missing.length} discovered file(s). Account for each as moved, unchanged, or unresolved. Missing paths: ${missing.slice(0, 25).join(", ")}${missing.length > 25 ? "…" : ""}`,
            retryable: false,
          },
        })
      )
    }
    const result = await executeWithRetry(() =>
      executor.proposeFileOrganization(input.data, conversationId)
    )
    return result.match(
      (value) => ({
        content: serializeToolResult({ ok: true as const, value }),
        proposal: { planId: value.plan_id, revision: value.revision },
      }),
      (error) => ({
        content: serializeToolResult({ ok: false as const, error }),
      })
    )
  }

  return content(JSON.stringify(invalidToolCall()))
}

function addUsage(total: AiUsage | undefined, next: AiUsage | undefined) {
  if (!next) return total
  return {
    inputTokens: (total?.inputTokens ?? 0) + next.inputTokens,
    outputTokens: (total?.outputTokens ?? 0) + next.outputTokens,
  }
}

async function* continueConversation(
  provider: AiProvider,
  executor: FileToolExecutor,
  recorder: AiMessageRecorder | undefined,
  input: StreamConversationInput,
  firstStream: AiStream,
  conversationId: string
): AiStream {
  const messages: AiMessage[] = [...input.messages]
  let stream = firstStream
  let totalUsage: AiUsage | undefined
  let usageComplete = true
  const session: FileToolSession = {
    discoveredFiles: new Set(),
    listCursors: new Map(),
  }

  for (;;) {
    let assistantContent = ""
    const toolCalls: AiToolCall[] = []
    let finish: Extract<AiStreamEvent, { type: "finish" }> | undefined
    let roundPersisted = false

    const persistAssistant = async (content = assistantContent) => {
      if (roundPersisted) return undefined
      if (!recorder || content.length === 0) {
        roundPersisted = true
        return undefined
      }
      // Treat recording as a single attempt. A failed adapter response may
      // still follow a successful write, so retrying from generator cleanup
      // could duplicate the assistant message.
      roundPersisted = true
      const recorded = await recorder.recordMessages([
        { role: "assistant", content },
      ])
      if (recorded.isErr()) return recorded.error
      return undefined
    }

    try {
      for await (const result of stream) {
        if (result.isErr()) {
          const persistenceError = await persistAssistant()
          yield persistenceError ? err(persistenceError) : result
          return
        }
        const event = result.value
        if (event.type === "text-delta") {
          const nextContent = assistantContent + event.text
          if (utf8ByteLength(nextContent) > MAX_STORED_MESSAGE_BYTES) {
            const persistenceError = await persistAssistant()
            yield err(
              persistenceError ??
                invalidResponse(
                  "The AI response exceeded the conversation history limit."
                )
            )
            return
          }
          assistantContent = nextContent
          yield result
        } else if (event.type === "tool-call") {
          toolCalls.push(event.call)
          yield result
        } else if (event.type === "organization-proposal") {
          yield result
        } else {
          finish = event
          usageComplete &&= event.usage !== undefined
          totalUsage = addUsage(totalUsage, event.usage)
        }
      }

      if (!finish) {
        const persistenceError = await persistAssistant()
        yield err(
          persistenceError ??
            invalidResponse(
              "The AI provider stream ended without a finish event."
            )
        )
        return
      }

      if (finish.reason !== "tool-calls") {
        const persistenceError = await persistAssistant()
        if (persistenceError) {
          yield err(persistenceError)
          return
        }
        yield ok({
          ...finish,
          ...(usageComplete && totalUsage ? { usage: totalUsage } : {}),
        })
        return
      }

      if (toolCalls.length === 0) {
        const persistenceError = await persistAssistant()
        yield err(
          persistenceError ??
            invalidResponse(
              "The AI provider requested tools without valid calls."
            )
        )
        return
      }
      const callsToExecute = toolCalls.slice(0, MAX_TOOL_CALLS_PER_ROUND)

      messages.push({
        role: "assistant",
        content: assistantContent,
        toolCalls: callsToExecute,
      })
      const executions = await Promise.all(
        callsToExecute.map((call) =>
          executeToolCall(call, executor, conversationId, session)
        )
      )
      const toolResults = callsToExecute.map((call, index) => ({
        role: "tool" as const,
        toolCallId: call.id,
        content: executions[index].content,
      }))
      for (const execution of executions) {
        if (execution.proposal) {
          yield ok({ type: "organization-proposal", ...execution.proposal })
        }
      }
      if (recorder) {
        // See persistAssistant: do not retry an uncertain write in finally.
        roundPersisted = true
        const recorded = await recorder.recordMessages([
          {
            role: "assistant",
            content: assistantContent,
            toolCalls: callsToExecute,
          },
          ...toolResults,
        ])
        if (recorded.isErr()) {
          yield err(recorded.error)
          return
        }
      }
      roundPersisted = true
      messages.push(...toolResults)

      const next = await provider.streamConversation({
        messages,
        systemPrompt: input.systemPrompt,
        tools: fileToolDefinitions,
        abortSignal: input.abortSignal,
      })
      if (next.isErr()) {
        yield err(next.error)
        return
      }
      stream = next.value
    } finally {
      if (!roundPersisted && assistantContent.length > 0) {
        await recorder?.recordMessages([
          { role: "assistant", content: assistantContent },
        ])
      }
    }
  }
}

/** Executes authenticated file tools until the model produces a final turn. */
export class FileToolConversationService implements AiProvider {
  constructor(
    private readonly provider: AiProvider,
    private readonly executor: FileToolExecutor
  ) {}

  streamConversation(
    input: StreamConversationInput,
    recorder?: AiMessageRecorder,
    conversationId?: string
  ) {
    if (input.tools !== undefined) {
      return errAsync<AiStream, AiProviderError>({
        code: "INVALID_INPUT",
        message: "Caller-supplied tools are not supported by this service.",
      })
    }

    return this.provider
      .streamConversation({ ...input, tools: fileToolDefinitions })
      .map((stream) =>
        continueConversation(
          this.provider,
          this.executor,
          recorder,
          input,
          stream,
          conversationId ?? ""
        )
      )
  }
}
