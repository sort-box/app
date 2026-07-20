/**
 * Per-extension file icons served from `public/file-icons`. The SVGs come
 * from Material Icon Theme (MIT, see `public/file-icons/LICENSE.md`).
 */
export const iconByExtension: Record<string, string> = {
  // Documents
  pdf: "pdf",
  doc: "word",
  docx: "word",
  xls: "table",
  xlsx: "table",
  csv: "table",
  ppt: "powerpoint",
  pptx: "powerpoint",
  txt: "document",
  rtf: "document",
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",
  // Images
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  bmp: "image",
  ico: "image",
  heic: "image",
  tiff: "image",
  svg: "svg",
  // Media
  mp4: "video",
  mov: "video",
  avi: "video",
  mkv: "video",
  webm: "video",
  m4v: "video",
  mp3: "audio",
  wav: "audio",
  flac: "audio",
  ogg: "audio",
  m4a: "audio",
  aac: "audio",
  // Archives
  zip: "zip",
  rar: "zip",
  "7z": "zip",
  tar: "zip",
  gz: "zip",
  tgz: "zip",
  bz2: "zip",
  xz: "zip",
  // Code
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  jsx: "react",
  tsx: "react_ts",
  html: "html",
  htm: "html",
  css: "css",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  xml: "xml",
  toml: "toml",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "h",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "hpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
  vue: "vue",
  sh: "console",
  bash: "console",
  zsh: "console",
  fish: "console",
  sql: "database",
  db: "database",
  sqlite: "database",
  // Fonts
  ttf: "font",
  otf: "font",
  woff: "font",
  woff2: "font",
  eot: "font",
  // Config and misc
  ini: "settings",
  cfg: "settings",
  conf: "settings",
  env: "tune",
  lock: "lock",
  exe: "exe",
  msi: "exe",
  iso: "disc",
  dmg: "disc",
}

export function fileIconName(basename: string): string {
  const dot = basename.lastIndexOf(".")
  if (dot === -1) return "file"
  const extension = basename.slice(dot + 1).toLowerCase()
  return iconByExtension[extension] ?? "file"
}

export function FileTypeIcon({
  basename,
  className,
}: {
  basename: string
  className?: string
}) {
  return (
    <img
      src={`/file-icons/${fileIconName(basename)}.svg`}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={className}
    />
  )
}

export function FolderTypeIcon({ className }: { className?: string }) {
  return (
    <img
      src="/file-icons/folder.svg"
      alt=""
      aria-hidden="true"
      draggable={false}
      className={className}
    />
  )
}
