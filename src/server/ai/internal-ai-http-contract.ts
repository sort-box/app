import { z } from "zod"

export const internalAiUsageRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("check") }).strict(),
  z
    .object({
      operation: z.literal("record"),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    })
    .strict(),
])

export const internalAiFileRequestSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("search"),
      query: z.string().min(1).max(1_000),
      limit: z.number().int().min(1).max(30),
    })
    .strict(),
  z
    .object({
      operation: z.literal("findExact"),
      query: z.string().min(1).max(1_000),
      caseSensitive: z.boolean(),
      cursor: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("read"),
      fileId: z.string().min(1),
      cursor: z.string().nullable(),
      numItems: z.number().int().min(1).max(20),
    })
    .strict(),
])

export const internalAiLocationSchema = z.union([
  z.object({ kind: z.literal("page"), page: z.number() }),
  z.object({ kind: z.literal("slide"), slide: z.number() }),
  z.object({
    kind: z.literal("sheet"),
    sheet: z.string(),
    row_start: z.number(),
    row_end: z.number(),
  }),
  z.object({ kind: z.literal("text"), start: z.number(), end: z.number() }),
])

export const internalAiSearchResponseSchema = z.array(
  z.object({
    fileId: z.string(),
    path: z.string(),
    text: z.string(),
    headingPath: z.array(z.string()),
    location: internalAiLocationSchema,
  })
)

export const internalAiExactResponseSchema = z.object({
  matches: z.array(
    z.object({
      fileId: z.string(),
      path: z.string(),
      occurrenceCount: z.number().int().nonnegative(),
      locations: z.array(internalAiLocationSchema),
      omittedLocationCount: z.number().int().nonnegative(),
    })
  ),
  scannedReadyFiles: z.number().int().nonnegative(),
  scannedIndexedFiles: z.number().int().nonnegative(),
  unsearchableReadyFiles: z.number().int().nonnegative(),
  complete: z.boolean(),
  nextCursor: z.optional(z.string()),
  warnings: z
    .array(z.enum(["LOCATIONS_TRUNCATED", "CORPUS_CHANGED"]))
    .optional(),
})

export const internalAiReadResponseSchema = z.object({
  file: z.object({
    fileId: z.string(),
    path: z.string(),
    contentType: z.string(),
  }),
  chunks: z.array(
    z.object({
      text: z.string(),
      headingPath: z.array(z.string()),
      location: internalAiLocationSchema,
    })
  ),
  nextCursor: z.optional(z.string()),
})
