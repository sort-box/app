import type { ChatStreamEvent } from "./chat-transport"

export class ChatApiError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = "ChatApiError"
  }
}

const FALLBACK_MESSAGE = "The assistant is temporarily unavailable."

function parseEvent(data: string): ChatStreamEvent | null {
  try {
    const parsed = JSON.parse(data) as ChatStreamEvent
    if (
      (parsed.type === "conversation-id" &&
        typeof parsed.conversationId === "string") ||
      (parsed.type === "text-delta" && typeof parsed.text === "string") ||
      (parsed.type === "tool-call" && typeof parsed.name === "string") ||
      (parsed.type === "error" &&
        typeof parsed.error?.message === "string" &&
        typeof parsed.error.code === "string") ||
      parsed.type === "done"
    ) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

async function readEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ChatStreamEvent) => void
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  const emit = (block: string) => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    if (data.length === 0) return
    const event = parseEvent(data)
    if (event) onEvent(event)
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer = (buffer + decoder.decode(value, { stream: !done })).replaceAll(
        "\r\n",
        "\n"
      )
      let boundary = buffer.indexOf("\n\n")
      while (boundary !== -1) {
        emit(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf("\n\n")
      }
      if (done) break
    }
    emit(buffer)
  } finally {
    reader.releaseLock()
  }
}

/**
 * Sends the conversation to the assistant and forwards streamed events.
 * Resolves when the stream ends; rejects with ChatApiError when the request
 * itself fails before streaming starts.
 */
export async function streamChat(input: {
  conversationId: string | null
  message: string
  signal?: AbortSignal
  onEvent: (event: ChatStreamEvent) => void
}): Promise<void> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversation_id: input.conversationId,
      message: input.message,
    }),
    signal: input.signal,
  })
  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: unknown; message?: unknown }
    } | null
    throw new ChatApiError(
      typeof body?.error?.code === "string" ? body.error.code : "UNAVAILABLE",
      typeof body?.error?.message === "string"
        ? body.error.message
        : FALLBACK_MESSAGE
    )
  }
  await readEvents(response.body, input.onEvent)
}
