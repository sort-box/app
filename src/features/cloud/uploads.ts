import { joinPath } from "./api"

export type DroppedFile = { file: File; relativePath: string }

export type UploadFailure = { relativePath: string; error: unknown }

const junkFileNames = new Set([".DS_Store", "Thumbs.db", "desktop.ini"])

// Chromium returns at most 100 entries per readEntries call; drain until empty.
function readAllEntries(
  directory: FileSystemDirectoryEntry
): Promise<Array<FileSystemEntry>> {
  const reader = directory.createReader()
  return new Promise((resolve, reject) => {
    const entries: Array<FileSystemEntry> = []
    const readBatch = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) return resolve(entries)
        entries.push(...batch)
        readBatch()
      }, reject)
    readBatch()
  })
}

function readEntryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}

async function collectEntry(
  entry: FileSystemEntry,
  prefix: string,
  collected: Array<DroppedFile>
): Promise<void> {
  if (entry.isFile) {
    const file = await readEntryFile(entry as FileSystemFileEntry)
    if (junkFileNames.has(file.name)) return
    collected.push({ file, relativePath: `${prefix}${file.name}` })
  } else if (entry.isDirectory) {
    const children = await readAllEntries(entry as FileSystemDirectoryEntry)
    for (const child of children) {
      await collectEntry(child, `${prefix}${entry.name}/`, collected)
    }
  }
}

/**
 * Expand dropped items (files and folders) into a flat list of files with
 * their paths relative to the drop target. Must be called synchronously from
 * the drop event handler: the DataTransfer items are only readable during
 * event dispatch, so entries and file fallbacks are captured before the
 * first await.
 */
export async function collectDroppedFiles(
  items: DataTransferItemList
): Promise<Array<DroppedFile>> {
  const captured = Array.from(items)
    .filter((item) => item.kind === "file")
    .map((item) => ({
      entry:
        typeof item.webkitGetAsEntry === "function"
          ? item.webkitGetAsEntry()
          : null,
      file: item.getAsFile(),
    }))
  const collected: Array<DroppedFile> = []
  for (const { entry, file } of captured) {
    if (entry) {
      await collectEntry(entry, "", collected)
    } else if (file && !junkFileNames.has(file.name)) {
      collected.push({ file, relativePath: file.name })
    }
  }
  return collected
}

/**
 * Upload files into `directory` with bounded concurrency. Per-file failures
 * are collected instead of aborting the batch.
 */
export async function uploadBatch(input: {
  files: Array<DroppedFile>
  directory: string
  upload: (path: string, file: File) => Promise<void>
  onProgress?: (completed: number, total: number) => void
  concurrency?: number
}): Promise<{ failures: Array<UploadFailure> }> {
  const { files, directory, upload, onProgress, concurrency = 3 } = input
  const failures: Array<UploadFailure> = []
  let nextIndex = 0
  let completed = 0
  const workers = Array.from(
    { length: Math.min(concurrency, files.length) },
    async () => {
      while (nextIndex < files.length) {
        const { file, relativePath } = files[nextIndex]
        nextIndex += 1
        try {
          await upload(joinPath(directory, relativePath), file)
        } catch (error) {
          failures.push({ relativePath, error })
        }
        completed += 1
        onProgress?.(completed, files.length)
      }
    }
  )
  await Promise.all(workers)
  return { failures }
}
