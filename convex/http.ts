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
  if (message.includes("File not found")) {
    return Response.json({ code: "FILE_NOT_FOUND" }, { status: 404 })
  }
  if (message.includes("Invalid file state")) {
    return Response.json({ code: "INVALID_FILE_STATE" }, { status: 409 })
  }
  return Response.json({ code: "TRANSITION_REJECTED" }, { status: 409 })
}

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
            await ctx.runMutation(internal.fileTransitions.markReady, {
              ...owned,
              verifiedContentType: input.verifiedContentType,
              verifiedSize: input.verifiedSize,
              etag: input.etag,
            })
          )
        case "beginDelete":
          return Response.json(
            await ctx.runMutation(internal.fileTransitions.beginDelete, owned)
          )
        case "completeDelete":
          await ctx.runMutation(internal.fileTransitions.completeDelete, owned)
          return Response.json(null)
        case "markFailed":
          if (typeof input.failureCode !== "string") {
            return new Response("Invalid request", { status: 400 })
          }
          await ctx.runMutation(internal.fileTransitions.markFailed, {
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
