/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as crons from "../crons.js";
import type * as documentEmbedding from "../documentEmbedding.js";
import type * as documentEmbeddingAction from "../documentEmbeddingAction.js";
import type * as embeddings_rag from "../embeddings/rag.js";
import type * as fileCleanup from "../fileCleanup.js";
import type * as fileMigration from "../fileMigration.js";
import type * as fileRest from "../fileRest.js";
import type * as fileTransitions from "../fileTransitions.js";
import type * as http from "../http.js";
import type * as migrations from "../migrations.js";
import type * as status from "../status.js";
import type * as userUsage from "../userUsage.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  crons: typeof crons;
  documentEmbedding: typeof documentEmbedding;
  documentEmbeddingAction: typeof documentEmbeddingAction;
  "embeddings/rag": typeof embeddings_rag;
  fileCleanup: typeof fileCleanup;
  fileMigration: typeof fileMigration;
  fileRest: typeof fileRest;
  fileTransitions: typeof fileTransitions;
  http: typeof http;
  migrations: typeof migrations;
  status: typeof status;
  userUsage: typeof userUsage;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  migrations: import("@convex-dev/migrations/_generated/component.js").ComponentApi<"migrations">;
  rag: import("@convex-dev/rag/_generated/component.js").ComponentApi<"rag">;
};
