import { ResultAsync } from "neverthrow"

import { joinPath } from "./api"

export type DroppedFile = { file: File; relativePath: string }

export type CollectedDrop = {
  files: Array<DroppedFile>
  /** Relative paths of dropped entries whose contents could not be read. */
  unreadable: Array<string>
}

export type UploadFailure<TError> = { relativePath: string; error: TError }

const junkFileNames = new Set([".DS_Store", "Thumbs.db", "desktop.ini"])

type EntryReadError = { code: "ENTRY_UNREADABLE" }

const entryReadError: EntryReadError = { code: "ENTRY_UNREADABLE" }

// Chromium returns at most 100 entries per readEntries call; drain until empty.
function readAllEntries(
  directory: FileSystemDirectoryEntry
): ResultAsync<Array<FileSystemEntry>, EntryReadError> {
  return ResultAsync.fromPromise(
    new Promise<Array<FileSystemEntry>>((resolve, reject) => {
      const reader = directory.createReader()
      const entries: Array<FileSystemEntry> = []
      const readBatch = () =>
        reader.readEntries((batch) => {
          if (batch.length === 0) return resolve(entries)
          entries.push(...batch)
          readBatch()
        }, reject)
      readBatch()
    }),
    () => entryReadError
  )
}

function readEntryFile(
  entry: FileSystemFileEntry
): ResultAsync<File, EntryReadError> {
  return ResultAsync.fromPromise(
    new Promise<File>((resolve, reject) => entry.file(resolve, reject)),
    () => entryReadError
  )
}

async function collectEntry(
  entry: FileSystemEntry,
  prefix: string,
  collected: CollectedDrop
): Promise<void> {
  if (entry.isFile) {
    const file = await readEntryFile(entry as FileSystemFileEntry)
    if (file.isErr()) {
      collected.unreadable.push(`${prefix}${entry.name}`)
    } else if (!junkFileNames.has(file.value.name)) {
      collected.files.push({
        file: file.value,
        relativePath: `${prefix}${file.value.name}`,
      })
    }
  } else if (entry.isDirectory) {
    const children = await readAllEntries(entry as FileSystemDirectoryEntry)
    if (children.isErr()) {
      collected.unreadable.push(`${prefix}${entry.name}/`)
      return
    }
    for (const child of children.value) {
      await collectEntry(child, `${prefix}${entry.name}/`, collected)
    }
  }
}

/**
 * Expand dropped items (files and folders) into a flat list of files with
 * their paths relative to the drop target. Collection never fails as a
 * whole: entries that cannot be read are skipped and reported in
 * `unreadable`, so one bad entry cannot abort a folder drop. Must be called
 * synchronously from the drop event handler: the DataTransfer items are only
 * readable during event dispatch, so entries and file fallbacks are captured
 * before the first await.
 */
export async function collectDroppedFiles(
  items: DataTransferItemList
): Promise<CollectedDrop> {
  const captured = Array.from(items)
    .filter((item) => item.kind === "file")
    .map((item) => ({
      entry:
        typeof item.webkitGetAsEntry === "function"
          ? item.webkitGetAsEntry()
          : null,
      file: item.getAsFile(),
    }))
  const collected: CollectedDrop = { files: [], unreadable: [] }
  for (const { entry, file } of captured) {
    if (entry) {
      await collectEntry(entry, "", collected)
    } else if (file && !junkFileNames.has(file.name)) {
      collected.files.push({ file, relativePath: file.name })
    }
  }
  return collected
}

/**
 * Upload files into `directory` with bounded concurrency. Per-file failures
 * are collected instead of aborting the batch.
 */
export async function uploadBatch<TError>(input: {
  files: Array<DroppedFile>
  directory: string
  upload: (path: string, file: File) => ResultAsync<void, TError>
  onProgress?: (completed: number, total: number) => void
  concurrency?: number
}): Promise<{ failures: Array<UploadFailure<TError>> }> {
  const { files, directory, upload, onProgress, concurrency = 3 } = input
  const failures: Array<UploadFailure<TError>> = []
  let nextIndex = 0
  let completed = 0
  const workers = Array.from(
    { length: Math.min(concurrency, files.length) },
    async () => {
      while (nextIndex < files.length) {
        const { file, relativePath } = files[nextIndex]
        nextIndex += 1
        const result = await upload(joinPath(directory, relativePath), file)
        if (result.isErr()) failures.push({ relativePath, error: result.error })
        completed += 1
        onProgress?.(completed, files.length)
      }
    }
  )
  await Promise.all(workers)
  return { failures }
}
