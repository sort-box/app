const errorResponse = {
  description: "The request failed.",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ErrorResponse" },
    },
  },
} as const

const authenticatedErrors = {
  "400": errorResponse,
  "401": errorResponse,
  "403": errorResponse,
  "429": {
    ...errorResponse,
    headers: {
      "Retry-After": {
        description: "Seconds until another request may be attempted.",
        schema: { type: "integer", minimum: 1 },
      },
    },
  },
  "500": errorResponse,
  "503": errorResponse,
} as const

const fileIdParameter = {
  name: "fileId",
  in: "path",
  required: true,
  description: "The Convex identifier of the file.",
  schema: { type: "string", minLength: 1 },
} as const

const jsonBody = (schema: Record<string, unknown>) => ({
  required: true,
  content: {
    "application/json": { schema },
  },
})

const trustedOperation = (
  operation: string,
  required: string[],
  properties: Record<string, unknown>
) => ({
  type: "object",
  additionalProperties: false,
  required: ["operation", ...required],
  properties: {
    operation: { type: "string", const: operation },
    ...properties,
  },
})

const dataResponse = (
  schema: Record<string, unknown>,
  description: string
) => ({
  description,
  content: {
    "application/json": {
      schema: {
        allOf: [
          { $ref: "#/components/schemas/SuccessResponse" },
          {
            type: "object",
            properties: { data: schema },
          },
        ],
      },
    },
  },
})

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Untie File API",
    version: "1.0.0",
    description:
      "Authenticated endpoints for listing, uploading, downloading, moving, copying, and deleting files.",
  },
  servers: [{ url: "/", description: "Current application deployment" }],
  tags: [
    { name: "Files", description: "Authenticated file operations." },
    {
      name: "Maintenance",
      description: "Internal service-to-service maintenance operations.",
    },
  ],
  paths: {
    "/api/files": {
      get: {
        tags: ["Files"],
        operationId: "listFiles",
        summary: "List files",
        security: [{ clerkSession: [] }],
        parameters: [
          {
            name: "path",
            in: "query",
            description: "Directory path to list.",
            schema: { type: "string", default: "/", example: "/reports" },
          },
          {
            name: "recursive",
            in: "query",
            description: "Include entries below nested directories.",
            schema: { type: "boolean", default: false },
          },
          {
            name: "cursor",
            in: "query",
            description: "Pagination cursor returned by a previous request.",
            schema: { type: "string", minLength: 1 },
          },
          {
            name: "limit",
            in: "query",
            description: "Maximum number of entries to return.",
            schema: {
              type: "integer",
              minimum: 1,
              maximum: 100,
              default: 25,
            },
          },
        ],
        responses: {
          "200": dataResponse(
            { $ref: "#/components/schemas/FilePage" },
            "A page of file-system entries."
          ),
          ...authenticatedErrors,
        },
      },
    },
    "/api/files/uploads": {
      post: {
        tags: ["Files"],
        operationId: "createFileUpload",
        summary: "Create an upload",
        description:
          "Reserves a file and returns a signed PUT request. Send the exact declared content length and content type when uploading.",
        security: [{ clerkSession: [] }],
        requestBody: jsonBody({
          type: "object",
          additionalProperties: false,
          required: ["path", "contentType", "size"],
          properties: {
            path: {
              type: "string",
              example: "/reports/summary.pdf",
            },
            contentType: {
              type: "string",
              minLength: 1,
              maxLength: 255,
              example: "application/pdf",
            },
            size: {
              type: "integer",
              minimum: 0,
              maximum: 5363340410,
              description: "File size in bytes.",
            },
          },
        }),
        responses: {
          "201": dataResponse(
            { $ref: "#/components/schemas/UploadReservation" },
            "The upload was reserved."
          ),
          "409": errorResponse,
          "413": errorResponse,
          ...authenticatedErrors,
        },
      },
    },
    "/api/files/{fileId}/complete": {
      post: {
        tags: ["Files"],
        operationId: "completeFileUpload",
        summary: "Complete an upload",
        description:
          "Verifies the uploaded object and marks the file as ready.",
        security: [{ clerkSession: [] }],
        parameters: [fileIdParameter],
        responses: {
          "200": dataResponse(
            { $ref: "#/components/schemas/File" },
            "The completed file."
          ),
          "404": errorResponse,
          "409": errorResponse,
          ...authenticatedErrors,
        },
      },
    },
    "/api/files/{fileId}/download": {
      get: {
        tags: ["Files"],
        operationId: "getFileDownload",
        summary: "Create a download URL",
        security: [{ clerkSession: [] }],
        parameters: [fileIdParameter],
        responses: {
          "200": dataResponse(
            { $ref: "#/components/schemas/SignedDownload" },
            "A short-lived signed download URL."
          ),
          "404": errorResponse,
          "409": errorResponse,
          ...authenticatedErrors,
        },
      },
    },
    "/api/files/{fileId}": {
      patch: {
        tags: ["Files"],
        operationId: "moveFile",
        summary: "Move a file",
        security: [{ clerkSession: [] }],
        parameters: [fileIdParameter],
        requestBody: jsonBody({
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: {
            path: {
              type: "string",
              example: "/archive/summary.pdf",
            },
          },
        }),
        responses: {
          "200": dataResponse(
            { $ref: "#/components/schemas/File" },
            "The moved file."
          ),
          "404": errorResponse,
          "409": errorResponse,
          ...authenticatedErrors,
        },
      },
      delete: {
        tags: ["Files"],
        operationId: "deleteFile",
        summary: "Delete a file",
        security: [{ clerkSession: [] }],
        parameters: [fileIdParameter],
        responses: {
          "204": { description: "The file was deleted." },
          "404": errorResponse,
          "409": errorResponse,
          ...authenticatedErrors,
        },
      },
    },
    "/api/files/{fileId}/copies": {
      post: {
        tags: ["Files"],
        operationId: "copyFile",
        summary: "Copy a file",
        security: [{ clerkSession: [] }],
        parameters: [fileIdParameter],
        requestBody: jsonBody({
          type: "object",
          additionalProperties: false,
          required: ["destinationPath"],
          properties: {
            destinationPath: {
              type: "string",
              example: "/archive/summary-copy.pdf",
            },
          },
        }),
        responses: {
          "201": dataResponse(
            { $ref: "#/components/schemas/File" },
            "The copied file."
          ),
          "404": errorResponse,
          "409": errorResponse,
          "413": errorResponse,
          ...authenticatedErrors,
        },
      },
    },
    "/api/folders": {
      post: {
        tags: ["Files"],
        operationId: "createFolder",
        summary: "Create a folder",
        description:
          "Creates an empty folder that persists until it is explicitly deleted.",
        security: [{ clerkSession: [] }],
        requestBody: jsonBody({
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: {
            path: { type: "string", example: "/reports/2026" },
          },
        }),
        responses: {
          "201": dataResponse(
            { $ref: "#/components/schemas/FileEntry" },
            "The created folder."
          ),
          "409": errorResponse,
          ...authenticatedErrors,
        },
      },
      patch: {
        tags: ["Files"],
        operationId: "moveFolder",
        summary: "Move a folder",
        description:
          "Moves a folder and everything inside it to a new destination path.",
        security: [{ clerkSession: [] }],
        requestBody: jsonBody({
          type: "object",
          additionalProperties: false,
          required: ["path", "destinationPath"],
          properties: {
            path: { type: "string", example: "/reports/2026" },
            destinationPath: { type: "string", example: "/archive/2026" },
          },
        }),
        responses: {
          "200": dataResponse(
            { $ref: "#/components/schemas/FileEntry" },
            "The moved folder."
          ),
          "404": errorResponse,
          "409": errorResponse,
          ...authenticatedErrors,
        },
      },
      delete: {
        tags: ["Files"],
        operationId: "deleteFolder",
        summary: "Delete an empty folder",
        security: [{ clerkSession: [] }],
        parameters: [
          {
            name: "path",
            in: "query",
            required: true,
            description: "Path of the folder to delete.",
            schema: { type: "string", minLength: 1, example: "/reports/2026" },
          },
        ],
        responses: {
          "204": { description: "The folder was deleted." },
          "404": errorResponse,
          "409": errorResponse,
          ...authenticatedErrors,
        },
      },
    },
    "/api/files/cleanup": {
      post: {
        tags: ["Maintenance"],
        operationId: "cleanupIncompleteUploads",
        summary: "Clean up incomplete uploads",
        description:
          "Internal operation that removes expired, incomplete uploads in a bounded batch.",
        security: [{ fileServiceSecret: [] }],
        responses: {
          "200": {
            description: "The cleanup batch completed.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["cleaned", "examined"],
                  properties: {
                    cleaned: { type: "integer", minimum: 0 },
                    examined: { type: "integer", minimum: 0 },
                  },
                },
              },
            },
          },
          "401": {
            description: "The service secret is missing or invalid.",
            content: { "text/plain": { schema: { type: "string" } } },
          },
          "503": {
            description: "Object storage is not configured.",
            content: { "text/plain": { schema: { type: "string" } } },
          },
        },
      },
    },
    "/api/openapi.json": {
      get: {
        tags: ["Maintenance"],
        operationId: "getOpenApiDocument",
        summary: "Get the OpenAPI document",
        description:
          "Returns the OpenAPI 3.1 document used by the interactive reference.",
        security: [],
        responses: {
          "200": {
            description: "The OpenAPI document.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["openapi", "info", "paths"],
                  properties: {
                    openapi: { type: "string", const: "3.1.0" },
                    info: { type: "object" },
                    paths: { type: "object" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/internal/files/transition": {
      post: {
        tags: ["Maintenance"],
        operationId: "transitionFile",
        summary: "Apply an internal file lifecycle transition",
        description:
          "Convex HTTP action used by the application server. Both the file-service secret and the authenticated user's bearer token are required.",
        servers: [
          {
            url: "https://{deployment}.convex.site",
            description: "Convex site deployment",
            variables: {
              deployment: {
                default: "your-deployment",
                description: "Convex deployment name.",
              },
            },
          },
        ],
        security: [{ fileServiceSecret: [], bearerAuth: [] }],
        requestBody: jsonBody({
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: [
                "operation",
                "fileId",
                "verifiedContentType",
                "verifiedSize",
              ],
              properties: {
                operation: { type: "string", const: "markReady" },
                fileId: { type: "string" },
                verifiedContentType: { type: "string" },
                verifiedSize: { type: "number", minimum: 0 },
                etag: { type: "string" },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["operation", "fileId"],
              properties: {
                operation: {
                  type: "string",
                  enum: ["beginDelete", "completeDelete", "discardIncomplete"],
                },
                fileId: { type: "string" },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["operation", "fileId", "failureCode"],
              properties: {
                operation: { type: "string", const: "markFailed" },
                fileId: { type: "string" },
                failureCode: { type: "string" },
              },
            },
          ],
          discriminator: { propertyName: "operation" },
        }),
        responses: {
          "200": {
            description:
              "The transition completed. Some operations return the updated file; others return null.",
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    { $ref: "#/components/schemas/InternalFile" },
                    { type: "null" },
                  ],
                },
              },
            },
          },
          "400": {
            description: "The request body is invalid.",
            content: { "text/plain": { schema: { type: "string" } } },
          },
          "401": {
            description:
              "The service secret or authenticated user token is missing or invalid.",
            content: { "text/plain": { schema: { type: "string" } } },
          },
          "404": {
            description: "The file was not found.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TransitionError" },
              },
            },
          },
          "409": {
            description: "The requested lifecycle transition was rejected.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TransitionError" },
              },
            },
          },
        },
      },
    },
    "/internal/files/rest": {
      post: {
        tags: ["Maintenance"],
        operationId: "executeTrustedFileOperation",
        summary: "Execute a trusted private-file operation",
        description:
          "Convex HTTP action used exclusively by the application server. It requires both the file-service secret and the authenticated user's bearer token; ownership and policy values are derived server-side.",
        servers: [
          {
            url: "https://{deployment}.convex.site",
            description: "Convex site deployment",
            variables: {
              deployment: {
                default: "your-deployment",
                description: "Convex deployment name.",
              },
            },
          },
        ],
        security: [{ fileServiceSecret: [], bearerAuth: [] }],
        requestBody: jsonBody({
          $ref: "#/components/schemas/TrustedFileOperation",
        }),
        responses: {
          "200": {
            description: "The trusted operation completed.",
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    { $ref: "#/components/schemas/InternalFile" },
                    { $ref: "#/components/schemas/InternalFilePage" },
                    { $ref: "#/components/schemas/InternalUploadReservation" },
                    { $ref: "#/components/schemas/InternalCopyReservation" },
                    { $ref: "#/components/schemas/RateLimitDecision" },
                    {
                      allOf: [
                        { $ref: "#/components/schemas/FileEntry" },
                        {
                          type: "object",
                          required: ["ownerTokenIdentifier"],
                          properties: {
                            ownerTokenIdentifier: { type: "string" },
                          },
                        },
                      ],
                    },
                    { type: "null" },
                  ],
                },
              },
            },
          },
          "400": errorResponse,
          "401": errorResponse,
          "404": errorResponse,
          "409": errorResponse,
          "413": errorResponse,
        },
      },
    },
    "/internal/files/cleanup": {
      post: {
        tags: ["Maintenance"],
        operationId: "manageExpiredFiles",
        summary: "List or complete internal expired-file cleanup",
        description:
          "Convex HTTP action used by the application cleanup route.",
        servers: [
          {
            url: "https://{deployment}.convex.site",
            description: "Convex site deployment",
            variables: {
              deployment: {
                default: "your-deployment",
                description: "Convex deployment name.",
              },
            },
          },
        ],
        security: [{ fileServiceSecret: [] }],
        requestBody: jsonBody({
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["operation", "cutoff", "limit"],
              properties: {
                operation: { type: "string", const: "list" },
                cutoff: {
                  type: "number",
                  description: "Creation-time cutoff in Unix milliseconds.",
                },
                limit: { type: "number", minimum: 0 },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["operation", "fileId", "objectKey"],
              properties: {
                operation: { type: "string", const: "complete" },
                fileId: { type: "string" },
                objectKey: { type: "string" },
              },
            },
          ],
          discriminator: { propertyName: "operation" },
        }),
        responses: {
          "200": {
            description:
              "A list of cleanup candidates or null after completing one candidate.",
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    {
                      type: "array",
                      items: {
                        $ref: "#/components/schemas/CleanupCandidate",
                      },
                    },
                    { type: "null" },
                  ],
                },
              },
            },
          },
          "400": {
            description: "The request body is invalid.",
            content: { "text/plain": { schema: { type: "string" } } },
          },
          "401": {
            description: "The service secret is missing or invalid.",
            content: { "text/plain": { schema: { type: "string" } } },
          },
          "409": {
            description: "Cleanup completion was rejected.",
            content: { "text/plain": { schema: { type: "string" } } },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      clerkSession: {
        type: "apiKey",
        in: "cookie",
        name: "__session",
        description: "The active Clerk session cookie.",
      },
      fileServiceSecret: {
        type: "apiKey",
        in: "header",
        name: "x-file-service-secret",
        description: "Internal file-service secret.",
      },
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description: "Authenticated Clerk token accepted by Convex.",
      },
    },
    schemas: {
      SuccessResponse: {
        type: "object",
        required: ["data", "requestId"],
        properties: {
          data: {},
          requestId: { type: "string", format: "uuid" },
        },
      },
      ErrorResponse: {
        type: "object",
        additionalProperties: false,
        required: ["error", "requestId"],
        properties: {
          error: { $ref: "#/components/schemas/ApiError" },
          requestId: { type: "string", format: "uuid" },
        },
      },
      ApiError: {
        type: "object",
        additionalProperties: false,
        required: ["code", "message", "retryable"],
        properties: {
          code: {
            type: "string",
            enum: [
              "NOT_AUTHENTICATED",
              "FORBIDDEN",
              "INVALID_INPUT",
              "FILE_NOT_FOUND",
              "INVALID_FILE_STATE",
              "PATH_CONFLICT",
              "QUOTA_EXCEEDED",
              "RATE_LIMITED",
              "STORAGE_UNAVAILABLE",
              "CONFIGURATION_ERROR",
              "INTERNAL_ERROR",
            ],
          },
          message: { type: "string" },
          retryable: { type: "boolean" },
          retryAfter: { type: "integer", minimum: 1 },
        },
      },
      TrustedFileOperation: {
        oneOf: [
          trustedOperation("getOwned", ["fileId"], {
            fileId: { type: "string" },
          }),
          trustedOperation(
            "list",
            ["parentPath", "recursive", "cursor", "limit"],
            {
              parentPath: { type: "string" },
              recursive: { type: "boolean" },
              cursor: { type: ["string", "null"] },
              limit: { type: "integer", minimum: 1, maximum: 100 },
            }
          ),
          trustedOperation("consumeRateLimit", ["bucket"], {
            bucket: {
              type: "string",
              enum: ["read", "mutation", "upload"],
            },
          }),
          trustedOperation(
            "createUpload",
            ["path", "parentPath", "basename", "contentType", "size"],
            {
              path: { type: "string" },
              parentPath: { type: "string" },
              basename: { type: "string" },
              contentType: { type: "string" },
              size: { type: "integer", minimum: 0, maximum: 5363340410 },
            }
          ),
          ...["completeUpload", "completeCopy"].map((operation) =>
            trustedOperation(
              operation,
              ["fileId", "verifiedContentType", "verifiedSize"],
              {
                fileId: { type: "string" },
                verifiedContentType: { type: "string" },
                verifiedSize: { type: "integer", minimum: 0 },
                etag: { type: "string" },
              }
            )
          ),
          trustedOperation("failPending", ["fileId", "failureCode"], {
            fileId: { type: "string" },
            failureCode: { type: "string" },
          }),
          trustedOperation(
            "reserveCopy",
            ["sourceFileId", "path", "parentPath", "basename"],
            {
              sourceFileId: { type: "string" },
              path: { type: "string" },
              parentPath: { type: "string" },
              basename: { type: "string" },
            }
          ),
          trustedOperation(
            "move",
            ["fileId", "path", "parentPath", "basename"],
            {
              fileId: { type: "string" },
              path: { type: "string" },
              parentPath: { type: "string" },
              basename: { type: "string" },
            }
          ),
          ...["beginDelete", "completeDelete", "cancelDelete"].map(
            (operation) =>
              trustedOperation(operation, ["fileId"], {
                fileId: { type: "string" },
              })
          ),
          trustedOperation(
            "createDirectory",
            ["path", "parentPath", "basename"],
            {
              path: { type: "string" },
              parentPath: { type: "string" },
              basename: { type: "string" },
            }
          ),
          trustedOperation("deleteDirectory", ["path"], {
            path: { type: "string" },
          }),
          trustedOperation(
            "moveDirectory",
            ["sourcePath", "path", "parentPath", "basename"],
            {
              sourcePath: { type: "string" },
              path: { type: "string" },
              parentPath: { type: "string" },
              basename: { type: "string" },
            }
          ),
        ],
        discriminator: { propertyName: "operation" },
      },
      InternalFile: {
        type: "object",
        description:
          "Trusted service record. This schema is never returned by the public file API.",
        required: [
          "_id",
          "_creationTime",
          "ownerClerkUserId",
          "ownerTokenIdentifier",
          "objectKey",
          "originalName",
          "declaredContentType",
          "declaredSize",
          "status",
        ],
        properties: {
          _id: { type: "string" },
          _creationTime: { type: "number" },
          ownerClerkUserId: { type: "string" },
          ownerTokenIdentifier: { type: "string" },
          objectKey: { type: "string" },
          originalName: { type: "string" },
          declaredContentType: { type: "string" },
          declaredSize: { type: "integer", minimum: 0 },
          verifiedContentType: { type: "string" },
          verifiedSize: { type: "integer", minimum: 0 },
          etag: { type: "string" },
          status: {
            type: "string",
            enum: ["pending", "ready", "deleting", "failed"],
          },
          completedAt: { type: "number" },
          failedAt: { type: "number" },
          failureCode: { type: "string" },
          path: { type: "string" },
          parentPath: { type: "string" },
          basename: { type: "string" },
          operation: { type: "string", enum: ["upload", "copy"] },
          usageBackfilledAt: { type: "number" },
        },
      },
      InternalFilePage: {
        type: "object",
        required: ["page", "isDone", "continueCursor"],
        properties: {
          page: {
            type: "array",
            items: {
              allOf: [
                { $ref: "#/components/schemas/FileEntry" },
                {
                  type: "object",
                  required: ["ownerTokenIdentifier"],
                  properties: {
                    ownerTokenIdentifier: { type: "string" },
                  },
                },
              ],
            },
          },
          isDone: { type: "boolean" },
          continueCursor: { type: "string" },
          splitCursor: { type: ["string", "null"] },
          pageStatus: {
            type: ["string", "null"],
            enum: ["SplitRecommended", "SplitRequired", null],
          },
        },
      },
      InternalUploadReservation: {
        type: "object",
        additionalProperties: false,
        required: ["fileId", "objectKey"],
        properties: {
          fileId: { type: "string" },
          objectKey: { type: "string" },
        },
      },
      InternalCopyReservation: {
        type: "object",
        additionalProperties: false,
        required: ["fileId", "sourceObjectKey", "destinationObjectKey"],
        properties: {
          fileId: { type: "string" },
          sourceObjectKey: { type: "string" },
          destinationObjectKey: { type: "string" },
        },
      },
      RateLimitDecision: {
        type: "object",
        additionalProperties: false,
        required: ["allowed", "retryAfter"],
        properties: {
          allowed: { type: "boolean" },
          retryAfter: { type: "integer", minimum: 0 },
        },
      },
      File: {
        type: "object",
        additionalProperties: false,
        description: "Public metadata for a ready file.",
        required: [
          "id",
          "createdAt",
          "path",
          "parentPath",
          "basename",
          "contentType",
          "size",
          "status",
          "completedAt",
        ],
        properties: {
          id: { type: "string" },
          createdAt: { type: "number" },
          path: { type: "string" },
          parentPath: { type: "string" },
          basename: { type: "string" },
          contentType: { type: "string" },
          size: { type: "integer", minimum: 0 },
          etag: { type: "string" },
          status: { type: "string", const: "ready" },
          completedAt: { type: "number" },
        },
      },
      FileEntry: {
        type: "object",
        required: [
          "_id",
          "_creationTime",
          "path",
          "parentPath",
          "basename",
          "kind",
          "status",
        ],
        properties: {
          _id: { type: "string" },
          _creationTime: { type: "number" },
          path: { type: "string" },
          parentPath: { type: "string" },
          basename: { type: "string" },
          kind: { type: "string", enum: ["file", "directory"] },
          fileId: { type: "string" },
          status: {
            type: "string",
            enum: ["pending", "ready", "deleting", "failed"],
          },
        },
      },
      FilePage: {
        type: "object",
        required: ["page", "isDone", "continueCursor"],
        properties: {
          page: {
            type: "array",
            items: { $ref: "#/components/schemas/FileEntry" },
          },
          isDone: { type: "boolean" },
          continueCursor: { type: "string" },
        },
      },
      UploadReservation: {
        type: "object",
        additionalProperties: false,
        required: ["fileId", "upload"],
        properties: {
          fileId: { type: "string" },
          upload: {
            type: "object",
            required: ["url", "method", "requiredHeaders", "expiresAt"],
            properties: {
              url: { type: "string", format: "uri" },
              method: { type: "string", const: "PUT" },
              requiredHeaders: {
                type: "object",
                additionalProperties: { type: "string" },
              },
              expiresAt: { type: "number" },
            },
          },
        },
      },
      SignedDownload: {
        type: "object",
        required: ["url", "expiresAt", "requiredHeaders"],
        properties: {
          url: { type: "string", format: "uri" },
          expiresAt: { type: "number" },
          requiredHeaders: {
            type: "object",
            additionalProperties: { type: "string" },
          },
        },
      },
      TransitionError: {
        type: "object",
        additionalProperties: false,
        required: ["code"],
        properties: {
          code: {
            type: "string",
            enum: [
              "FILE_NOT_FOUND",
              "INVALID_FILE_STATE",
              "TRANSITION_REJECTED",
            ],
          },
        },
      },
      CleanupCandidate: {
        type: "object",
        additionalProperties: false,
        required: ["fileId", "objectKey"],
        properties: {
          fileId: { type: "string" },
          objectKey: { type: "string" },
        },
      },
    },
  },
} as const
