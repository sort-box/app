import { useRef, useState } from "react"
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query"
import {
  CornerLeftUpIcon,
  DownloadIcon,
  EllipsisIcon,
  FileIcon,
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
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
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null)

  const queryClient = useQueryClient()
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["cloud", "files"] })

  const directory = useDirectory(path)
  const entries = sortEntries(
    directory.data?.pages.flatMap((page) => page.page) ?? []
  )
  const segments = path === "/" ? [] : path.slice(1).split("/")

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

  const deleteMutation = useMutation({
    mutationFn: (entry: FileEntry) => deleteFile(entry.fileId!),
    onSuccess: () => {
      invalidate()
      setDeleteTarget(null)
      toast.success("File deleted.")
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  const fileInput = useRef<HTMLInputElement>(null)
  const uploadMutation = useMutation({
    mutationFn: (file: File) => uploadFile(joinPath(path, file.name), file),
    onSuccess: () => {
      invalidate()
      toast.success("File uploaded.")
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

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
    <div className="flex h-full flex-col">
      <input
        ref={fileInput}
        type="file"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) uploadMutation.mutate(file)
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

      <div className="flex-1 overflow-y-auto">
        {directory.isError ? (
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
                  Upload a file and it will show up right here.
                </p>
              </div>
              <Button
                disabled={uploadMutation.isPending}
                onClick={() => fileInput.current?.click()}
              >
                {uploadMutation.isPending ? (
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
                            <FolderIcon
                              strokeWidth={1.5}
                              className="size-4 text-muted-foreground"
                            />
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
                            <FileIcon
                              strokeWidth={1.5}
                              className="size-4 text-muted-foreground"
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
                                  onClick={() => setDeleteTarget(entry)}
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
            {directory.hasNextPage && (
              <div className="flex justify-center py-3">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={directory.isFetchingNextPage}
                  onClick={() => directory.fetchNextPage()}
                >
                  {directory.isFetchingNextPage && (
                    <Loader2Icon className="animate-spin" />
                  )}
                  Load more
                </Button>
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
      {deleteTarget && (
        <AlertDialog
          open
          onOpenChange={(open) => !open && setDeleteTarget(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Delete “{deleteTarget.basename}”?
              </AlertDialogTitle>
              <AlertDialogDescription>
                This file will be permanently deleted. This action cannot be
                undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={deleteMutation.isPending}
                onClick={() => deleteMutation.mutate(deleteTarget)}
              >
                {deleteMutation.isPending && (
                  <Loader2Icon className="animate-spin" />
                )}
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
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
