import { httpRouter } from "convex/server"

import { internal } from "./_generated/api"
import { httpAction } from "./_generated/server"

const http = httpRouter()

function serviceAuthorized(request: Request): boolean {
  const configured = process.env.FILE_SERVICE_SECRET
  const presented = request.headers.get("x-file-service-secret")
  return Boolean(
    configured &&
    configured.length >= 32 &&
    presented &&
    configured === presented
  )
}

http.route({
  path: "/internal/files/transition",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!serviceAuthorized(request)) {
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
    } catch {
      return new Response("Transition rejected", { status: 409 })
    }
  }),
})

export default http
