import { useState, type ReactNode } from "react"
import { createFileRoute } from "@tanstack/react-router"
import {
  SignInButton,
  SignUpButton,
  useClerk,
  useUser,
} from "@clerk/tanstack-react-start"
import {
  Authenticated,
  AuthLoading,
  Unauthenticated,
  useQuery,
} from "convex/react"
import {
  ArrowRightIcon,
  FolderIcon,
  LogOutIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
} from "lucide-react"

import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import { ChatList } from "@/features/chat/chat-list"
import { ChatPane } from "@/features/chat/chat-pane"
import { CloudPane } from "@/features/cloud/cloud-pane"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"

export const Route = createFileRoute("/")({ component: App })

function App() {
  return (
    <>
      <AuthLoading>
        <LoadingScreen />
      </AuthLoading>
      <Unauthenticated>
        <Welcome />
      </Unauthenticated>
      <Authenticated>
        <Dashboard />
      </Authenticated>
    </>
  )
}

function Welcome() {
  return (
    <main className="grid min-h-svh place-items-center bg-muted/30 px-6">
      <section className="w-full max-w-xl space-y-8">
        <div className="flex size-11 items-center justify-center rounded-lg bg-primary text-lg font-semibold text-primary-foreground">
          U
        </div>
        <div className="space-y-4">
          <p className="text-sm font-medium text-muted-foreground">
            TanStack Start · Convex · Clerk
          </p>
          <h1 className="max-w-lg text-4xl font-semibold tracking-tight sm:text-5xl">
            Untie is ready to build.
          </h1>
          <p className="max-w-md text-base leading-7 text-muted-foreground">
            Authentication, realtime data, server rendering, and the shadcn
            component system are connected.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <SignUpButton>
            <Button size="lg">
              Create an account
              <ArrowRightIcon />
            </Button>
          </SignUpButton>
          <SignInButton>
            <Button size="lg" variant="outline">
              Sign in
            </Button>
          </SignInButton>
        </div>
      </section>
    </main>
  )
}

const sections = [
  { id: "chat", label: "New Chat", icon: SquarePenIcon },
  { id: "cloud", label: "Cloud", icon: FolderIcon },
] as const

type SectionId = (typeof sections)[number]["id"]

type ChatState = {
  paneKey: number
  initialConversationId: Id<"chatConversations"> | null
  activeConversationId: Id<"chatConversations"> | null
}

function renderSection(
  section: SectionId,
  chat: ChatState,
  onConversationCreated: (conversationId: string) => void
): ReactNode {
  switch (section) {
    case "chat":
      return (
        <ChatSection
          chat={chat}
          onConversationCreated={onConversationCreated}
        />
      )
    case "cloud":
      return <CloudPane />
  }
}

function ChatSection({
  chat,
  onConversationCreated,
}: {
  chat: ChatState
  onConversationCreated: (conversationId: string) => void
}) {
  const history = useQuery(
    api.chatHistory.listMessages,
    chat.initialConversationId
      ? { conversationId: chat.initialConversationId }
      : "skip"
  )
  if (chat.initialConversationId && history === undefined) return null

  return (
    <ChatPane
      key={chat.paneKey}
      conversationId={chat.initialConversationId}
      initialMessages={(history ?? []).map((message) => ({
        id: crypto.randomUUID(),
        ...message,
      }))}
      onConversationCreated={onConversationCreated}
    />
  )
}

function Shell({
  account,
  renderSection,
}: {
  account: ReactNode
  renderSection?: (
    section: SectionId,
    chat: ChatState,
    onConversationCreated: (conversationId: string) => void
  ) => ReactNode
}) {
  const [activeSection, setActiveSection] = useState<SectionId>("chat")
  const [chat, setChat] = useState<ChatState>({
    paneKey: 0,
    initialConversationId: null,
    activeConversationId: null,
  })
  const active = sections.find((section) => section.id === activeSection)

  const openChat = (conversationId: Id<"chatConversations"> | null) => {
    setActiveSection("chat")
    setChat((current) => ({
      paneKey: current.paneKey + 1,
      initialConversationId: conversationId,
      activeConversationId: conversationId,
    }))
  }

  return (
    <div className="h-svh">
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel
          defaultSize="240px"
          minSize="180px"
          maxSize="400px"
          className="bg-sidebar text-sidebar-foreground shadow-[inset_-8px_0_16px_-4px_rgba(0,0,0,0.1)]"
        >
          <div className="flex h-full flex-col">
            <div className="flex items-center justify-between p-2 pl-4">
              <span className="font-['Geist_Variable'] text-xl font-semibold tracking-tight">
                Untie
              </span>
              <Button variant="ghost" size="icon">
                <SearchIcon strokeWidth={1.5} />
              </Button>
            </div>
            <nav className="flex flex-col gap-1 p-2">
              {sections.map(({ id, label, icon: Icon }) => (
                <Button
                  key={id}
                  variant="ghost"
                  data-active={activeSection === id}
                  onClick={() =>
                    id === "chat" ? openChat(null) : setActiveSection(id)
                  }
                  className="justify-start font-normal data-[active=true]:bg-foreground/10 data-[active=true]:text-sidebar-accent-foreground"
                >
                  <Icon
                    strokeWidth={1.5}
                    className="text-sidebar-foreground/70"
                  />
                  {label}
                </Button>
              ))}
            </nav>
            {renderSection && (
              <ChatList
                selectedConversationId={
                  activeSection === "chat" ? chat.activeConversationId : null
                }
                onSelect={openChat}
              />
            )}
            <div className="mt-auto">
              <Separator />
              <div className="p-2">{account}</div>
            </div>
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel className="overflow-hidden!">
          {renderSection?.(activeSection, chat, (conversationId) =>
            setChat((current) => ({
              ...current,
              activeConversationId: conversationId as Id<"chatConversations">,
            }))
          ) ?? (
            <main className="grid h-full place-items-center text-sm text-muted-foreground">
              {active?.label}
            </main>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}

function AccountSkeleton() {
  return (
    <div className="flex h-8 items-center gap-1.5 px-3">
      <Skeleton className="size-5 rounded-full" />
      <Skeleton className="h-4 w-24" />
    </div>
  )
}

function Dashboard() {
  const { user, isLoaded } = useUser()
  const { signOut, openUserProfile } = useClerk()
  const username =
    user?.username ??
    user?.fullName ??
    user?.primaryEmailAddress?.emailAddress ??
    "Account"

  if (!isLoaded) {
    return <Shell account={<AccountSkeleton />} renderSection={renderSection} />
  }

  return (
    <Shell
      renderSection={renderSection}
      account={
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                className="w-full justify-start aria-expanded:bg-sidebar-accent"
              />
            }
          >
            <Avatar className="size-5">
              <AvatarImage src={user?.imageUrl} alt={username} />
              <AvatarFallback>
                <Skeleton className="size-full rounded-full" />
              </AvatarFallback>
            </Avatar>
            <span className="truncate">{username}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" sideOffset={4}>
            <DropdownMenuItem onClick={() => openUserProfile()}>
              <SettingsIcon />
              Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => signOut()}>
              <LogOutIcon />
              Disconnect
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    />
  )
}

function LoadingScreen() {
  return <Shell account={<AccountSkeleton />} />
}
