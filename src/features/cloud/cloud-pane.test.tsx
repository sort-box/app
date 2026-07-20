// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { CloudPane } from "./cloud-pane"
import { listFiles, type FileEntry, type FileListPage } from "./api"
import type * as ApiModule from "./api"

vi.mock("./api", async (importOriginal) => {
  const original = await importOriginal<typeof ApiModule>()
  return {
    ...original,
    createDownload: vi.fn(),
    deleteFile: vi.fn(),
    listFiles: vi.fn(),
    moveFile: vi.fn(),
    uploadFile: vi.fn(),
  }
})

function entry(
  basename: string,
  overrides: Partial<FileEntry> = {}
): FileEntry {
  return {
    _id: basename,
    _creationTime: 1,
    path: `/${basename}`,
    parentPath: "/",
    basename,
    kind: "file",
    fileId: `${basename}-file`,
    ...overrides,
  }
}

function page(
  entries: Array<FileEntry>,
  isDone: boolean,
  continueCursor = ""
): FileListPage {
  return { page: entries, isDone, continueCursor }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function renderCloudPane() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <CloudPane />
    </QueryClientProvider>
  )
}

describe("CloudPane infinite scrolling", () => {
  let viewportClientHeight: number
  let viewportScrollHeight: number

  beforeEach(() => {
    viewportClientHeight = 600
    viewportScrollHeight = 1_200
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.dataset.testid === "cloud-scroll" ? viewportClientHeight : 0
      }
    )
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.dataset.testid === "cloud-scroll" ? viewportScrollHeight : 0
      }
    )
    vi.mocked(listFiles).mockReset()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("loads only the first page initially", async () => {
    vi.mocked(listFiles).mockResolvedValue(page([entry("first.txt")], true))

    const { container } = renderCloudPane()

    expect(await screen.findByText("first.txt")).toBeTruthy()
    expect(container.firstElementChild?.classList.contains("h-svh")).toBe(true)
    expect(
      screen.getByTestId("cloud-scroll").classList.contains("overflow-y-scroll")
    ).toBe(true)
    expect(listFiles).toHaveBeenCalledTimes(1)
    expect(listFiles).toHaveBeenCalledWith({ path: "/", cursor: null })
  })

  it("keeps loading and displaying pages until the viewport can scroll", async () => {
    viewportScrollHeight = 500
    vi.mocked(listFiles)
      .mockResolvedValueOnce(page([entry("first.txt")], false, "cursor-2"))
      .mockResolvedValueOnce(page([entry("second.txt")], false, "cursor-3"))
      .mockResolvedValueOnce(page([entry("third.txt")], true))

    renderCloudPane()

    expect(await screen.findByText("third.txt")).toBeTruthy()
    expect(screen.getByText("first.txt")).toBeTruthy()
    expect(screen.getByText("second.txt")).toBeTruthy()
    expect(listFiles).toHaveBeenCalledTimes(3)
    expect(listFiles).toHaveBeenNthCalledWith(2, {
      path: "/",
      cursor: "cursor-2",
    })
    expect(listFiles).toHaveBeenNthCalledWith(3, {
      path: "/",
      cursor: "cursor-3",
    })
  })

  it("stops filling once rendered rows extend beyond the threshold", async () => {
    viewportScrollHeight = 500
    const nextPage = deferred<FileListPage>()
    vi.mocked(listFiles)
      .mockResolvedValueOnce(page([entry("first.txt")], false, "cursor-2"))
      .mockReturnValueOnce(nextPage.promise)

    renderCloudPane()
    await waitFor(() => expect(listFiles).toHaveBeenCalledTimes(2))

    viewportScrollHeight = 1_000
    nextPage.resolve(page([entry("second.txt")], false, "cursor-3"))

    expect(await screen.findByText("second.txt")).toBeTruthy()
    await waitFor(() => expect(listFiles).toHaveBeenCalledTimes(2))
  })

  it("loads the next cursor once when repeatedly scrolled near the bottom", async () => {
    const nextPage = deferred<FileListPage>()
    vi.mocked(listFiles)
      .mockResolvedValueOnce(page([entry("first.txt")], false, "cursor-2"))
      .mockReturnValueOnce(nextPage.promise)

    renderCloudPane()
    expect(await screen.findByText("first.txt")).toBeTruthy()

    const viewport = screen.getByTestId("cloud-scroll")
    viewport.scrollTop = 500
    fireEvent.scroll(viewport)
    fireEvent.scroll(viewport)

    await waitFor(() => expect(listFiles).toHaveBeenCalledTimes(2))
    expect(listFiles).toHaveBeenLastCalledWith({
      path: "/",
      cursor: "cursor-2",
    })

    nextPage.resolve(page([entry("second.txt")], true))
    expect(await screen.findByText("second.txt")).toBeTruthy()
    fireEvent.scroll(viewport)
    expect(listFiles).toHaveBeenCalledTimes(2)
  })

  it("starts from the first page when entering another directory", async () => {
    vi.mocked(listFiles)
      .mockResolvedValueOnce(
        page(
          [
            entry("reports", {
              kind: "directory",
              fileId: undefined,
              path: "/reports",
            }),
          ],
          true
        )
      )
      .mockResolvedValueOnce(page([entry("report.pdf")], true))

    renderCloudPane()
    fireEvent.click(await screen.findByText("reports"))

    expect(await screen.findByText("report.pdf")).toBeTruthy()
    expect(listFiles).toHaveBeenLastCalledWith({
      path: "/reports",
      cursor: null,
    })
  })

  it("keeps loaded rows and retries the failed next cursor on demand", async () => {
    vi.mocked(listFiles)
      .mockResolvedValueOnce(page([entry("first.txt")], false, "cursor-2"))
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(page([entry("second.txt")], true))

    renderCloudPane()
    expect(await screen.findByText("first.txt")).toBeTruthy()
    const viewport = screen.getByTestId("cloud-scroll")
    viewport.scrollTop = 500
    fireEvent.scroll(viewport)

    const retry = await screen.findByRole("button", {
      name: "Try loading more again",
    })
    expect(screen.getByText("first.txt")).toBeTruthy()
    expect(listFiles).toHaveBeenCalledTimes(2)

    fireEvent.click(retry)

    expect(await screen.findByText("second.txt")).toBeTruthy()
    expect(listFiles).toHaveBeenCalledTimes(3)
    expect(listFiles).toHaveBeenLastCalledWith({
      path: "/",
      cursor: "cursor-2",
    })
  })
})
