import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { openApiDocument } from "./openapi"

function documentedOperations() {
  return Object.entries(openApiDocument.paths).flatMap(([path, pathItem]) =>
    Object.keys(pathItem).map((method) => `${method.toUpperCase()} ${path}`)
  )
}

function applicationRouteOperations() {
  const routesDirectory = resolve(process.cwd(), "src/routes")

  return readdirSync(routesDirectory).flatMap((filename) => {
    const source = readFileSync(resolve(routesDirectory, filename), "utf8")
    const path = source.match(/createFileRoute\("([^"]+)"\)/)?.[1]
    if (!path || !source.includes("handlers:")) return []

    const openApiPath = path.replace(/\$([A-Za-z]\w*)/g, "{$1}")
    return [...source.matchAll(/\b(GET|POST|PUT|PATCH|DELETE):/g)].map(
      ([, method]) => `${method} ${openApiPath}`
    )
  })
}

function convexHttpOperations() {
  const source = readFileSync(resolve(process.cwd(), "convex/http.ts"), "utf8")

  return [
    ...source.matchAll(
      /http\.route\(\{\s*path: "([^"]+)",\s*method: "([^"]+)"/g
    ),
  ].map(([, path, method]) => `${method} ${path}`)
}

describe("OpenAPI document", () => {
  it("references every stable HTTP operation", () => {
    const actual = documentedOperations().sort()
    const expected = [
      ...applicationRouteOperations(),
      ...convexHttpOperations(),
    ].sort()

    expect(actual).toEqual(expected)
  })

  it("gives every operation a unique operationId", () => {
    const operationIds = Object.values(openApiDocument.paths).flatMap((path) =>
      Object.values(path).map((operation) => operation.operationId)
    )

    expect(new Set(operationIds).size).toBe(operationIds.length)
  })

  it("keeps internal storage and ownership fields out of public file data", () => {
    const publicFile = openApiDocument.components.schemas.File

    expect(publicFile.properties).not.toHaveProperty("objectKey")
    expect(publicFile.properties).not.toHaveProperty("ownerClerkUserId")
    expect(publicFile.properties).not.toHaveProperty("ownerTokenIdentifier")
  })

  it("documents every trusted file operation with a specific variant", () => {
    const trusted =
      openApiDocument.components.schemas.TrustedFileOperation.oneOf
    const operations = trusted.map(
      (variant) => variant.properties.operation.const
    )

    expect(operations).toEqual([
      "getOwned",
      "list",
      "consumeRateLimit",
      "createUpload",
      "completeUpload",
      "completeCopy",
      "failPending",
      "reserveCopy",
      "move",
      "beginDelete",
      "completeDelete",
      "cancelDelete",
    ])
    expect(trusted.every((variant) => !variant.additionalProperties)).toBe(true)
  })
})
