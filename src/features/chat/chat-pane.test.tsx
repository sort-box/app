// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { ChatPane } from "./chat-pane"
import { streamChat } from "./api"
import type * as ApiModule from "./api"

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  streamChat: vi.fn(),
}))

const streamChatMock = vi.mocked(streamChat)

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  streamChatMock.mockReset()
})

afterEach(cleanup)

function send(text: string) {
  const input = screen.getByLabelText("Message")
  fireEvent.change(input, { target: { value: text } })
  fireEvent.keyDown(input, { key: "Enter" })
  return input as HTMLTextAreaElement
}

describe("ChatPane", () => {
  it("shows an empty state before the first message", () => {
    render(<ChatPane />)
    expect(screen.getByText("Ask anything about your files.")).toBeDefined()
  })

  it("sends the conversation and renders the streamed markdown reply", async () => {
    streamChatMock.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: "conversation-id", conversationId: "chat-1" })
      onEvent({ type: "text-delta", text: "Revenue **increased**." })
      onEvent({ type: "done" })
    })
    render(<ChatPane />)

    const input = send("How did revenue evolve?")

    expect(input.value).toBe("")
    expect(streamChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: null,
        message: "How did revenue evolve?",
      })
    )
    expect(screen.getByText("How did revenue evolve?")).toBeDefined()
    await waitFor(() => {
      const bold = screen.getByText("increased")
      expect(bold.tagName).toBe("STRONG")
    })
  })

  it("continues with the server-issued conversation id", async () => {
    streamChatMock
      .mockImplementationOnce(async ({ onEvent }) => {
        onEvent({ type: "conversation-id", conversationId: "chat-1" })
        onEvent({ type: "text-delta", text: "First reply" })
        onEvent({ type: "done" })
      })
      .mockImplementationOnce(async ({ onEvent }) => {
        onEvent({ type: "conversation-id", conversationId: "chat-1" })
        onEvent({ type: "text-delta", text: "Second reply" })
        onEvent({ type: "done" })
      })
    render(<ChatPane />)

    send("Check my files")
    await waitFor(() => expect(screen.getByText("First reply")).toBeDefined())
    send("What did you find?")

    await waitFor(() => expect(streamChatMock).toHaveBeenCalledTimes(2))
    expect(streamChatMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        conversationId: "chat-1",
        message: "What did you find?",
      })
    )
  })

  it("surfaces stream errors without losing the conversation", async () => {
    streamChatMock.mockImplementation(async ({ onEvent }) => {
      onEvent({
        type: "error",
        error: {
          code: "USAGE_LIMIT_EXCEEDED",
          message: "The AI usage limit has been reached.",
        },
      })
    })
    render(<ChatPane />)

    send("Hello")

    await waitFor(() => {
      expect(
        screen.getByText("The AI usage limit has been reached.")
      ).toBeDefined()
    })
    expect(screen.getByText("Hello")).toBeDefined()
  })

  it("renders loaded history and continues the opened conversation", async () => {
    streamChatMock.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: "done" })
    })
    render(
      <ChatPane
        conversationId="chat-7"
        initialMessages={[
          { id: "m1", role: "user", content: "Earlier question" },
          { id: "m2", role: "assistant", content: "Earlier answer" },
        ]}
      />
    )

    expect(screen.getByText("Earlier question")).toBeDefined()
    expect(screen.getByText("Earlier answer")).toBeDefined()

    send("Follow up")

    await waitFor(() =>
      expect(streamChatMock).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "chat-7",
          message: "Follow up",
        })
      )
    )
  })

  it("does not send blank messages", () => {
    render(<ChatPane />)
    const sendButton = screen.getByRole("button", { name: "Send message" })

    expect((sendButton as HTMLButtonElement).disabled).toBe(true)
    expect(streamChatMock).not.toHaveBeenCalled()
  })
})
