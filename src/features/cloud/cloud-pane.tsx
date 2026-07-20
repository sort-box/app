import { useCallback, useEffect, useRef, useState } from "react"
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query"
import {
  CloudUploadIcon,
  CornerLeftUpIcon,
  DownloadIcon,
  EllipsisIcon,
  FolderIcon,
  FolderInputIcon,
  HomeIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react"
import { toast } from "sonner"

import {
  FileApiError,
  createDownload,
  deleteFile,
  joinPath,
  listFiles,
  moveFile,
  uploadFile,
  type FileEntry,
} from "./api"
import { FileTypeIcon, FolderTypeIcon } from "./file-icon"
import { collectDroppedFiles, uploadBatch, type DroppedFile } from "./uploads"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})

function errorMessage(error: unknown): string {
  return error instanceof FileApiError ? error.message : "Something went wrong."
}

function sortEntries(entries: Array<FileEntry>): Array<FileEntry> {
  return [...entries].sort((a, b) =>
    a.kind === b.kind
      ? a.basename.localeCompare(b.basename)
      : a.kind === "directory"
        ? -1
        : 1
  )
}

function useDirectory(path: string) {
  return useInfiniteQuery({
    queryKey: ["cloud", "files", path],
    queryFn: ({ pageParam }) => listFiles({ path, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.isDone ? undefined : last.continueCursor),
  })
}

export function CloudPane() {
  const [path, setPath] = useState("/")
  const [renameTarget, setRenameTarget] = useState<FileEntry | null>(null)
  const [moveTarget, setMoveTarget] = useState<FileEntry | null>(null)
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(
    () => new Set()
  )

  const queryClient = useQueryClient()
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["cloud", "files"] })

  const directory = useDirectory(path)
  const scrollContainer = useRef<HTMLDivElement>(null)
  const nextPageRequestPending = useRef(false)
  const entries = sortEntries(
    directory.data?.pages.flatMap((page) => page.page) ?? []
  ).filter((entry) => !pendingDeleteIds.has(entry._id))
  const segments = path === "/" ? [] : path.slice(1).split("/")
  const retryNextPage = () => {
    void directory.fetchNextPage()
  }

  const loadNextPageIfNeeded = useCallback(() => {
    const viewport = scrollContainer.current
    if (
      !viewport ||
      viewport.clientHeight === 0 ||
      !directory.hasNextPage ||
      directory.isFetchNextPageError ||
      directory.isFetchingNextPage ||
      nextPageRequestPending.current
    ) {
      return
    }
    const remaining =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    if (remaining > 200) return

    nextPageRequestPending.current = true
    void directory.fetchNextPage()
  }, [
    directory.fetchNextPage,
    directory.hasNextPage,
    directory.isFetchNextPageError,
    directory.isFetchingNextPage,
  ])

  useEffect(() => {
    if (!directory.isFetchingNextPage) {
      nextPageRequestPending.current = false
    }
    loadNextPageIfNeeded()
    window.addEventListener("resize", loadNextPageIfNeeded)
    return () => window.removeEventListener("resize", loadNextPageIfNeeded)
  }, [entries.length, directory.isFetchingNextPage, loadNextPageIfNeeded])

  useEffect(() => {
    nextPageRequestPending.current = false
    if (scrollContainer.current) scrollContainer.current.scrollTop = 0
  }, [path])

  const renameMutation = useMutation({
    mutationFn: ({ entry, name }: { entry: FileEntry; name: string }) =>
      moveFile(entry.fileId!, joinPath(entry.parentPath, name)),
    onSuccess: () => {
      invalidate()
      setRenameTarget(null)
      toast.success("File renamed.")
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  const moveMutation = useMutation({
    mutationFn: ({
      entry,
      destination,
    }: {
      entry: FileEntry
      destination: string
    }) => moveFile(entry.fileId!, joinPath(destination, entry.basename)),
    onSuccess: () => {
      invalidate()
      setMoveTarget(null)
      toast.success("File moved.")
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  const restoreEntry = (id: string) =>
    setPendingDeleteIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })

  const deleteMutation = useMutation({
    mutationFn: (entry: FileEntry) => deleteFile(entry.fileId!),
    onSuccess: async (_, entry) => {
      await invalidate()
      restoreEntry(entry._id)
    },
    onError: (error, entry) => {
      toast.error(errorMessage(error))
      restoreEntry(entry._id)
    },
  })

  const scheduleDelete = (entry: FileEntry) => {
    setPendingDeleteIds((prev) => new Set(prev).add(entry._id))
    const timeout = window.setTimeout(() => deleteMutation.mutate(entry), 5000)
    toast(`Deleting “${entry.basename}”…`, {
      duration: 5000,
      action: {
        label: "Cancel",
        onClick: () => {
          window.clearTimeout(timeout)
          restoreEntry(entry._id)
        },
      },
    })
  }

  const fileInput = useRef<HTMLInputElement>(null)
  const [activeUploadCount, setActiveUploadCount] = useState(0)
  const uploading = activeUploadCount > 0

  const runUpload = async (files: Array<DroppedFile>) => {
    if (files.length === 0) return
    const total = files.length
    const label = (completed: number) =>
      total === 1
        ? `Uploading “${files[0].relativePath}”…`
        : `Uploading ${total} files… (${completed}/${total})`
    const toastId = toast.loading(label(0))
    setActiveUploadCount((count) => count + 1)
    try {
      let completedSoFar = 0
      const { failures } = await uploadBatch({
        files,
        directory: path,
        upload: (filePath, file) =>
          uploadFile(filePath, file, {
            onRateLimit: (retryAfterSeconds) =>
              toast.loading(
                `${label(completedSoFar)} Waiting ~${retryAfterSeconds}s for the server.`,
                { id: toastId }
              ),
          }),
        onProgress: (completed) => {
          completedSoFar = completed
          toast.loading(label(completed), { id: toastId })
        },
      })
      invalidate()
      const succeeded = total - failures.length
      if (failures.length === 0) {
        toast.success(
          total === 1 ? "File uploaded." : `${total} files uploaded.`,
          { id: toastId }
        )
      } else if (succeeded === 0) {
        toast.error(errorMessage(failures[0].error), { id: toastId })
      } else {
        toast.warning(
          `${succeeded} of ${total} files uploaded, ${failures.length} failed.`,
          { id: toastId }
        )
      }
    } finally {
      setActiveUploadCount((count) => count - 1)
    }
  }

  const [dragActive, setDragActive] = useState(false)
  const dragDepth = useRef(0)
  const hasDraggedFiles = (dataTransfer: DataTransfer) =>
    dataTransfer.types.includes("Files")

  const download = async (entry: FileEntry) => {
    try {
      const { url } = await createDownload(entry.fileId!)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = entry.basename
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  return (
    <div
      className="relative flex h-svh max-h-svh min-h-0 flex-col overflow-hidden"
      onDragEnter={(event) => {
        if (!hasDraggedFiles(event.dataTransfer)) return
        event.preventDefault()
        dragDepth.current += 1
        setDragActive(true)
      }}
      onDragOver={(event) => {
        if (!hasDraggedFiles(event.dataTransfer)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = "copy"
      }}
      onDragLeave={(event) => {
        if (!hasDraggedFiles(event.dataTransfer)) return
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragActive(false)
      }}
      onDrop={(event) => {
        if (!hasDraggedFiles(event.dataTransfer)) return
        event.preventDefault()
        dragDepth.current = 0
        setDragActive(false)
        void collectDroppedFiles(event.dataTransfer.items).then(
          ({ files, unreadable }) => {
            if (unreadable.length > 0) {
              toast.error(
                unreadable.length === 1
                  ? `“${unreadable[0]}” could not be read.`
                  : `${unreadable.length} dropped items could not be read.`
              )
            }
            return runUpload(files)
          }
        )
      }}
    >
      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-10 bg-background/80 p-2">
          <div className="grid h-full place-items-center rounded-2xl border-2 border-dashed border-primary">
            <div className="flex flex-col items-center gap-2 text-sm font-medium">
              <CloudUploadIcon strokeWidth={1.5} className="size-8" />
              Drop files or folders to upload
            </div>
          </div>
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          void runUpload(
            files.map((file) => ({ file, relativePath: file.name }))
          )
          event.target.value = ""
        }}
      />
      {segments.length > 0 && (
        <header className="flex h-12 shrink-0 items-center border-b px-4">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink
                  render={<button type="button" />}
                  aria-label="All files"
                  onClick={() => setPath("/")}
                >
                  <HomeIcon strokeWidth={1.5} className="size-4" />
                </BreadcrumbLink>
              </BreadcrumbItem>
              {segments.map((segment, index) => {
                const segmentPath = `/${segments.slice(0, index + 1).join("/")}`
                const isLast = index === segments.length - 1
                return (
                  <BreadcrumbItem key={segmentPath}>
                    <BreadcrumbSeparator />
                    {isLast ? (
                      <BreadcrumbPage>{segment}</BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink
                        render={<button type="button" />}
                        onClick={() => setPath(segmentPath)}
                      >
                        {segment}
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                )
              })}
            </BreadcrumbList>
          </Breadcrumb>
        </header>
      )}

      <div
        ref={scrollContainer}
        data-testid="cloud-scroll"
        className="min-h-0 flex-1 overflow-y-scroll overscroll-contain"
        onScroll={loadNextPageIfNeeded}
      >
        {directory.isError && !directory.data ? (
          <div className="grid h-full place-items-center">
            <div className="space-y-3 text-center">
              <p className="text-sm text-muted-foreground">
                {errorMessage(directory.error)}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => directory.refetch()}
              >
                Try again
              </Button>
            </div>
          </div>
        ) : !directory.isPending && entries.length === 0 ? (
          <div className="grid h-full place-items-center">
            <div className="flex flex-col items-center gap-4 text-center">
              <FolderIcon
                strokeWidth={1.5}
                className="size-8 text-muted-foreground"
              />
              <div className="space-y-1">
                <p className="text-sm font-medium">Nothing here yet</p>
                <p className="text-sm text-muted-foreground">
                  Drop files or folders here, or upload one below.
                </p>
              </div>
              <Button
                disabled={uploading}
                onClick={() => fileInput.current?.click()}
              >
                {uploading ? (
                  <Loader2Icon className="animate-spin" />
                ) : (
                  <PlusIcon />
                )}
                Upload your first file
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4">Name</TableHead>
                  <TableHead className="w-48">Added</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {directory.isPending ? (
                  <FileRowsSkeleton />
                ) : (
                  entries.map((entry) =>
                    entry.kind === "directory" ? (
                      <TableRow
                        key={entry._id}
                        className="cursor-pointer"
                        onClick={() => setPath(entry.path)}
                      >
                        <TableCell className="pl-4">
                          <span className="flex items-center gap-2 font-medium">
                            <FolderTypeIcon className="size-4" />
                            {entry.basename}
                          </span>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          —
                        </TableCell>
                        <TableCell />
                      </TableRow>
                    ) : (
                      <TableRow key={entry._id}>
                        <TableCell className="pl-4">
                          <span className="flex items-center gap-2">
                            <FileTypeIcon
                              basename={entry.basename}
                              className="size-4"
                            />
                            {entry.basename}
                          </span>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {dateFormat.format(entry._creationTime)}
                        </TableCell>
                        <TableCell className="pr-2 text-right">
                          {entry.fileId && (
                            <DropdownMenu>
                              <DropdownMenuTrigger
                                render={
                                  <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={`Actions for ${entry.basename}`}
                                  />
                                }
                              >
                                <EllipsisIcon />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  onClick={() => download(entry)}
                                >
                                  <DownloadIcon />
                                  Download
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => setRenameTarget(entry)}
                                >
                                  <PencilIcon />
                                  Rename
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => setMoveTarget(entry)}
                                >
                                  <FolderInputIcon />
                                  Move to…
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  variant="destructive"
                                  onClick={() => scheduleDelete(entry)}
                                >
                                  <Trash2Icon />
                                  Delete
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  )
                )}
              </TableBody>
            </Table>
            {(directory.hasNextPage || directory.isFetchNextPageError) && (
              <div className="flex min-h-12 items-center justify-center py-3">
                {directory.isFetchNextPageError ? (
                  <Button variant="ghost" size="sm" onClick={retryNextPage}>
                    Try loading more again
                  </Button>
                ) : directory.isFetchingNextPage ? (
                  <span
                    role="status"
                    className="flex items-center gap-2 text-sm text-muted-foreground"
                  >
                    <Loader2Icon className="size-4 animate-spin" />
                    Loading more…
                  </span>
                ) : null}
              </div>
            )}
          </>
        )}
      </div>

      {renameTarget && (
        <RenameDialog
          key={renameTarget._id}
          entry={renameTarget}
          pending={renameMutation.isPending}
          onSubmit={(name) =>
            renameMutation.mutate({ entry: renameTarget, name })
          }
          onClose={() => setRenameTarget(null)}
        />
      )}
      {moveTarget && (
        <MoveDialog
          key={moveTarget._id}
          entry={moveTarget}
          pending={moveMutation.isPending}
          onMove={(destination) =>
            moveMutation.mutate({ entry: moveTarget, destination })
          }
          onClose={() => setMoveTarget(null)}
        />
      )}
    </div>
  )
}

const skeletonWidths = ["w-44", "w-28", "w-56", "w-36", "w-48"]

function FileRowsSkeleton() {
  return (
    <>
      {skeletonWidths.map((width, index) => (
        <TableRow key={index} className="hover:bg-transparent">
          <TableCell className="pl-4">
            <span className="flex items-center gap-2">
              <Skeleton className="size-4 rounded-md" />
              <Skeleton className={`h-4 ${width}`} />
            </span>
          </TableCell>
          <TableCell>
            <Skeleton className="h-4 w-28" />
          </TableCell>
          <TableCell />
        </TableRow>
      ))}
    </>
  )
}

function RenameDialog({
  entry,
  pending,
  onSubmit,
  onClose,
}: {
  entry: FileEntry
  pending: boolean
  onSubmit: (name: string) => void
  onClose: () => void
}) {
  const [name, setName] = useState(entry.basename)
  const trimmed = name.trim()
  const valid =
    trimmed.length > 0 && !trimmed.includes("/") && trimmed !== entry.basename

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (valid && !pending) onSubmit(trimmed)
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename file</DialogTitle>
            <DialogDescription>
              Choose a new name for “{entry.basename}”.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label="File name"
            className="my-4"
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || pending}>
              {pending && <Loader2Icon className="animate-spin" />}
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function MoveDialog({
  entry,
  pending,
  onMove,
  onClose,
}: {
  entry: FileEntry
  pending: boolean
  onMove: (destination: string) => void
  onClose: () => void
}) {
  const [destination, setDestination] = useState("/")
  const directory = useDirectory(destination)
  const folders = (
    directory.data?.pages.flatMap((page) => page.page) ?? []
  ).filter((candidate) => candidate.kind === "directory")
  const parent =
    destination === "/"
      ? null
      : destination.slice(0, destination.lastIndexOf("/")) || "/"

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move “{entry.basename}”</DialogTitle>
          <DialogDescription>Choose a destination folder.</DialogDescription>
        </DialogHeader>
        <div className="my-4 overflow-hidden rounded-2xl border">
          <div className="flex items-center gap-2 border-b bg-muted/40 px-2 py-1.5 text-sm">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Parent folder"
              disabled={parent === null}
              onClick={() => parent !== null && setDestination(parent)}
            >
              <CornerLeftUpIcon strokeWidth={1.5} />
            </Button>
            <span className="truncate font-medium">
              {destination === "/" ? "Cloud" : destination}
            </span>
          </div>
          <div className="max-h-56 overflow-y-auto p-1">
            {directory.isPending ? (
              <div className="space-y-1 p-1">
                {["w-32", "w-44", "w-24"].map((width, index) => (
                  <span
                    key={index}
                    className="flex h-8 items-center gap-2 px-2"
                  >
                    <Skeleton className="size-4 rounded-md" />
                    <Skeleton className={`h-4 ${width}`} />
                  </span>
                ))}
              </div>
            ) : folders.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                No folders here
              </p>
            ) : (
              folders.map((folder) => (
                <button
                  key={folder._id}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-sm hover:bg-muted"
                  onClick={() => setDestination(folder.path)}
                >
                  <FolderIcon
                    strokeWidth={1.5}
                    className="size-4 text-muted-foreground"
                  />
                  {folder.basename}
                </button>
              ))
            )}
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={pending || destination === entry.parentPath}
            onClick={() => onMove(destination)}
          >
            {pending && <Loader2Icon className="animate-spin" />}
            Move here
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
