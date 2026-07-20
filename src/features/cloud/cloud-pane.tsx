import { useCallback, useEffect, useRef, useState } from "react"
import type { ReactNode } from "react"
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
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
  FilesIcon,
  FolderIcon,
  FolderInputIcon,
  FolderPlusIcon,
  HomeIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"

import {
  FileApiError,
  createDownload,
  createFolder,
  deleteFile,
  deleteFolder,
  joinPath,
  listFiles,
  moveFile,
  moveFolder,
  uploadFile,
  type FileEntry,
} from "./api"
import { FileTypeIcon, FolderTypeIcon } from "./file-icon"
import { collectDroppedFiles, uploadBatch, type DroppedFile } from "./uploads"
import { cn } from "@/lib/utils"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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

export function isValidDropTarget(
  active: FileEntry,
  targetPath: string
): boolean {
  if (targetPath === active.parentPath) return false
  if (active.kind === "directory") {
    return (
      targetPath !== active.path && !targetPath.startsWith(`${active.path}/`)
    )
  }
  return true
}

function canDropAll(entries: Array<FileEntry>, targetPath: string): boolean {
  return (
    entries.length > 0 &&
    entries.every((entry) => isValidDropTarget(entry, targetPath))
  )
}

type BulkFailure = { entry: FileEntry; error: unknown }

/** Runs one operation per entry and reports per-entry failures instead of rejecting. */
function settleAll(
  targets: Array<FileEntry>,
  run: (entry: FileEntry) => Promise<unknown>
): Promise<Array<BulkFailure>> {
  return Promise.all(
    targets.map((entry) =>
      run(entry).then(
        () => null,
        (error: unknown) => ({ entry, error })
      )
    )
  ).then((results) =>
    results.filter((result): result is BulkFailure => result !== null)
  )
}

export function CloudPane() {
  const [path, setPath] = useState("/")
  const [renameTarget, setRenameTarget] = useState<FileEntry | null>(null)
  const [moveTarget, setMoveTarget] = useState<FileEntry | null>(null)
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [activeEntries, setActiveEntries] = useState<Array<FileEntry>>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(
    () => new Set()
  )
  const [hiddenEntryIds, setHiddenEntryIds] = useState<Set<string>>(
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
  ).filter(
    (entry) =>
      !pendingDeleteIds.has(entry._id) && !hiddenEntryIds.has(entry._id)
  )
  const selectedEntries = entries.filter((entry) => selectedIds.has(entry._id))
  const allSelected =
    entries.length > 0 && selectedEntries.length === entries.length
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
    setSelectedIds(new Set())
    if (scrollContainer.current) scrollContainer.current.scrollTop = 0
  }, [path])

  const renameMutation = useMutation({
    mutationFn: ({ entry, name }: { entry: FileEntry; name: string }) =>
      entry.kind === "directory"
        ? moveFolder(entry.path, joinPath(entry.parentPath, name))
        : moveFile(entry.fileId!, joinPath(entry.parentPath, name)),
    onSuccess: (_, { entry }) => {
      invalidate()
      setRenameTarget(null)
      toast.success(
        entry.kind === "directory" ? "Folder renamed." : "File renamed."
      )
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  const unhideEntries = (targets: Array<FileEntry>) =>
    setHiddenEntryIds((prev) => {
      const next = new Set(prev)
      for (const target of targets) next.delete(target._id)
      return next
    })

  const deselectEntries = (targets: Array<FileEntry>) =>
    setSelectedIds((prev) => {
      const next = new Set(prev)
      for (const target of targets) next.delete(target._id)
      return next
    })

  const moveMutation = useMutation({
    mutationFn: ({
      entries: targets,
      destination,
    }: {
      entries: Array<FileEntry>
      destination: string
    }) =>
      settleAll(targets, (entry) =>
        entry.kind === "directory"
          ? moveFolder(entry.path, joinPath(destination, entry.basename))
          : moveFile(entry.fileId!, joinPath(destination, entry.basename))
      ),
    onSuccess: async (failures, { entries: targets }) => {
      await invalidate()
      unhideEntries(targets)
      deselectEntries(targets)
      if (failures.length === 0) {
        setMoveTarget(null)
        toast.success(
          targets.length > 1
            ? `${targets.length} items moved.`
            : targets[0].kind === "directory"
              ? "Folder moved."
              : "File moved."
        )
      } else if (targets.length === 1) {
        toast.error(errorMessage(failures[0].error))
      } else {
        toast.error(
          `${failures.length} of ${targets.length} items could not be moved.`
        )
      }
    },
  })

  const createFolderMutation = useMutation({
    mutationFn: (name: string) => createFolder(joinPath(path, name)),
    onSuccess: () => {
      invalidate()
      setNewFolderOpen(false)
      toast.success("Folder created.")
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  const deleteFolderMutation = useMutation({
    mutationFn: (entry: FileEntry) => deleteFolder(entry.path),
    onSuccess: () => {
      invalidate()
      toast.success("Folder deleted.")
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 5 },
    })
  )

  const handleDragStart = (event: DragStartEvent) => {
    const entry = event.active.data.current?.entry as FileEntry | undefined
    if (!entry) return
    setActiveEntries(selectedIds.has(entry._id) ? selectedEntries : [entry])
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const targets = activeEntries
    const targetPath = event.over?.data.current?.path as string | undefined
    setActiveEntries([])
    if (targetPath === undefined) return
    if (!canDropAll(targets, targetPath)) return
    setHiddenEntryIds((prev) => {
      const next = new Set(prev)
      for (const target of targets) next.add(target._id)
      return next
    })
    moveMutation.mutate({ entries: targets, destination: targetPath })
  }

  const restoreEntries = (targets: Array<FileEntry>) =>
    setPendingDeleteIds((prev) => {
      const next = new Set(prev)
      for (const target of targets) next.delete(target._id)
      return next
    })

  const deleteMutation = useMutation({
    mutationFn: (targets: Array<FileEntry>) =>
      settleAll(targets, (entry) =>
        entry.kind === "directory"
          ? deleteFolder(entry.path)
          : deleteFile(entry.fileId!)
      ),
    onSuccess: async (failures, targets) => {
      await invalidate()
      restoreEntries(targets)
      if (failures.length === 1) {
        toast.error(errorMessage(failures[0].error))
      } else if (failures.length > 1) {
        toast.error(
          `${failures.length} of ${targets.length} items could not be deleted.`
        )
      }
    },
  })

  const scheduleDelete = (targets: Array<FileEntry>) => {
    if (targets.length === 0) return
    setPendingDeleteIds((prev) => {
      const next = new Set(prev)
      for (const target of targets) next.add(target._id)
      return next
    })
    const timeout = window.setTimeout(
      () => deleteMutation.mutate(targets),
      5000
    )
    toast(
      targets.length === 1
        ? `Deleting “${targets[0].basename}”…`
        : `Deleting ${targets.length} items…`,
      {
        duration: 5000,
        action: {
          label: "Cancel",
          onClick: () => {
            window.clearTimeout(timeout)
            restoreEntries(targets)
          },
        },
      }
    )
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

  const toggleSelected = (entry: FileEntry, checked: boolean) =>
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(entry._id)
      else next.delete(entry._id)
      return next
    })

  const toggleSelectAll = () =>
    setSelectedIds(
      allSelected ? new Set() : new Set(entries.map((entry) => entry._id))
    )

  const downloadSelected = async () => {
    for (const entry of selectedEntries) {
      if (entry.fileId) await download(entry)
    }
  }

  const deleteSelected = () => {
    scheduleDelete(selectedEntries)
    setSelectedIds(new Set())
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
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveEntries([])}
      >
        <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbDropTarget path="/" activeEntries={activeEntries}>
                  <BreadcrumbLink
                    render={<button type="button" />}
                    aria-label="All files"
                    onClick={() => setPath("/")}
                  >
                    <HomeIcon strokeWidth={1.5} className="size-4" />
                  </BreadcrumbLink>
                </BreadcrumbDropTarget>
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
                      <BreadcrumbDropTarget
                        path={segmentPath}
                        activeEntries={activeEntries}
                      >
                        <BreadcrumbLink
                          render={<button type="button" />}
                          onClick={() => setPath(segmentPath)}
                        >
                          {segment}
                        </BreadcrumbLink>
                      </BreadcrumbDropTarget>
                    )}
                  </BreadcrumbItem>
                )
              })}
            </BreadcrumbList>
          </Breadcrumb>
          {selectedEntries.length > 0 ? (
            <div className="flex items-center gap-1">
              <span className="pr-1 text-sm font-medium text-muted-foreground">
                {selectedEntries.length} selected
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={selectedEntries.some(
                  (entry) => entry.kind === "directory"
                )}
                onClick={() => void downloadSelected()}
              >
                <DownloadIcon />
                Download
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={deleteSelected}
              >
                <Trash2Icon />
                Delete
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Clear selection"
                onClick={() => setSelectedIds(new Set())}
              >
                <XIcon />
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setNewFolderOpen(true)}
            >
              <FolderPlusIcon />
              New folder
            </Button>
          )}
        </header>

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
                  <TableRow className="group/header hover:bg-transparent">
                    <TableHead className="w-10 pl-4">
                      <Checkbox
                        aria-label="Select all"
                        checked={allSelected}
                        onCheckedChange={toggleSelectAll}
                        className={cn(
                          "opacity-0 transition-opacity group-hover/header:opacity-100 focus-visible:opacity-100",
                          selectedEntries.length > 0 && "opacity-100"
                        )}
                      />
                    </TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead className="w-48">Added</TableHead>
                    <TableHead className="w-12" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {directory.isPending ? (
                    <FileRowsSkeleton />
                  ) : (
                    entries.map((entry) => (
                      <EntryRow
                        key={entry._id}
                        entry={entry}
                        activeEntries={activeEntries}
                        selected={selectedIds.has(entry._id)}
                        selectionActive={selectedEntries.length > 0}
                        onToggleSelect={toggleSelected}
                        onNavigate={setPath}
                        onDownload={download}
                        onRename={setRenameTarget}
                        onMove={setMoveTarget}
                        onDelete={(target) => scheduleDelete([target])}
                        onDeleteFolder={(target) =>
                          deleteFolderMutation.mutate(target)
                        }
                      />
                    ))
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

        <DragOverlay>
          {activeEntries.length > 1 ? (
            <div className="flex w-fit items-center gap-2 rounded-lg border bg-background px-3 py-1.5 text-sm font-medium shadow-md">
              <FilesIcon className="size-4" />
              {activeEntries.length} items
            </div>
          ) : activeEntries.length === 1 ? (
            <div className="flex w-fit items-center gap-2 rounded-lg border bg-background px-3 py-1.5 text-sm font-medium shadow-md">
              {activeEntries[0].kind === "directory" ? (
                <FolderTypeIcon className="size-4" />
              ) : (
                <FileTypeIcon
                  basename={activeEntries[0].basename}
                  className="size-4"
                />
              )}
              {activeEntries[0].basename}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

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
            moveMutation.mutate({ entries: [moveTarget], destination })
          }
          onClose={() => setMoveTarget(null)}
        />
      )}
      {newFolderOpen && (
        <NewFolderDialog
          pending={createFolderMutation.isPending}
          onSubmit={(name) => createFolderMutation.mutate(name)}
          onClose={() => setNewFolderOpen(false)}
        />
      )}
    </div>
  )
}

function BreadcrumbDropTarget({
  path,
  activeEntries,
  children,
}: {
  path: string
  activeEntries: Array<FileEntry>
  children: ReactNode
}) {
  const { isOver, setNodeRef } = useDroppable({
    id: `drop:${path}`,
    data: { path },
    disabled: !canDropAll(activeEntries, path),
  })
  return (
    <span
      ref={setNodeRef}
      className={cn("rounded-md", isOver && "bg-muted ring-1 ring-primary")}
    >
      {children}
    </span>
  )
}

function EntryRow({
  entry,
  activeEntries,
  selected,
  selectionActive,
  onToggleSelect,
  onNavigate,
  onDownload,
  onRename,
  onMove,
  onDelete,
  onDeleteFolder,
}: {
  entry: FileEntry
  activeEntries: Array<FileEntry>
  selected: boolean
  selectionActive: boolean
  onToggleSelect: (entry: FileEntry, checked: boolean) => void
  onNavigate: (path: string) => void
  onDownload: (entry: FileEntry) => void
  onRename: (entry: FileEntry) => void
  onMove: (entry: FileEntry) => void
  onDelete: (entry: FileEntry) => void
  onDeleteFolder: (entry: FileEntry) => void
}) {
  const drag = useDraggable({ id: entry._id, data: { entry } })
  const drop = useDroppable({
    id: `drop:${entry.path}`,
    data: { path: entry.path },
    disabled:
      entry.kind !== "directory" || !canDropAll(activeEntries, entry.path),
  })
  const dragged =
    drag.isDragging || activeEntries.some((active) => active._id === entry._id)

  const selectCell = (
    <TableCell
      className="w-10 pl-4"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
    >
      <Checkbox
        aria-label={`Select ${entry.basename}`}
        checked={selected}
        onCheckedChange={(checked) => onToggleSelect(entry, checked)}
        className={cn(
          "opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100",
          (selected || selectionActive) && "opacity-100"
        )}
      />
    </TableCell>
  )

  if (entry.kind === "directory") {
    return (
      <TableRow
        ref={(node) => {
          drag.setNodeRef(node)
          drop.setNodeRef(node)
        }}
        className={cn(
          "group/row cursor-pointer",
          selected && "bg-accent hover:bg-accent",
          dragged && "opacity-50",
          drop.isOver && "bg-muted"
        )}
        onClick={() => onNavigate(entry.path)}
        {...drag.listeners}
      >
        {selectCell}
        <TableCell>
          <span className="flex items-center gap-2 font-medium">
            <FolderTypeIcon className="size-4" />
            {entry.basename}
          </span>
        </TableCell>
        <TableCell className="text-muted-foreground">—</TableCell>
        <TableCell
          className="pr-2 text-right"
          onClick={(event) => event.stopPropagation()}
        >
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
              <DropdownMenuItem onClick={() => onRename(entry)}>
                <PencilIcon />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onMove(entry)}>
                <FolderInputIcon />
                Move to…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => onDeleteFolder(entry)}
              >
                <Trash2Icon />
                Delete folder
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </TableCell>
      </TableRow>
    )
  }

  return (
    <TableRow
      ref={drag.setNodeRef}
      className={cn(
        "group/row",
        selected && "bg-accent hover:bg-accent",
        dragged && "opacity-50"
      )}
      {...drag.listeners}
    >
      {selectCell}
      <TableCell>
        <span className="flex items-center gap-2">
          <FileTypeIcon basename={entry.basename} className="size-4" />
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
              <DropdownMenuItem onClick={() => onDownload(entry)}>
                <DownloadIcon />
                Download
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onRename(entry)}>
                <PencilIcon />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onMove(entry)}>
                <FolderInputIcon />
                Move to…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => onDelete(entry)}
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
}

const skeletonWidths = ["w-44", "w-28", "w-56", "w-36", "w-48"]

function FileRowsSkeleton() {
  return (
    <>
      {skeletonWidths.map((width, index) => (
        <TableRow key={index} className="hover:bg-transparent">
          <TableCell className="w-10 pl-4" />
          <TableCell>
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
  const entryType = entry.kind === "directory" ? "folder" : "file"

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
            <DialogTitle>Rename {entryType}</DialogTitle>
            <DialogDescription>
              Choose a new name for “{entry.basename}”.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label={
              entry.kind === "directory" ? "Folder name" : "File name"
            }
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

function NewFolderDialog({
  pending,
  onSubmit,
  onClose,
}: {
  pending: boolean
  onSubmit: (name: string) => void
  onClose: () => void
}) {
  const [name, setName] = useState("")
  const trimmed = name.trim()
  const valid = trimmed.length > 0 && !trimmed.includes("/")

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
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>
              Create a folder in the current directory.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label="Folder name"
            className="my-4"
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || pending}>
              {pending && <Loader2Icon className="animate-spin" />}
              Create
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
            disabled={pending || !isValidDropTarget(entry, destination)}
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
