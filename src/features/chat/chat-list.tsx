import { useQuery } from "convex/react"

import { api } from "../../../convex/_generated/api"
import type { Id } from "../../../convex/_generated/dataModel"
import { Button } from "@/components/ui/button"

export function ChatList({
  selectedConversationId,
  onSelect,
}: {
  selectedConversationId: Id<"chatConversations"> | null
  onSelect: (conversationId: Id<"chatConversations">) => void
}) {
  const conversations = useQuery(api.chatHistory.listConversations)
  if (!conversations || conversations.length === 0) return null

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2 pt-4">
      <p className="px-3 pb-1 text-sm text-muted-foreground">Chats</p>
      {conversations.map((conversation) => (
        <Button
          key={conversation.conversationId}
          variant="ghost"
          data-active={conversation.conversationId === selectedConversationId}
          onClick={() => onSelect(conversation.conversationId)}
          className="shrink-0 justify-start font-normal data-[active=true]:bg-foreground/10 data-[active=true]:text-sidebar-accent-foreground"
        >
          <span className="truncate">{conversation.title || "New chat"}</span>
        </Button>
      ))}
    </div>
  )
}
