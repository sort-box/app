import { err, errAsync, ok } from "neverthrow"

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
  listFilesInputSchema,
  readFileInputSchema,
  searchFilesInputSchema,
  type FileToolError,
  type FileToolExecutor,
} from "./file-tools"

const MAX_TOOL_ROUNDS = 6
const MAX_TOOL_CALLS_PER_ROUND = 8

function invalidResponse(message: string): AiProviderError {
  return { code: "INVALID_RESPONSE", message }
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
    return JSON.stringify(
      (await executor.listFiles(input.data)).match(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error })
      )
    )
  }

  if (call.name === "search_files") {
    const input = searchFilesInputSchema.safeParse(call.arguments)
    if (!input.success) return JSON.stringify(invalidToolCall())
    return JSON.stringify(
      (await executor.searchFiles(input.data)).match(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error })
      )
    )
  }

  if (call.name === "read_file") {
    const input = readFileInputSchema.safeParse(call.arguments)
    if (!input.success) return JSON.stringify(invalidToolCall())
    return JSON.stringify(
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

    for await (const result of stream) {
      if (result.isErr()) {
        yield result
        return
      }
      const event = result.value
      if (event.type === "text-delta") {
        assistantContent += event.text
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
      yield err(
        invalidResponse("The AI provider stream ended without a finish event.")
      )
      return
    }

    if (finish.reason !== "tool-calls") {
      yield ok({
        ...finish,
        ...(usageComplete && totalUsage ? { usage: totalUsage } : {}),
      })
      return
    }

    if (toolCalls.length === 0 || toolCalls.length > MAX_TOOL_CALLS_PER_ROUND) {
      yield err(
        invalidResponse("The AI provider requested an invalid number of tools.")
      )
      return
    }
    if (round === MAX_TOOL_ROUNDS - 1) {
      yield err(
        invalidResponse("The AI provider exceeded the file tool round limit.")
      )
      return
    }

    messages.push({
      role: "assistant",
      content: assistantContent,
      toolCalls,
    })
    const toolResults = await Promise.all(
      toolCalls.map(async (call) => ({
        role: "tool" as const,
        toolCallId: call.id,
        content: await executeToolCall(call, executor),
      }))
    )
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
  }
}

/** Executes authenticated file tools until the model produces a final turn. */
export class FileToolConversationService implements AiProvider {
  constructor(
    private readonly provider: AiProvider,
    private readonly executor: FileToolExecutor
  ) {}

  streamConversation(input: StreamConversationInput) {
    if (input.tools !== undefined) {
      return errAsync<AiStream, AiProviderError>({
        code: "INVALID_INPUT",
        message: "Caller-supplied tools are not supported by this service.",
      })
    }

    return this.provider
      .streamConversation({ ...input, tools: fileToolDefinitions })
      .map((stream) =>
        continueConversation(this.provider, this.executor, input, stream)
      )
  }
}
