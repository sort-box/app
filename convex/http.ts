import { httpRouter } from "convex/server"

import { internal } from "./_generated/api"
import { httpAction } from "./_generated/server"

const http = httpRouter()

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  )
}

async function serviceAuthorized(request: Request): Promise<boolean> {
  const configured = process.env.FILE_SERVICE_SECRET
  const presented = request.headers.get("x-file-service-secret")
  if (!configured || configured.length < 32 || !presented) return false

  const [configuredDigest, presentedDigest] = await Promise.all([
    sha256(configured),
    sha256(presented),
  ])
  let difference = 0
  for (let index = 0; index < configuredDigest.length; index += 1) {
    difference |= configuredDigest[index] ^ presentedDigest[index]
  }
  return difference === 0
}

function transitionError(error: unknown): Response {
  const message = error instanceof Error ? error.message : ""
  if (
    message.includes("File not found") ||
    message.includes("FILE_NOT_FOUND")
  ) {
    return Response.json({ code: "FILE_NOT_FOUND" }, { status: 404 })
  }
  if (
    message.includes("Invalid file state") ||
    message.includes("INVALID_FILE_STATE")
  ) {
    return Response.json({ code: "INVALID_FILE_STATE" }, { status: 409 })
  }
  if (message.includes("PATH_CONFLICT")) {
    return Response.json({ code: "PATH_CONFLICT" }, { status: 409 })
  }
  if (message.includes("DIRECTORY_NOT_EMPTY")) {
    return Response.json({ code: "DIRECTORY_NOT_EMPTY" }, { status: 409 })
  }
  if (message.includes("DIRECTORY_TOO_LARGE")) {
    return Response.json({ code: "DIRECTORY_TOO_LARGE" }, { status: 400 })
  }
  if (message.includes("QUOTA_EXCEEDED")) {
    return Response.json({ code: "QUOTA_EXCEEDED" }, { status: 413 })
  }
  if (
    message.includes("INVALID_PATH") ||
    message.includes("INVALID_SIZE") ||
    message.includes("UPLOAD_MISMATCH")
  ) {
    return Response.json({ code: "INVALID_INPUT" }, { status: 400 })
  }
  return Response.json({ code: "TRANSITION_REJECTED" }, { status: 409 })
}

function aiUsageError(error: unknown): Response {
  const message = error instanceof Error ? error.message : ""
  if (message.includes("AI_USAGE_LIMIT_EXCEEDED")) {
    return Response.json({ code: "AI_USAGE_LIMIT_EXCEEDED" }, { status: 429 })
  }
  if (message.includes("AI_ENTITLEMENT_NOT_CONFIGURED")) {
    return Response.json(
      { code: "AI_ENTITLEMENT_NOT_CONFIGURED" },
      { status: 409 }
    )
  }
  if (message.includes("INVALID_AI_USAGE")) {
    return Response.json({ code: "INVALID_INPUT" }, { status: 400 })
  }
  return Response.json({ code: "USAGE_TRACKING_FAILED" }, { status: 503 })
}

http.route({
  path: "/internal/ai/usage",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!(await serviceAuthorized(request))) {
      return new Response("Unauthorized", { status: 401 })
    }
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) return new Response("Unauthorized", { status: 401 })
    const input = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null
    if (
      !input ||
      (input.operation !== "check" && input.operation !== "record")
    ) {
      return new Response("Invalid request", { status: 400 })
    }
    const ownerTokenIdentifier = identity.tokenIdentifier
    try {
      if (input.operation === "check") {
        await ctx.runMutation(internal.aiUsage.checkAllowance, {
          ownerTokenIdentifier,
        })
        return Response.json(null)
      }
      if (
        typeof input.inputTokens !== "number" ||
        typeof input.outputTokens !== "number"
      ) {
        return new Response("Invalid request", { status: 400 })
      }
      await ctx.runMutation(internal.aiUsage.record, {
        ownerTokenIdentifier,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
      })
      return Response.json(null)
    } catch (error) {
      return aiUsageError(error)
    }
  }),
})

http.route({
  path: "/internal/files/transition",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!(await serviceAuthorized(request))) {
      return new Response("Unauthorized", { status: 401 })
    }
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) return new Response("Unauthorized", { status: 401 })

    const input = (await request.json()) as {
      operation?: unknown
      fileId?: unknown
      verifiedContentType?: unknown
      verifiedSize?: unknown
      etag?: unknown
      failureCode?: unknown
    }
    if (
      typeof input.operation !== "string" ||
      typeof input.fileId !== "string"
    ) {
      return new Response("Invalid request", { status: 400 })
    }
    const owned = {
      fileId: input.fileId as never,
      ownerTokenIdentifier: identity.tokenIdentifier,
    }

    try {
      switch (input.operation) {
        case "markReady":
          if (
            typeof input.verifiedContentType !== "string" ||
            typeof input.verifiedSize !== "number" ||
            (input.etag !== undefined && typeof input.etag !== "string")
          ) {
            return new Response("Invalid request", { status: 400 })
          }
          return Response.json(
            await ctx.runMutation(internal.fileRest.completeUpload, {
              ...owned,
              verifiedContentType: input.verifiedContentType,
              verifiedSize: input.verifiedSize,
              etag: input.etag,
            })
          )
        case "beginDelete":
          return Response.json(
            await ctx.runMutation(internal.fileRest.beginDelete, owned)
          )
        case "completeDelete":
          await ctx.runMutation(internal.fileRest.completeDelete, owned)
          return Response.json(null)
        case "markFailed":
          if (typeof input.failureCode !== "string") {
            return new Response("Invalid request", { status: 400 })
          }
          await ctx.runMutation(internal.fileRest.failPending, {
            ...owned,
            failureCode: input.failureCode,
          })
          return Response.json(null)
        case "discardIncomplete":
          await ctx.runMutation(
            internal.fileTransitions.discardIncomplete,
            owned
          )
          return Response.json(null)
        default:
          return new Response("Invalid request", { status: 400 })
      }
    } catch (error) {
      return transitionError(error)
    }
  }),
})

http.route({
  path: "/internal/files/rest",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!(await serviceAuthorized(request))) {
      return new Response("Unauthorized", { status: 401 })
    }
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) return new Response("Unauthorized", { status: 401 })

    const input = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null
    if (!input || typeof input.operation !== "string") {
      return new Response("Invalid request", { status: 400 })
    }
    const owner = {
      ownerClerkUserId: identity.subject,
      ownerTokenIdentifier: identity.tokenIdentifier,
    }
    const owned = { ownerTokenIdentifier: identity.tokenIdentifier }

    try {
      switch (input.operation) {
        case "getOwned":
          if (typeof input.fileId !== "string") {
            return new Response("Invalid request", { status: 400 })
          }
          return Response.json(
            await ctx.runQuery(internal.fileRest.getOwned, {
              ...owned,
              fileId: input.fileId as never,
            })
          )
        case "list":
          if (
            typeof input.parentPath !== "string" ||
            typeof input.recursive !== "boolean" ||
            (input.cursor !== null && typeof input.cursor !== "string") ||
            typeof input.limit !== "number"
          ) {
            return new Response("Invalid request", { status: 400 })
          }
          return Response.json(
            await ctx.runQuery(internal.fileRest.list, {
              ...owned,
              parentPath: input.parentPath,
              recursive: input.recursive,
              paginationOpts: {
                cursor: input.cursor,
                numItems: input.limit,
              },
            })
          )
        case "consumeRateLimit":
          if (
            input.bucket !== "read" &&
            input.bucket !== "mutation" &&
            input.bucket !== "upload"
          ) {
            return new Response("Invalid request", { status: 400 })
          }
          return Response.json(
            await ctx.runMutation(internal.fileRest.consumeRateLimit, {
              ...owned,
              bucket: input.bucket,
            })
          )
        case "createUpload":
          if (
            typeof input.path !== "string" ||
            typeof input.parentPath !== "string" ||
            typeof input.basename !== "string" ||
            typeof input.contentType !== "string" ||
            typeof input.size !== "number"
          ) {
            return new Response("Invalid request", { status: 400 })
          }
          return Response.json(
            await ctx.runMutation(internal.fileRest.createUpload, {
              ...owner,
              path: input.path,
              parentPath: input.parentPath,
              basename: input.basename,
              contentType: input.contentType,
              size: input.size,
            })
          )
        case "completeUpload":
        case "completeCopy":
          if (
            typeof input.fileId !== "string" ||
            typeof input.verifiedContentType !== "string" ||
            typeof input.verifiedSize !== "number" ||
            (input.etag !== undefined && typeof input.etag !== "string")
          ) {
            return new Response("Invalid request", { status: 400 })
          }
          return Response.json(
            await ctx.runMutation(
              input.operation === "completeUpload"
                ? internal.fileRest.completeUpload
                : internal.fileRest.completeCopy,
              {
                ...owned,
                fileId: input.fileId as never,
                verifiedContentType: input.verifiedContentType,
                verifiedSize: input.verifiedSize,
                etag: input.etag,
              }
            )
          )
        case "failPending":
          if (
            typeof input.fileId !== "string" ||
            typeof input.failureCode !== "string"
          ) {
            return new Response("Invalid request", { status: 400 })
          }
          return Response.json(
            await ctx.runMutation(internal.fileRest.failPending, {
              ...owned,
              fileId: input.fileId as never,
              failureCode: input.failureCode,
            })
          )
        case "retryEmbedding":
          if (typeof input.fileId !== "string") {
            return new Response("Invalid request", { status: 400 })
          }
          return Response.json(
            await ctx.runMutation(internal.fileRest.retryEmbedding, {
              ...owned,
              fileId: input.fileId as never,
            })
          )
        case "reserveCopy":
          if (
            typeof input.sourceFileId !== "string" ||
            typeof input.path !== "string" ||
            typeof input.parentPath !== "string" ||
            typeof input.basename !== "string"
          ) {
            return new Response("Invalid request", { status: 400 })
          }
          return Response.json(
            await ctx.runMutation(internal.fileRest.reserveCopy, {
              ...owner,
              sourceFileId: input.sourceFileId as never,
              path: input.path,
              parentPath: input.parentPath,
              basename: input.basename,
            })
          )
        case "move":
          if (
            typeof input.fileId !== "string" ||
            typeof input.path !== "string" ||
            typeof input.parentPath !== "string" ||
            typeof input.basename !== "string"
          ) {
            return new Response("Invalid request", { status: 400 })
          }
          return Response.json(
            await ctx.runMutation(internal.fileRest.move, {
              ...owned,
              fileId: input.fileId as never,
              path: input.path,
              parentPath: input.parentPath,
              basename: input.basename,
            })
          )
        case "createDirectory":
          if (
            typeof input.path !== "string" ||
            typeof input.parentPath !== "string" ||
            typeof input.basename !== "string"
          ) {
            return new Response("Invalid request", { status: 400 })
          }
          return Response.json(
            await ctx.runMutation(internal.fileRest.createDirectory, {
              ...owned,
              path: input.path,
              parentPath: input.parentPath,
              basename: input.basename,
            })
          )
        case "deleteDirectory":
          if (typeof input.path !== "string") {
            return new Response("Invalid request", { status: 400 })
          }
          await ctx.runMutation(internal.fileRest.deleteDirectory, {
            ...owned,
            path: input.path,
          })
          return Response.json(null)
        case "moveDirectory":
          if (
            typeof input.sourcePath !== "string" ||
            typeof input.path !== "string" ||
            typeof input.parentPath !== "string" ||
            typeof input.basename !== "string"
          ) {
            return new Response("Invalid request", { status: 400 })
          }
          return Response.json(
            await ctx.runMutation(internal.fileRest.moveDirectory, {
              ...owned,
              sourcePath: input.sourcePath,
              path: input.path,
              parentPath: input.parentPath,
              basename: input.basename,
            })
          )
        case "beginDelete":
        case "completeDelete":
        case "cancelDelete":
          if (typeof input.fileId !== "string") {
            return new Response("Invalid request", { status: 400 })
          }
          return Response.json(
            await ctx.runMutation(
              input.operation === "beginDelete"
                ? internal.fileRest.beginDelete
                : input.operation === "completeDelete"
                  ? internal.fileRest.completeDelete
                  : internal.fileRest.cancelDelete,
              { ...owned, fileId: input.fileId as never }
            )
          )
        default:
          return new Response("Invalid request", { status: 400 })
      }
    } catch (error) {
      return transitionError(error)
    }
  }),
})

http.route({
  path: "/internal/files/cleanup",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!(await serviceAuthorized(request))) {
      return new Response("Unauthorized", { status: 401 })
    }
    const input = (await request.json()) as {
      operation?: unknown
      cutoff?: unknown
      limit?: unknown
      fileId?: unknown
      objectKey?: unknown
    }
    if (input.operation === "list") {
      if (typeof input.cutoff !== "number" || typeof input.limit !== "number") {
        return new Response("Invalid request", { status: 400 })
      }
      return Response.json(
        await ctx.runQuery(internal.fileTransitions.listExpired, {
          cutoff: input.cutoff,
          limit: input.limit,
        })
      )
    }
    if (input.operation === "complete") {
      if (
        typeof input.fileId !== "string" ||
        typeof input.objectKey !== "string"
      ) {
        return new Response("Invalid request", { status: 400 })
      }
      try {
        await ctx.runMutation(internal.fileTransitions.completeCleanup, {
          fileId: input.fileId as never,
          objectKey: input.objectKey,
        })
        return Response.json(null)
      } catch {
        return new Response("Cleanup rejected", { status: 409 })
      }
    }
    return new Response("Invalid request", { status: 400 })
  }),
})

export default http
