import { ResultAsync, errAsync, okAsync } from "neverthrow"
import { ConvexHttpClient } from "convex/browser"

import { api } from "../../../../../convex/_generated/api"

import type {
  FileApiError,
  FileRestService,
  PublicEmbeddingState,
} from "../../../files/file-api.server"
import type {
  FileChunkPage,
  FileEntrySummary,
  FileToolGateway,
  FileToolGatewayError,
  ExactReferencePage,
  SearchCandidate,
} from "../../file-tool-executor"
import type { FileIndexStatus } from "../../file-tools"
import {
  internalAiExactResponseSchema,
  internalAiFileRequestSchema,
  internalAiReadResponseSchema,
  internalAiSearchResponseSchema,
} from "../../internal-ai-http-contract"
import type { z } from "zod"

type Fetch = typeof fetch

class GatewayRequestError {
  constructor(readonly error: FileToolGatewayError) {}
}

function gatewayError(
  code: FileToolGatewayError["code"],
  message?: string
): FileToolGatewayError {
  return {
    code,
    retryable: code === "RATE_LIMITED" || code === "UNAVAILABLE",
    ...(message ? { message } : {}),
  }
}

function mapRequestError(error: unknown): FileToolGatewayError {
  if (error instanceof GatewayRequestError) return error.error
  return gatewayError("UNAVAILABLE")
}

function mapStatus(status: number, code: unknown): FileToolGatewayError {
  if (status === 401) return gatewayError("NOT_AUTHENTICATED")
  if (status === 404) return gatewayError("FILE_NOT_FOUND")
  if (status === 409 && code === "CONTENT_NOT_INDEXED") {
    return gatewayError("CONTENT_NOT_INDEXED")
  }
  if (status === 400) return gatewayError("INVALID_INPUT")
  if (status === 429) return gatewayError("RATE_LIMITED")
  return gatewayError("UNAVAILABLE")
}

function mapListError(error: FileApiError): FileToolGatewayError {
  if (error.code === "NOT_AUTHENTICATED") {
    return gatewayError("NOT_AUTHENTICATED")
  }
  if (error.code === "INVALID_INPUT") return gatewayError("INVALID_INPUT")
  if (error.code === "RATE_LIMITED") return gatewayError("RATE_LIMITED")
  return gatewayError("UNAVAILABLE")
}

function indexStatus(
  embedding: PublicEmbeddingState | undefined
): FileIndexStatus {
  if (embedding?.status === "ready") return "ready"
  if (
    embedding?.status === "queued" ||
    embedding?.status === "extracting" ||
    embedding?.status === "embedding"
  ) {
    return "indexing"
  }
  return "unavailable"
}

export type ConvexFileToolGatewayContext = {
  authToken: string
  getAuthToken?: () => Promise<string | null>
  client?: ConvexHttpClient
  convexUrl?: string
  convexSiteUrl: string
  serviceSecret: string
}

/** Reaches user file data through the trusted Convex service endpoints. */
export class ConvexFileToolGateway implements FileToolGateway {
  constructor(
    private readonly fileRest: FileRestService,
    private readonly context: ConvexFileToolGatewayContext,
    private readonly fetch: Fetch = globalThis.fetch
  ) {}

  listEntries(input: { path: string; cursor: string | null; limit: number }) {
    return ResultAsync.fromSafePromise(
      this.fileRest.list({
        path: input.path,
        recursive: true,
        cursor: input.cursor,
        limit: input.limit,
      })
    ).andThen((result) => {
      if (!result.ok) return errAsync(mapListError(result.error))
      const entries: FileEntrySummary[] = result.value.page.map((entry) => ({
        ...(entry.fileId !== undefined ? { fileId: entry.fileId } : {}),
        path: entry.path,
        kind: entry.kind,
        ...(entry.kind === "file"
          ? { indexStatus: indexStatus(entry.embedding) }
          : {}),
      }))
      return okAsync({
        entries,
        ...(result.value.isDone
          ? {}
          : { nextCursor: result.value.continueCursor }),
      })
    })
  }

  searchCandidates(input: { query: string; limit: number }) {
    return this.request(
      { operation: "search", query: input.query, limit: input.limit },
      internalAiSearchResponseSchema
    ).map((candidates): readonly SearchCandidate[] => candidates)
  }

  findExactReferences(input: {
    query: string
    caseSensitive: boolean
    cursor: string | null
  }) {
    return this.request(
      {
        operation: "findExact",
        query: input.query,
        caseSensitive: input.caseSensitive,
        cursor: input.cursor,
      },
      internalAiExactResponseSchema
    ).map((page): ExactReferencePage => page)
  }

  readChunks(input: { fileId: string; cursor: string | null; limit: number }) {
    return this.request(
      {
        operation: "read",
        fileId: input.fileId,
        cursor: input.cursor,
        numItems: input.limit,
      },
      internalAiReadResponseSchema
    ).map((page): FileChunkPage => ({
      file: page.file,
      chunks: page.chunks,
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    }))
  }

  proposeOrganization(input: {
    conversationId: string
    previousPlanId?: string
    summary: string
    warnings: readonly string[]
    operations: readonly { beforePath: string; afterPath: string }[]
  }) {
    return ResultAsync.fromPromise(
      (async () => {
        const client =
          this.context.client ??
          new ConvexHttpClient(
            this.context.convexUrl ??
              this.context.convexSiteUrl.replace(".site", ".cloud")
          )
        const authToken =
          (await this.context.getAuthToken?.()) ?? this.context.authToken
        client.setAuth(authToken)
        const result = await client.mutation(api.organizationPlans.propose, {
          conversationId: input.conversationId as never,
          ...(input.previousPlanId
            ? { previousPlanId: input.previousPlanId as never }
            : {}),
          summary: input.summary,
          warnings: [...input.warnings],
          operations: input.operations.map((operation) => ({ ...operation })),
        })
        if (!result.ok) {
          const code =
            result.error.code === "PLAN_NOT_FOUND"
              ? "FILE_NOT_FOUND"
              : result.error.code === "PLAN_NOT_APPLICABLE" ||
                  result.error.code === "PLAN_STALE" ||
                  result.error.code === "PATH_CONFLICT" ||
                  result.error.code === "SCOPE_TOO_LARGE"
                ? result.error.code
                : "INVALID_INPUT"
          throw new GatewayRequestError(
            gatewayError(code, result.error.message)
          )
        }
        return {
          planId: result.value.planId as string,
          revision: result.value.revision,
        }
      })(),
      mapRequestError
    )
  }

  private request<T>(
    body: Record<string, unknown>,
    schema: z.ZodType<T>
  ): ResultAsync<T, FileToolGatewayError> {
    const siteUrl = this.context.convexSiteUrl.replace(/\/$/, "")
    return ResultAsync.fromPromise(
      (async () => {
        const authToken =
          (await this.context.getAuthToken?.()) ?? this.context.authToken
        return await this.fetch(`${siteUrl}/internal/ai/files`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${authToken}`,
            "Content-Type": "application/json",
            "x-file-service-secret": this.context.serviceSecret,
          },
          body: JSON.stringify(internalAiFileRequestSchema.parse(body)),
        })
      })().then(async (response) => {
        if (!response.ok) {
          const failure = (await response.json().catch(() => null)) as {
            code?: unknown
          } | null
          throw new GatewayRequestError(
            mapStatus(response.status, failure?.code)
          )
        }
        const parsed = schema.safeParse(await response.json())
        if (!parsed.success) {
          throw new GatewayRequestError(gatewayError("UNAVAILABLE"))
        }
        return parsed.data
      }),
      mapRequestError
    )
  }
}
