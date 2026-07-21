import { err, errAsync, ok } from "neverthrow"

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
  readFileInputSchema,
  searchFilesInputSchema,
  type FileToolError,
  type FileToolExecutor,
} from "./file-tools"
import type { AiMessageRecorder } from "./message-recorder"

const MAX_TOOL_ROUNDS = 6
const MAX_TOOL_CALLS_PER_ROUND = 8

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

async function executeToolCall(
  call: AiToolCall,
  executor: FileToolExecutor
): Promise<string> {
  if (call.name === "list_files") {
    const input = listFilesInputSchema.safeParse(call.arguments)
    if (!input.success) return JSON.stringify(invalidToolCall())
    return serializeToolResult(
      (await executor.listFiles(input.data)).match(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error })
      )
    )
  }

  if (call.name === "search_files") {
    const input = searchFilesInputSchema.safeParse(call.arguments)
    if (!input.success) return JSON.stringify(invalidToolCall())
    return serializeToolResult(
      (await executor.searchFiles(input.data)).match(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error })
      )
    )
  }

  if (call.name === "find_exact_references") {
    const input = findExactReferencesInputSchema.safeParse(call.arguments)
    if (!input.success) return JSON.stringify(invalidToolCall())
    return serializeToolResult(
      (await executor.findExactReferences(input.data)).match(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error })
      )
    )
  }

  if (call.name === "read_file") {
    const input = readFileInputSchema.safeParse(call.arguments)
    if (!input.success) return JSON.stringify(invalidToolCall())
    return serializeToolResult(
      (await executor.readFile(input.data)).match(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error })
      )
    )
  }

  return JSON.stringify(invalidToolCall())
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
  firstStream: AiStream
): AiStream {
  const messages: AiMessage[] = [...input.messages]
  let stream = firstStream
  let totalUsage: AiUsage | undefined
  let usageComplete = true

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
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
      if (round === MAX_TOOL_ROUNDS - 1) {
        const limitMessage =
          "\n\nI reached the per-response file-operation limit before I could finish. Ask me to continue with another batch or narrow the scope."
        const finalContent = `${assistantContent}${limitMessage}`
        const content =
          utf8ByteLength(finalContent) <= MAX_STORED_MESSAGE_BYTES
            ? finalContent
            : assistantContent
        const persistenceError = await persistAssistant(content)
        if (persistenceError) {
          yield err(persistenceError)
          return
        }
        if (content === finalContent) {
          yield ok({ type: "text-delta", text: limitMessage })
        }
        yield ok({
          type: "finish",
          reason: "stop",
          ...(usageComplete && totalUsage ? { usage: totalUsage } : {}),
        })
        return
      }

      const callsToExecute = toolCalls.slice(0, MAX_TOOL_CALLS_PER_ROUND)

      messages.push({
        role: "assistant",
        content: assistantContent,
        toolCalls: callsToExecute,
      })
      const toolResults = await Promise.all(
        callsToExecute.map(async (call) => ({
          role: "tool" as const,
          toolCallId: call.id,
          content: await executeToolCall(call, executor),
        }))
      )
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
    recorder?: AiMessageRecorder
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
          stream
        )
      )
  }
}
