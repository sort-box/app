// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { CloudPane, isValidDropTarget } from "./cloud-pane"
import {
  createDownload,
  createFolder,
  deleteFile,
  deleteFolder,
  listFiles,
  moveFolder,
  type FileEntry,
  type FileListPage,
} from "./api"
import type * as ApiModule from "./api"

vi.mock("./api", async (importOriginal) => {
  const original = await importOriginal<typeof ApiModule>()
  return {
    ...original,
    createDownload: vi.fn(),
    createFolder: vi.fn(),
    deleteFile: vi.fn(),
    deleteFolder: vi.fn(),
    listFiles: vi.fn(),
    moveFile: vi.fn(),
    moveFolder: vi.fn(),
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

describe("CloudPane folders", () => {
  beforeEach(() => {
    vi.mocked(listFiles).mockReset()
    vi.mocked(createFolder).mockReset()
    vi.mocked(deleteFolder).mockReset()
    vi.mocked(moveFolder).mockReset()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("creates a folder in the current directory", async () => {
    vi.mocked(listFiles).mockResolvedValue(page([], true))
    vi.mocked(createFolder).mockResolvedValue(
      entry("reports", { kind: "directory", fileId: undefined })
    )

    renderCloudPane()
    fireEvent.click(await screen.findByRole("button", { name: "New folder" }))
    fireEvent.change(await screen.findByLabelText("Folder name"), {
      target: { value: "reports" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create" }))

    await waitFor(() => expect(createFolder).toHaveBeenCalledWith("/reports"))
    await waitFor(() => expect(listFiles).toHaveBeenCalledTimes(2))
  })

  it("deletes an empty folder from its menu without navigating", async () => {
    vi.mocked(listFiles).mockResolvedValue(
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
    vi.mocked(deleteFolder).mockResolvedValue(null)

    renderCloudPane()
    fireEvent.click(
      await screen.findByRole("button", { name: "Actions for reports" })
    )
    fireEvent.click(await screen.findByText("Delete folder"))

    await waitFor(() => expect(deleteFolder).toHaveBeenCalledWith("/reports"))
    expect(listFiles).not.toHaveBeenCalledWith({
      path: "/reports",
      cursor: null,
    })
  })

  it("renames a folder from its menu", async () => {
    const reports = entry("reports", {
      kind: "directory",
      fileId: undefined,
      path: "/reports",
    })
    vi.mocked(listFiles).mockResolvedValue(page([reports], true))
    vi.mocked(moveFolder).mockResolvedValue({
      ...reports,
      path: "/archive",
      basename: "archive",
    })

    renderCloudPane()
    fireEvent.click(
      await screen.findByRole("button", { name: "Actions for reports" })
    )
    fireEvent.click(await screen.findByText("Rename"))
    fireEvent.change(await screen.findByLabelText("Folder name"), {
      target: { value: "archive" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Rename" }))

    await waitFor(() =>
      expect(moveFolder).toHaveBeenCalledWith("/reports", "/archive")
    )
  })

  it("moves a folder from its menu", async () => {
    const reports = entry("reports", {
      kind: "directory",
      fileId: undefined,
      path: "/reports",
    })
    const archive = entry("archive", {
      kind: "directory",
      fileId: undefined,
      path: "/archive",
    })
    vi.mocked(listFiles).mockImplementation(async ({ path }) =>
      page(path === "/" ? [reports, archive] : [], true)
    )
    vi.mocked(moveFolder).mockResolvedValue({
      ...reports,
      path: "/archive/reports",
      parentPath: "/archive",
    })

    renderCloudPane()
    fireEvent.click(
      await screen.findByRole("button", { name: "Actions for reports" })
    )
    fireEvent.click(await screen.findByText("Move to…"))
    fireEvent.click(await screen.findByRole("button", { name: "archive" }))
    fireEvent.click(screen.getByRole("button", { name: "Move here" }))

    await waitFor(() =>
      expect(moveFolder).toHaveBeenCalledWith("/reports", "/archive/reports")
    )
  })
})

describe("CloudPane selection", () => {
  beforeEach(() => {
    vi.mocked(listFiles).mockReset()
    vi.mocked(createDownload).mockReset()
    vi.mocked(deleteFile).mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
    vi.restoreAllMocks()
  })

  it("shows bulk actions once rows are selected", async () => {
    vi.mocked(listFiles).mockResolvedValue(
      page([entry("a.txt"), entry("b.txt")], true)
    )

    renderCloudPane()
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select a.txt" })
    )

    expect(screen.getByText("1 selected")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "New folder" })).toBeNull()

    fireEvent.click(screen.getByRole("checkbox", { name: "Select b.txt" }))

    expect(screen.getByText("2 selected")).toBeTruthy()
  })

  it("selects every row from the header checkbox", async () => {
    vi.mocked(listFiles).mockResolvedValue(
      page([entry("a.txt"), entry("b.txt")], true)
    )

    renderCloudPane()
    await screen.findByText("a.txt")
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }))

    expect(screen.getByText("2 selected")).toBeTruthy()
  })

  it("downloads each selected file", async () => {
    vi.mocked(listFiles).mockResolvedValue(
      page([entry("a.txt"), entry("b.txt")], true)
    )
    vi.mocked(createDownload).mockResolvedValue({
      url: "https://storage.example/get",
    })
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})

    renderCloudPane()
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select a.txt" })
    )
    fireEvent.click(screen.getByRole("checkbox", { name: "Select b.txt" }))
    fireEvent.click(screen.getByRole("button", { name: "Download" }))

    await waitFor(() => expect(createDownload).toHaveBeenCalledTimes(2))
    expect(createDownload).toHaveBeenCalledWith("a.txt-file")
    expect(createDownload).toHaveBeenCalledWith("b.txt-file")
  })

  it("disables download when the selection includes a folder", async () => {
    vi.mocked(listFiles).mockResolvedValue(
      page(
        [
          entry("reports", {
            kind: "directory",
            fileId: undefined,
            path: "/reports",
          }),
          entry("a.txt"),
        ],
        true
      )
    )

    renderCloudPane()
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select reports" })
    )

    const download = screen.getByRole("button", { name: "Download" })
    expect((download as HTMLButtonElement).disabled).toBe(true)
    expect(listFiles).not.toHaveBeenCalledWith({
      path: "/reports",
      cursor: null,
    })
  })

  it("deletes the whole selection after the undo window", async () => {
    vi.mocked(listFiles).mockResolvedValue(
      page([entry("a.txt"), entry("b.txt")], true)
    )
    vi.mocked(deleteFile).mockResolvedValue(null)

    renderCloudPane()
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select a.txt" })
    )
    fireEvent.click(screen.getByRole("checkbox", { name: "Select b.txt" }))

    vi.useFakeTimers()
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))

    expect(screen.queryByText("a.txt")).toBeNull()
    expect(screen.queryByText("b.txt")).toBeNull()
    expect(deleteFile).not.toHaveBeenCalled()

    await act(() => vi.advanceTimersByTimeAsync(5000))
    vi.useRealTimers()

    await waitFor(() => expect(deleteFile).toHaveBeenCalledTimes(2))
    expect(deleteFile).toHaveBeenCalledWith("a.txt-file")
    expect(deleteFile).toHaveBeenCalledWith("b.txt-file")
  })
})

describe("isValidDropTarget", () => {
  const file = entry("a.txt", { parentPath: "/docs", path: "/docs/a.txt" })
  const folder = entry("docs", {
    kind: "directory",
    fileId: undefined,
    path: "/docs",
    parentPath: "/",
  })

  it("rejects the entry's current parent", () => {
    expect(isValidDropTarget(file, "/docs")).toBe(false)
    expect(isValidDropTarget(folder, "/")).toBe(false)
  })

  it("rejects dropping a folder into itself or its descendants", () => {
    expect(isValidDropTarget(folder, "/docs")).toBe(false)
    expect(isValidDropTarget(folder, "/docs/sub")).toBe(false)
  })

  it("allows other destinations", () => {
    expect(isValidDropTarget(file, "/")).toBe(true)
    expect(isValidDropTarget(file, "/archive")).toBe(true)
    expect(isValidDropTarget(folder, "/archive")).toBe(true)
    expect(isValidDropTarget(folder, "/docsy")).toBe(true)
  })
})
