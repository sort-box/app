import { ResultAsync, err, errAsync, ok } from "neverthrow"

import type {
  AiMessage,
  AiProvider,
  AiProviderError,
  AiStream,
  AiStreamEvent,
  AiToolCall,
  JsonValue,
  StreamConversationInput,
} from "../../ai-provider"

const OPENROUTER_CHAT_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions"
export const OPENROUTER_MODEL = "openai/gpt-5.4-nano"

type Fetch = typeof fetch

class OpenRouterRequestError {
  constructor(readonly error: AiProviderError) {}
}

type PendingToolCall = {
  id: string
  name: string
  argumentsJson: string
}

function providerError(
  code: AiProviderError["code"],
  message: string
): AiProviderError {
  if (code === "RATE_LIMITED" || code === "UNAVAILABLE") {
    return { code, message, retryable: true }
  }
  return { code, message }
}

function mapStatus(status: number): AiProviderError {
  if (status === 400 || status === 422) {
    return providerError("INVALID_INPUT", "The AI request was invalid.")
  }
  if (status === 401) {
    return providerError(
      "AUTHENTICATION_FAILED",
      "AI provider authentication failed."
    )
  }
  if (status === 402 || status === 403) {
    return providerError(
      "CONFIGURATION_ERROR",
      "The AI provider is not configured for this request."
    )
  }
  if (status === 429) {
    return providerError("RATE_LIMITED", "The AI provider is rate limited.")
  }
  if (status === 408 || status >= 500) {
    return providerError(
      "UNAVAILABLE",
      "The AI provider is temporarily unavailable."
    )
  }
  return providerError(
    "INVALID_RESPONSE",
    "The AI provider returned an unexpected response."
  )
}

function mapRequestError(error: unknown): AiProviderError {
  if (error instanceof OpenRouterRequestError) return error.error
  if (error instanceof DOMException && error.name === "AbortError") {
    return providerError("CANCELLED", "The AI request was cancelled.")
  }
  return providerError(
    "UNAVAILABLE",
    "The AI provider is temporarily unavailable."
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true
  }
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

function messageToRequest(message: AiMessage): Record<string, unknown> {
  if (message.role === "user") return message
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    }
  }

  return {
    role: "assistant",
    content: message.content,
    ...(message.toolCalls && message.toolCalls.length > 0
      ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments: JSON.stringify(call.arguments),
            },
          })),
        }
      : {}),
  }
}

function invalidInput(input: StreamConversationInput): boolean {
  return (
    input.messages.length === 0 ||
    input.messages.some((message) => {
      if (message.role === "tool") return message.toolCallId.trim().length === 0
      if (message.role === "assistant" && message.toolCalls?.length) {
        return message.toolCalls.some(
          (call) => call.id.trim().length === 0 || call.name.trim().length === 0
        )
      }
      return message.content.trim().length === 0
    }) ||
    input.tools?.some(
      (tool) =>
        tool.name.trim().length === 0 || tool.description.trim().length === 0
    ) === true
  )
}

async function* sseData(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer = (buffer + decoder.decode(value, { stream: !done })).replaceAll(
        "\r\n",
        "\n"
      )

      let boundary = buffer.indexOf("\n\n")
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if (data.length > 0) yield data
        boundary = buffer.indexOf("\n\n")
      }

      if (done) break
    }

    const data = buffer
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    if (data.length > 0) yield data
  } finally {
    reader.releaseLock()
  }
}

function usageFrom(chunk: Record<string, unknown>) {
  if (!isRecord(chunk.usage)) return undefined
  const inputTokens = chunk.usage.prompt_tokens
  const outputTokens = chunk.usage.completion_tokens
  if (
    typeof inputTokens !== "number" ||
    !Number.isInteger(inputTokens) ||
    inputTokens < 0 ||
    typeof outputTokens !== "number" ||
    !Number.isInteger(outputTokens) ||
    outputTokens < 0
  ) {
    return undefined
  }
  return { inputTokens, outputTokens }
}

function finishReason(value: unknown) {
  if (value === "stop" || value === "length") return value
  if (value === "tool_calls") return "tool-calls" as const
  return undefined
}

function toolCallsFrom(
  pendingToolCalls: Map<number, PendingToolCall>
): AiToolCall[] | undefined {
  const calls: AiToolCall[] = []
  for (const [, pending] of [...pendingToolCalls].sort(([a], [b]) => a - b)) {
    if (!pending.id || !pending.name) return undefined
    try {
      const argumentsValue: unknown = JSON.parse(pending.argumentsJson)
      if (!isJsonValue(argumentsValue)) return undefined
      calls.push({
        id: pending.id,
        name: pending.name,
        arguments: argumentsValue,
      })
    } catch {
      return undefined
    }
  }
  return calls
}

function accumulateToolCalls(
  value: unknown,
  pendingToolCalls: Map<number, PendingToolCall>
): boolean {
  if (!Array.isArray(value)) return false
  for (const item of value) {
    if (!isRecord(item) || !Number.isInteger(item.index)) return false
    const index = item.index as number
    if (index < 0) return false
    const pending = pendingToolCalls.get(index) ?? {
      id: "",
      name: "",
      argumentsJson: "",
    }
    if (item.id !== undefined) {
      if (typeof item.id !== "string") return false
      pending.id = item.id
    }
    if (item.function !== undefined) {
      if (!isRecord(item.function)) return false
      if (item.function.name !== undefined) {
        if (typeof item.function.name !== "string") return false
        pending.name += item.function.name
      }
      if (item.function.arguments !== undefined) {
        if (typeof item.function.arguments !== "string") return false
        pending.argumentsJson += item.function.arguments
      }
    }
    pendingToolCalls.set(index, pending)
  }
  return true
}

async function* openRouterStream(body: ReadableStream<Uint8Array>): AiStream {
  const pendingToolCalls = new Map<number, PendingToolCall>()
  let pendingFinish: Extract<AiStreamEvent, { type: "finish" }> | undefined

  try {
    for await (const data of sseData(body)) {
      if (data === "[DONE]") {
        break
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(data)
      } catch {
        yield err(
          providerError(
            "INVALID_RESPONSE",
            "The AI provider returned an invalid stream."
          )
        )
        return
      }
      if (!isRecord(parsed)) {
        yield err(
          providerError(
            "INVALID_RESPONSE",
            "The AI provider returned an invalid stream."
          )
        )
        return
      }
      if (parsed.error !== undefined) {
        yield err(
          providerError(
            "UNAVAILABLE",
            "The AI provider stream was interrupted."
          )
        )
        return
      }

      const usage = usageFrom(parsed)
      if (usage && pendingFinish) pendingFinish.usage = usage
      if (!Array.isArray(parsed.choices)) {
        yield err(
          providerError(
            "INVALID_RESPONSE",
            "The AI provider returned an invalid stream."
          )
        )
        return
      }
      if (parsed.choices.length === 0) continue

      const choice = parsed.choices[0]
      if (!isRecord(choice) || !isRecord(choice.delta)) {
        yield err(
          providerError(
            "INVALID_RESPONSE",
            "The AI provider returned an invalid stream."
          )
        )
        return
      }
      if (choice.delta.content !== undefined && choice.delta.content !== null) {
        if (typeof choice.delta.content !== "string") {
          yield err(
            providerError(
              "INVALID_RESPONSE",
              "The AI provider returned an invalid stream."
            )
          )
          return
        }
        if (choice.delta.content.length > 0) {
          yield ok({ type: "text-delta", text: choice.delta.content })
        }
      }
      if (
        choice.delta.tool_calls !== undefined &&
        !accumulateToolCalls(choice.delta.tool_calls, pendingToolCalls)
      ) {
        yield err(
          providerError(
            "INVALID_RESPONSE",
            "The AI provider returned an invalid tool call."
          )
        )
        return
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        const reason = finishReason(choice.finish_reason)
        if (!reason) {
          yield err(
            providerError(
              "INVALID_RESPONSE",
              "The AI provider returned an unsupported finish reason."
            )
          )
          return
        }
        pendingFinish = { type: "finish", reason, ...(usage ? { usage } : {}) }
      }
    }
  } catch (error) {
    yield err(mapRequestError(error))
    return
  }

  if (!pendingFinish) {
    yield err(
      providerError(
        "INVALID_RESPONSE",
        "The AI provider stream ended unexpectedly."
      )
    )
    return
  }
  if (pendingFinish.reason === "tool-calls") {
    const toolCalls = toolCallsFrom(pendingToolCalls)
    if (!toolCalls || toolCalls.length === 0) {
      yield err(
        providerError(
          "INVALID_RESPONSE",
          "The AI provider returned an invalid tool call."
        )
      )
      return
    }
    for (const call of toolCalls) yield ok({ type: "tool-call", call })
  } else if (pendingToolCalls.size > 0) {
    yield err(
      providerError(
        "INVALID_RESPONSE",
        "The AI provider returned an incomplete tool call."
      )
    )
    return
  }
  yield ok(pendingFinish)
}

export class OpenRouterAiProvider implements AiProvider {
  constructor(
    private readonly apiKey: string,
    private readonly fetch: Fetch = globalThis.fetch
  ) {}

  streamConversation(input: StreamConversationInput) {
    if (this.apiKey.trim().length === 0) {
      return errAsync<AiStream, AiProviderError>(
        providerError(
          "CONFIGURATION_ERROR",
          "The AI provider API key is not configured."
        )
      )
    }
    if (invalidInput(input)) {
      return errAsync<AiStream, AiProviderError>(
        providerError("INVALID_INPUT", "The AI request was invalid.")
      )
    }

    const messages = [
      ...(input.systemPrompt
        ? [{ role: "system", content: input.systemPrompt }]
        : []),
      ...input.messages.map(messageToRequest),
    ]
    const request = {
      model: OPENROUTER_MODEL,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(input.tools && input.tools.length > 0
        ? {
            tools: input.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            })),
          }
        : {}),
    }

    return ResultAsync.fromPromise(
      (async () => {
        const response = await this.fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(request),
          signal: input.abortSignal,
        })
        if (!response.ok) {
          throw new OpenRouterRequestError(mapStatus(response.status))
        }
        if (!response.body) {
          throw new OpenRouterRequestError(
            providerError(
              "INVALID_RESPONSE",
              "The AI provider returned an empty stream."
            )
          )
        }
        return openRouterStream(response.body)
      })(),
      mapRequestError
    )
  }
}
