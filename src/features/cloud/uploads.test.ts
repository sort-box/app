import { describe, expect, it } from "vitest"

import { collectDroppedFiles, uploadBatch } from "./uploads"

function fakeFile(name: string): File {
  return new File(["content"], name)
}

function fileEntry(file: File): FileSystemEntry {
  return {
    isFile: true,
    isDirectory: false,
    name: file.name,
    file: (onSuccess: (file: File) => void) => onSuccess(file),
  } as unknown as FileSystemEntry
}

function directoryEntry(
  name: string,
  children: Array<FileSystemEntry>
): FileSystemEntry {
  // Serves children two at a time to exercise the readEntries drain loop.
  let index = 0
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => ({
      readEntries: (onSuccess: (entries: Array<FileSystemEntry>) => void) => {
        const batch = children.slice(index, index + 2)
        index += batch.length
        onSuccess(batch)
      },
    }),
  } as unknown as FileSystemEntry
}

function itemList(
  items: Array<Partial<DataTransferItem>>
): DataTransferItemList {
  return items as unknown as DataTransferItemList
}

function fileItem(
  entry: FileSystemEntry | null,
  file: File | null = null
): Partial<DataTransferItem> {
  return {
    kind: "file",
    webkitGetAsEntry: () => entry,
    getAsFile: () => file,
  }
}

describe("collectDroppedFiles", () => {
  it("flattens dropped folders into relative paths", async () => {
    const dropped = await collectDroppedFiles(
      itemList([
        fileItem(
          directoryEntry("photos", [
            fileEntry(fakeFile("a.png")),
            directoryEntry("raw", [fileEntry(fakeFile("b.dng"))]),
            fileEntry(fakeFile("c.png")),
          ])
        ),
        fileItem(fileEntry(fakeFile("notes.txt"))),
      ])
    )
    expect(dropped.map((file) => file.relativePath)).toEqual([
      "photos/a.png",
      "photos/raw/b.dng",
      "photos/c.png",
      "notes.txt",
    ])
  })

  it("skips junk files and non-file items", async () => {
    const dropped = await collectDroppedFiles(
      itemList([
        fileItem(
          directoryEntry("folder", [
            fileEntry(fakeFile(".DS_Store")),
            fileEntry(fakeFile("keep.txt")),
          ])
        ),
        { kind: "string" },
      ])
    )
    expect(dropped.map((file) => file.relativePath)).toEqual([
      "folder/keep.txt",
    ])
  })

  it("falls back to plain files when entries are unavailable", async () => {
    const dropped = await collectDroppedFiles(
      itemList([
        { kind: "file", getAsFile: () => fakeFile("plain.txt") },
        fileItem(null, fakeFile("also-plain.md")),
      ])
    )
    expect(dropped.map((file) => file.relativePath)).toEqual([
      "plain.txt",
      "also-plain.md",
    ])
  })
})

describe("uploadBatch", () => {
  const files = (...names: Array<string>) =>
    names.map((name) => ({ file: fakeFile(name), relativePath: name }))

  it("uploads every file into the target directory and reports progress", async () => {
    const uploaded: Array<string> = []
    const progress: Array<number> = []
    const { failures } = await uploadBatch({
      files: files("a.txt", "nested/b.txt"),
      directory: "/docs",
      upload: async (path) => {
        uploaded.push(path)
      },
      onProgress: (completed) => progress.push(completed),
    })
    expect(uploaded.sort()).toEqual(["/docs/a.txt", "/docs/nested/b.txt"])
    expect(progress).toEqual([1, 2])
    expect(failures).toEqual([])
  })

  it("collects per-file failures without aborting the batch", async () => {
    const uploaded: Array<string> = []
    const { failures } = await uploadBatch({
      files: files("ok.txt", "bad.txt", "ok2.txt"),
      directory: "/",
      upload: async (path) => {
        if (path.includes("bad")) throw new Error("boom")
        uploaded.push(path)
      },
    })
    expect(uploaded.sort()).toEqual(["/ok.txt", "/ok2.txt"])
    expect(failures).toHaveLength(1)
    expect(failures[0].relativePath).toBe("bad.txt")
  })

  it("never runs more uploads than the concurrency limit", async () => {
    let active = 0
    let peak = 0
    await uploadBatch({
      files: files("1", "2", "3", "4", "5"),
      directory: "/",
      concurrency: 2,
      upload: async () => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 0))
        active -= 1
      },
    })
    expect(peak).toBeLessThanOrEqual(2)
  })
})
