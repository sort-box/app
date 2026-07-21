import { useEffect, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { ArrowUpIcon, SquareIcon } from "lucide-react"

import { ChatApiError, streamChat } from "./api"
import { MAX_CHAT_MESSAGE_LENGTH } from "./chat-transport"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

export type ChatMessage = {
  id: string
  role: "user" | "assistant"
  content: string
}

const FALLBACK_ERROR = "The assistant is temporarily unavailable."

const toolActivityLabels: Record<string, string> = {
  list_files: "Browsing your files…",
  search_files: "Searching your files…",
  find_exact_references: "Finding exact references…",
  read_file: "Reading a file…",
}

export function ChatPane({
  conversationId: initialConversationId = null,
  initialMessages,
  onConversationCreated,
}: {
  conversationId?: string | null
  initialMessages?: Array<ChatMessage>
  onConversationCreated?: (conversationId: string) => void
} = {}) {
  const [messages, setMessages] = useState<Array<ChatMessage>>(
    initialMessages ?? []
  )
  const [conversationId, setConversationId] = useState<string | null>(
    initialConversationId
  )
  const [isStreaming, setIsStreaming] = useState(false)
  const [activity, setActivity] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView()
  }, [messages, activity])

  useEffect(() => () => abortRef.current?.abort(), [])

  const sendMessage = async (content: string) => {
    if (isStreaming) return
    const userId = crypto.randomUUID()
    const assistantId = crypto.randomUUID()
    setMessages((current) => [
      ...current,
      { id: userId, role: "user", content },
      { id: assistantId, role: "assistant", content: "" },
    ])
    setError(null)
    setActivity("Thinking…")
    setIsStreaming(true)
    const controller = new AbortController()
    abortRef.current = controller
    let accepted = false

    try {
      await streamChat({
        conversationId,
        message: content,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "conversation-id") {
            accepted = true
            setConversationId(event.conversationId)
            onConversationCreated?.(event.conversationId)
          } else if (event.type === "text-delta") {
            setActivity(null)
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantId
                  ? { ...message, content: message.content + event.text }
                  : message
              )
            )
          } else if (event.type === "tool-call") {
            setActivity(toolActivityLabels[event.name] ?? "Working…")
          } else if (event.type === "error") {
            setError(event.error.message)
          }
        },
      })
    } catch (caught) {
      if (!accepted) {
        setMessages((current) =>
          current.filter(
            (message) => message.id !== userId && message.id !== assistantId
          )
        )
      }
      if (!controller.signal.aborted) {
        setError(
          caught instanceof ChatApiError ? caught.message : FALLBACK_ERROR
        )
      }
    } finally {
      abortRef.current = null
      setIsStreaming(false)
      setActivity(null)
      setMessages((current) =>
        current.filter(
          (message) => message.id !== assistantId || message.content.length > 0
        )
      )
    }
  }

  const stop = () => abortRef.current?.abort()

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="grid h-full place-items-center px-4">
            <p className="text-lg text-muted-foreground">
              Ask anything about your files.
            </p>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
            {messages.map((message) => (
              <Message key={message.id} message={message} />
            ))}
            {activity !== null && (
              <p className="animate-pulse text-sm text-muted-foreground">
                {activity}
              </p>
            )}
            <div ref={endRef} />
          </div>
        )}
        {error !== null && (
          <p className="mx-auto w-full max-w-3xl px-4 pb-4 text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      <div className="mx-auto w-full max-w-3xl px-4 pb-4">
        <Composer
          onSend={sendMessage}
          onStop={stop}
          isStreaming={isStreaming}
        />
      </div>
    </div>
  )
}

function Message({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] rounded-2xl bg-muted px-4 py-2.5 text-sm whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    )
  }
  if (message.content.length === 0) return null

  return (
    <div className="prose prose-sm max-w-none dark:prose-invert">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {message.content}
      </ReactMarkdown>
    </div>
  )
}

function Composer({
  onSend,
  onStop,
  isStreaming,
}: {
  onSend: (content: string) => void
  onStop: () => void
  isStreaming: boolean
}) {
  const [input, setInput] = useState("")

  const submit = () => {
    const content = input.trim()
    if (!content || isStreaming) return
    onSend(content)
    setInput("")
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
      className="flex items-end gap-2 rounded-3xl border bg-background p-2 shadow-sm"
    >
      <Textarea
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault()
            submit()
          }
        }}
        placeholder="Ask anything"
        aria-label="Message"
        maxLength={MAX_CHAT_MESSAGE_LENGTH}
        className={cn(
          "max-h-48 min-h-9 overflow-y-auto rounded-none bg-transparent",
          "focus-visible:border-transparent focus-visible:ring-0"
        )}
      />
      {isStreaming ? (
        <Button
          type="button"
          size="icon"
          aria-label="Stop response"
          onClick={onStop}
          className="rounded-full"
        >
          <SquareIcon className="fill-current" />
        </Button>
      ) : (
        <Button
          type="submit"
          size="icon"
          aria-label="Send message"
          disabled={!input.trim()}
          className="rounded-full"
        >
          <ArrowUpIcon />
        </Button>
      )}
    </form>
  )
}
