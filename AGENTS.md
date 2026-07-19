<!-- intent-skills:start -->
# TanStack Intent - before editing files, run the matching guidance command.
tanstackIntent:
  - id: "@reduxjs/toolkit#build-modern-redux-apps/modern-redux"
    run: "bunx @tanstack/intent@latest load @reduxjs/toolkit#build-modern-redux-apps/modern-redux"
    for: "Use this when setting up a new Redux Toolkit app or modernizing an existing React + Redux codebase. Covers configureStore, Provider wiring, typed hooks, hooks-first React-Redux usage, feature folders, and the correct store lifetime for SPA and SSR-heavy React environments."
  - id: "@reduxjs/toolkit#build-modern-redux-apps/redux-dataflow"
    run: "bunx @tanstack/intent@latest load @reduxjs/toolkit#build-modern-redux-apps/redux-dataflow"
    for: "Use this when you need the Redux event -> reducer -> selector -> render loop, event-style actions, reducer-owned state transitions, derived data, or a debugging model for Redux Toolkit apps."
  - id: "@reduxjs/toolkit#evolve-and-diagnose-redux-apps/debug-redux-toolkit-apps"
    run: "bunx @tanstack/intent@latest load @reduxjs/toolkit#evolve-and-diagnose-redux-apps/debug-redux-toolkit-apps"
    for: "Use this when debugging duplicate requests, stale cache behavior, broad subscriptions, selector churn, serializability warnings, or other Redux Toolkit and RTK Query bugs. Covers a practical event -> reducer -> selector -> render debugging loop plus RTK Query cache interpretation."
  - id: "@reduxjs/toolkit#evolve-and-diagnose-redux-apps/migrate-to-modern-redux"
    run: "bunx @tanstack/intent@latest load @reduxjs/toolkit#evolve-and-diagnose-redux-apps/migrate-to-modern-redux"
    for: "Use this when moving a legacy Redux codebase to current RTK patterns. Covers replacing createStore with configureStore, migrating touched reducers to createSlice, codemod-assisted RTK 2 updates, and replacing server-data stacks with RTK Query instead of writing new legacy Redux code."
  - id: "@reduxjs/toolkit#manage-server-data/adopt-rtk-query"
    run: "bunx @tanstack/intent@latest load @reduxjs/toolkit#manage-server-data/adopt-rtk-query"
    for: "Use this when adding RTK Query as the default server-data and document-cache layer. Covers createApi, store integration, hooks, invalidation behavior, optimistic updates, and deciding when RTK Query is the right cache model."
  - id: "@reduxjs/toolkit#model-redux-state/build-slices-and-selectors"
    run: "bunx @tanstack/intent@latest load @reduxjs/toolkit#model-redux-state/build-slices-and-selectors"
    for: "Use this when authoring or refactoring slices with createSlice, selectors, create.asyncThunk, entity adapters, or lazy reducer injection. Covers Immer-backed mutation syntax, slice selectors, getSelectors, injectInto, withLazyLoadedSlices, and current RTK 2 slice patterns."
  - id: "@reduxjs/toolkit#model-redux-state/design-state-ownership"
    run: "bunx @tanstack/intent@latest load @reduxjs/toolkit#model-redux-state/design-state-ownership"
    for: "Use this when deciding whether data belongs in Redux, component state, router state, or another external source. Covers state ownership, authority boundaries, slice sizing, and when to move or split data as the app evolves."
  - id: "@reduxjs/toolkit#orchestrate-side-effects/handle-side-effects"
    run: "bunx @tanstack/intent@latest load @reduxjs/toolkit#orchestrate-side-effects/handle-side-effects"
    for: "Use this when choosing between RTK Query, createAsyncThunk, handwritten thunks, and createListenerMiddleware. Covers imperative versus reactive workflows, listener middleware setup, and keeping side effects out of reducers and UI components."
  - id: "@tanstack/ai#ai-core"
    run: "bunx @tanstack/intent@latest load @tanstack/ai#ai-core"
    for: "Entry point for TanStack AI skills. Routes to chat-experience, tool-calling, media-generation, structured-outputs, adapter-configuration, ag-ui-protocol, middleware, custom-backend-integration, and debug-logging. Use chat() not streamText(), openaiText() not createOpenAI(), toServerSentEventsResponse() not manual SSE, middleware hooks not onEnd callbacks."
  - id: "@tanstack/ai#ai-core/adapter-configuration"
    run: "bunx @tanstack/intent@latest load @tanstack/ai#ai-core/adapter-configuration"
    for: "Provider adapter selection and configuration: openaiText, anthropicText, geminiText, ollamaText, grokText, groqText, openRouterText, bedrockText, openaiCompatible. Per-model type safety with modelOptions, reasoning/thinking configuration, runtime adapter switching, extendAdapter() for custom models, createModel(). Generic OpenAI-compatible providers (DeepSeek, Together, Fireworks, etc.) via openaiCompatible({ baseURL, apiKey, models }) from @tanstack/ai-openai/compatible. API key env vars: OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY/GEMINI_API_KEY, XAI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, OLLAMA_HOST, BEDROCK_API_KEY (or AWS_BEARER_TOKEN_BEDROCK)."
  - id: "@tanstack/ai#ai-core/ag-ui-protocol"
    run: "bunx @tanstack/intent@latest load @tanstack/ai#ai-core/ag-ui-protocol"
    for: "Server-side AG-UI streaming protocol implementation: StreamChunk event types (RUN_STARTED, TEXT_MESSAGE_START/CONTENT/END, TOOL_CALL_START/ARGS/END, RUN_FINISHED, RUN_ERROR, STEP_STARTED/STEP_FINISHED, STATE_SNAPSHOT/DELTA, CUSTOM), toServerSentEventsStream() for SSE format, toHttpStream() for NDJSON format. For backends serving AG-UI events without client packages."
  - id: "@tanstack/ai#ai-core/chat-experience"
    run: "bunx @tanstack/intent@latest load @tanstack/ai#ai-core/chat-experience"
    for: "End-to-end chat implementation: server endpoint with chat() and toServerSentEventsResponse(), client-side useChat hook with fetchServerSentEvents(), message rendering with UIMessage parts, multimodal content, thinking/reasoning display. Covers streaming states, connection adapters, and message format conversions. NOT Vercel AI SDK — uses chat() not streamText()."
  - id: "@tanstack/ai#ai-core/custom-backend-integration"
    run: "bunx @tanstack/intent@latest load @tanstack/ai#ai-core/custom-backend-integration"
    for: "Connect useChat to a non-TanStack-AI backend through custom connection adapters. ConnectConnectionAdapter (single async iterable) vs SubscribeConnectionAdapter (separate subscribe/send). Customize fetchServerSentEvents() and fetchHttpStream() with auth headers, custom URLs, and request options. Import from framework package, not @tanstack/ai-client."
  - id: "@tanstack/ai#ai-core/debug-logging"
    run: "bunx @tanstack/intent@latest load @tanstack/ai#ai-core/debug-logging"
    for: "Pluggable, category-toggleable debug logging for TanStack AI activities. Toggle with `debug: true | false | DebugConfig` on chat(), summarize(), generateImage(), generateSpeech(), generateTranscription(), generateVideo(). Categories: request, provider, output, middleware, tools, agentLoop, config, errors. Pipe into pino/winston/etc via `debug: { logger }`. Errors log by default even when `debug` is omitted; silence with `debug: false`."
  - id: "@tanstack/ai#ai-core/media-generation"
    run: "bunx @tanstack/intent@latest load @tanstack/ai#ai-core/media-generation"
    for: "Image, audio, video, speech (TTS), and transcription generation using activity-specific adapters: generateImage() with openaiImage/geminiImage, generateAudio() with geminiAudio/falAudio, generateVideo() with async polling (openaiVideo/geminiVideo/grokVideo/falVideo, per-model typed durations), generateSpeech() with openaiSpeech, generateTranscription() with openaiTranscription. React hooks: useGenerateImage, useGenerateAudio, useGenerateSpeech, useTranscription, useGenerateVideo. TanStack Start server function integration with toServerSentEventsResponse."
  - id: "@tanstack/ai#ai-core/middleware"
    run: "bunx @tanstack/intent@latest load @tanstack/ai#ai-core/middleware"
    for: "Chat lifecycle middleware hooks: onConfig, onStart, onChunk, onBeforeToolCall, onAfterToolCall, onUsage, onFinish, onAbort, onError. Use for analytics, event firing, tool caching (toolCacheMiddleware), logging, and tracing. Middleware array in chat() config, left-to-right execution order. NOT onEnd/onFinish callbacks on chat() — use middleware."
  - id: "@tanstack/ai#ai-core/structured-outputs"
    run: "bunx @tanstack/intent@latest load @tanstack/ai#ai-core/structured-outputs"
    for: "Type-safe JSON schema responses from LLMs using outputSchema on chat() and useChat(). Supports Zod, ArkType, and Valibot schemas. The adapter handles provider-specific strategies transparently — never configure structured output at the provider level. Pass stream:true alongside outputSchema for incremental JSON deltas + a terminal validated object via the `structured-output.complete` event. Every assistant turn in useChat carries its own typed `StructuredOutputPart` on `messages[i].parts`, so multi-turn structured chats preserve history automatically — partial/final derive from the latest assistant turn's part. convertSchemaToJsonSchema() for manual schema conversion."
  - id: "@tanstack/ai#ai-core/tool-calling"
    run: "bunx @tanstack/intent@latest load @tanstack/ai#ai-core/tool-calling"
    for: "Isomorphic tool system: toolDefinition() with Zod schemas, .server() and .client() implementations, passing tools to both chat() on server and useChat/clientTools on client, tool approval flows with needsApproval and addToolApprovalResponse(), lazy tool discovery with lazy:true, rendering ToolCallPart and ToolResultPart in UI."
  - id: "@tanstack/devtools#devtools-app-setup"
    run: "bunx @tanstack/intent@latest load @tanstack/devtools#devtools-app-setup"
    for: "Install TanStack Devtools, pick framework adapter (React/Vue/Solid/Preact), register plugins via plugins prop, configure shell (position, hotkeys, theme, hideUntilHover, requireUrlFlag, eventBusConfig). TanStackDevtools component, defaultOpen, localStorage persistence."
  - id: "@tanstack/devtools#devtools-marketplace"
    run: "bunx @tanstack/intent@latest load @tanstack/devtools#devtools-marketplace"
    for: "Publish plugin to npm and submit to TanStack Devtools Marketplace. PluginMetadata registry format, plugin-registry.ts, pluginImport (importName, type), requires (packageName, minVersion), framework tagging, multi-framework submissions, featured plugins."
  - id: "@tanstack/devtools#devtools-plugin-panel"
    run: "bunx @tanstack/intent@latest load @tanstack/devtools#devtools-plugin-panel"
    for: "Build devtools panel components that display emitted event data. Listen via EventClient.on(), handle theme (light/dark), use @tanstack/devtools-ui components. Plugin registration (name, render, id, defaultOpen), lifecycle (mount, activate, destroy), max 3 active plugins. Two paths: Solid.js core with devtools-ui for multi-framework support, or framework-specific panels."
  - id: "@tanstack/devtools#devtools-production"
    run: "bunx @tanstack/intent@latest load @tanstack/devtools#devtools-production"
    for: "Handle devtools in production vs development. removeDevtoolsOnBuild, devDependency vs regular dependency, conditional imports, NoOp plugin variants for tree-shaking, non-Vite production exclusion patterns."
  - id: "@tanstack/devtools-event-client#devtools-bidirectional"
    run: "bunx @tanstack/intent@latest load @tanstack/devtools-event-client#devtools-bidirectional"
    for: "Two-way event patterns between devtools panel and application. App-to-devtools observation, devtools-to-app commands, time-travel debugging with snapshots and revert. structuredClone for snapshot safety, distinct event suffixes for observation vs commands, serializable payloads only."
  - id: "@tanstack/devtools-event-client#devtools-event-client"
    run: "bunx @tanstack/intent@latest load @tanstack/devtools-event-client#devtools-event-client"
    for: "Create typed EventClient for a library. Define event maps with typed payloads, pluginId auto-prepend namespacing, emit()/on()/onAll()/onAllPluginEvents() API. Connection lifecycle (5 retries, 300ms), event queuing, enabled/disabled state, SSR fallbacks, singleton pattern. Unique pluginId requirement to avoid event collisions."
  - id: "@tanstack/devtools-event-client#devtools-instrumentation"
    run: "bunx @tanstack/intent@latest load @tanstack/devtools-event-client#devtools-instrumentation"
    for: "Analyze library codebase for critical architecture and debugging points, add strategic event emissions. Identify middleware boundaries, state transitions, lifecycle hooks. Consolidate events (1 not 15), debounce high-frequency updates, DRY shared payload fields, guard emit() for production. Transparent server/client event bridging."
  - id: "@tanstack/devtools-vite#devtools-vite-plugin"
    run: "bunx @tanstack/intent@latest load @tanstack/devtools-vite#devtools-vite-plugin"
    for: "Configure @tanstack/devtools-vite for source inspection (data-tsd-source, inspectHotkey, ignore patterns), console piping (client-to-server, server-to-client, levels), enhanced logging, server event bus (port, host, HTTPS), production stripping (removeDevtoolsOnBuild), editor integration (launch-editor, custom editor.open). Must be FIRST plugin in Vite config. Vite ^6 || ^7 only."
  - id: "@tanstack/react-start#lifecycle/migrate-from-nextjs"
    run: "bunx @tanstack/intent@latest load @tanstack/react-start#lifecycle/migrate-from-nextjs"
    for: "Step-by-step migration from Next.js App Router to TanStack Start: route definition conversion, API mapping, server function conversion from Server Actions, middleware conversion, data fetching pattern changes."
  - id: "@tanstack/react-start#react-start"
    run: "bunx @tanstack/intent@latest load @tanstack/react-start#react-start"
    for: "React bindings for TanStack Start: createStart, StartClient, StartServer, React-specific imports, re-exports from @tanstack/react-router, full project setup with React, useServerFn hook."
  - id: "@tanstack/react-start#react-start/server-components"
    run: "bunx @tanstack/intent@latest load @tanstack/react-start#react-start/server-components"
    for: "Implement, review, debug, and refactor TanStack Start React Server Components in React 19 apps. Use when tasks mention @tanstack/react-start/rsc, renderServerComponent, createCompositeComponent, CompositeComponent, renderToReadableStream, createFromReadableStream, createFromFetch, Composite Components, React Flight streams, loader or query owned RSC caching, router.invalidate, structuralSharing: false, selective SSR, stale names like renderRsc or .validator, or migration from Next App Router RSC patterns. Do not use for generic SSR or non-TanStack RSC frameworks except brief comparison."
  - id: "@tanstack/router-core#router-core"
    run: "bunx @tanstack/intent@latest load @tanstack/router-core#router-core"
    for: "Framework-agnostic core concepts for TanStack Router: route trees, createRouter, createRoute, createRootRoute, createRootRouteWithContext, addChildren, Register type declaration, route matching, route sorting, file naming conventions. Entry point for all router skills."
  - id: "@tanstack/router-core#router-core/auth-and-guards"
    run: "bunx @tanstack/intent@latest load @tanstack/router-core#router-core/auth-and-guards"
    for: "Route protection with beforeLoad, redirect()/throw redirect(), isRedirect helper, authenticated layout routes (_authenticated), non-redirect auth (inline login), RBAC with roles and permissions, auth provider integration (Auth0, Clerk, Supabase), router context for auth state."
  - id: "@tanstack/router-core#router-core/code-splitting"
    run: "bunx @tanstack/intent@latest load @tanstack/router-core#router-core/code-splitting"
    for: "Automatic code splitting (autoCodeSplitting), .lazy.tsx convention, createLazyFileRoute, createLazyRoute, lazyRouteComponent, getRouteApi for typed hooks in split files, codeSplitGroupings per-route override, splitBehavior programmatic config, critical vs non-critical properties."
  - id: "@tanstack/router-core#router-core/data-loading"
    run: "bunx @tanstack/intent@latest load @tanstack/router-core#router-core/data-loading"
    for: "Route loader option, loaderDeps for cache keys, staleTime/gcTime/ defaultPreloadStaleTime SWR caching, pendingComponent/pendingMs/ pendingMinMs, errorComponent/onError/onCatch, beforeLoad, router context and createRootRouteWithContext DI pattern, router.invalidate, Await component, deferred data loading with unawaited promises."
  - id: "@tanstack/router-core#router-core/navigation"
    run: "bunx @tanstack/intent@latest load @tanstack/router-core#router-core/navigation"
    for: "Link component, useNavigate, Navigate component, router.navigate, ToOptions/NavigateOptions/LinkOptions, from/to relative navigation, activeOptions/activeProps, preloading (intent/viewport/render), preloadDelay, navigation blocking (useBlocker, Block), createLink, linkOptions helper, scroll restoration, MatchRoute."
  - id: "@tanstack/router-core#router-core/not-found-and-errors"
    run: "bunx @tanstack/intent@latest load @tanstack/router-core#router-core/not-found-and-errors"
    for: "notFound() function, notFoundComponent, defaultNotFoundComponent, notFoundMode (fuzzy/root), errorComponent, CatchBoundary, CatchNotFound, isNotFound, NotFoundRoute (deprecated), route masking (mask option, createRouteMask, unmaskOnReload)."
  - id: "@tanstack/router-core#router-core/path-params"
    run: "bunx @tanstack/intent@latest load @tanstack/router-core#router-core/path-params"
    for: "Dynamic path segments ($paramName), splat routes ($ / _splat), optional params ({-$paramName}), prefix/suffix patterns ({$param}.ext), useParams, params.parse/stringify, pathParamsAllowedCharacters, i18n locale patterns."
  - id: "@tanstack/router-core#router-core/search-params"
    run: "bunx @tanstack/intent@latest load @tanstack/router-core#router-core/search-params"
    for: "validateSearch, search param validation with Zod/Valibot/ArkType adapters, fallback(), search middlewares (retainSearchParams, stripSearchParams), custom serialization (parseSearch, stringifySearch), search param inheritance, loaderDeps for cache keys, reading and writing search params."
  - id: "@tanstack/router-core#router-core/ssr"
    run: "bunx @tanstack/intent@latest load @tanstack/router-core#router-core/ssr"
    for: "Non-streaming and streaming SSR, RouterClient/RouterServer, renderRouterToString/renderRouterToStream, createRequestHandler, defaultRenderHandler/defaultStreamHandler, HeadContent/Scripts components, head route option (meta/links/styles/scripts), ScriptOnce, automatic loader dehydration/hydration, memory history on server, data serialization, document head management."
  - id: "@tanstack/router-core#router-core/type-safety"
    run: "bunx @tanstack/intent@latest load @tanstack/router-core#router-core/type-safety"
    for: "Full type inference philosophy (never cast, never annotate inferred values), Register module declaration, from narrowing on hooks and Link, strict:false for shared components, getRouteApi for code-split typed access, addChildren with object syntax for TS perf, LinkProps and ValidateLinkOptions type utilities, as const satisfies pattern."
  - id: "@tanstack/router-plugin#router-plugin"
    run: "bunx @tanstack/intent@latest load @tanstack/router-plugin#router-plugin"
    for: "TanStack Router bundler plugin for route generation and automatic code splitting. Supports Vite, Webpack, Rspack, and esbuild. Configures autoCodeSplitting, routesDirectory, target framework, and code split groupings."
  - id: "@tanstack/start-client-core#start-core"
    run: "bunx @tanstack/intent@latest load @tanstack/start-client-core#start-core"
    for: "Core overview for TanStack Start: tanstackStart() Vite plugin, getRouter() factory, root route document shell (HeadContent, Scripts, Outlet), client/server entry points, routeTree.gen.ts, tsconfig configuration. Entry point for all Start skills."
  - id: "@tanstack/start-client-core#start-core/auth-server-primitives"
    run: "bunx @tanstack/intent@latest load @tanstack/start-client-core#start-core/auth-server-primitives"
    for: "Server-side authentication primitives for TanStack Start: session cookies (HttpOnly, Secure, SameSite, __Host- prefix), session read/issue/destroy via createServerFn and middleware, OAuth authorization-code flow with state and PKCE, password-reset enumeration defense, CSRF for non-GET RPCs, rate limiting auth endpoints, session rotation on privilege change. Pairs with router-core/auth-and-guards for the routing side."
  - id: "@tanstack/start-client-core#start-core/deployment"
    run: "bunx @tanstack/intent@latest load @tanstack/start-client-core#start-core/deployment"
    for: "Deploy to Cloudflare Workers, Netlify, Vercel, Node.js/Docker, Bun, Railway. Selective SSR (ssr option per route), SPA mode, static prerendering, ISR with Cache-Control headers, SEO and head management."
  - id: "@tanstack/start-client-core#start-core/execution-model"
    run: "bunx @tanstack/intent@latest load @tanstack/start-client-core#start-core/execution-model"
    for: "Isomorphic-by-default principle, environment boundary functions (createServerFn, createServerOnlyFn, createClientOnlyFn, createIsomorphicFn), ClientOnly component, useHydrated hook, import protection, dead code elimination, environment variable safety (VITE_ prefix, process.env)."
  - id: "@tanstack/start-client-core#start-core/middleware"
    run: "bunx @tanstack/intent@latest load @tanstack/start-client-core#start-core/middleware"
    for: "createMiddleware, request middleware (.server only), server function middleware (.client + .server), context passing via next({ context }), sendContext for client-server transfer, global middleware via createStart in src/start.ts, middleware factories, method order enforcement, fetch override precedence."
  - id: "@tanstack/start-client-core#start-core/server-functions"
    run: "bunx @tanstack/intent@latest load @tanstack/start-client-core#start-core/server-functions"
    for: "createServerFn (GET/POST), validator (Zod or function), useServerFn hook, server context utilities (getRequest, getRequestHeader, setResponseHeader, setResponseStatus), error handling (throw errors, redirect, notFound), streaming, FormData handling, file organization (.functions.ts, .server.ts)."
  - id: "@tanstack/start-client-core#start-core/server-routes"
    run: "bunx @tanstack/intent@latest load @tanstack/start-client-core#start-core/server-routes"
    for: "Server-side API endpoints using the server property on createFileRoute, HTTP method handlers (GET, POST, PUT, DELETE), createHandlers for per-handler middleware, handler context (request, params, context), request body parsing, response helpers, file naming for API routes."
  - id: "@tanstack/start-server-core#start-server-core"
    run: "bunx @tanstack/intent@latest load @tanstack/start-server-core#start-server-core"
    for: "Server-side runtime for TanStack Start: createStartHandler, request/response utilities (getRequest, setResponseHeader, setCookie, getCookie, useSession), three-phase request handling, AsyncLocalStorage context."
  - id: "@tanstack/virtual-file-routes#virtual-file-routes"
    run: "bunx @tanstack/intent@latest load @tanstack/virtual-file-routes#virtual-file-routes"
    for: "Programmatic route tree building as an alternative to filesystem conventions: rootRoute, index, route, layout, physical, defineVirtualSubtreeConfig. Use with TanStack Router plugin's virtualRouteConfig option."
  - id: "dotenv#dotenv"
    run: "bunx @tanstack/intent@latest load dotenv#dotenv"
    for: "Load environment variables from a .env file into process.env for Node.js applications. Use when configuring apps with secrets, setting up local development environments, managing API keys and database uRLs, parsing .env file contents, or populating environment variables programmatically. Always use this skill when the user mentions .env, even for simple tasks like \"set up dotenv\" — the skill contains critical gotchas (encrypted keys, variable expansion, command substitution) that prevent common production issues."
  - id: "dotenv#dotenvx"
    run: "bunx @tanstack/intent@latest load dotenv#dotenvx"
    for: "Use dotenvx to run commands with environment variables, manage multiple .env files, expand variables, and encrypt env files for safe commits and CI/CD."
<!-- intent-skills:end -->

# UI/UX

- All UI/UX should preferably be built with shadcn/ui components. Before hand-rolling custom UI, search the shadcn registries (via the shadcn MCP tools) for an existing component and install it with `bunx shadcn@latest add <component>`.

# Project Architecture

Use Ports and Adapters (hexagonal architecture) for backend and integration
code. Keep the dependency direction pointing inward: transport and provider
adapters may depend on application and domain code, but application and domain
code must not depend on frameworks, SDKs, databases, or provider-specific
types.

## Layers and Responsibilities

- **Domain and shared types** define provider-neutral values, errors, and
  invariants. They must not import TanStack Start, Convex, Clerk, AWS SDKs, or
  other infrastructure packages.
- **Ports** are small TypeScript interfaces describing capabilities the
  application actually needs. Define ports from application requirements, not
  by copying a vendor SDK.
- **Application services** implement use cases and orchestration. Composite
  workflows such as move-by-prefix, recursive deletion, authorization-aware
  operations, batching, and partial-failure handling belong here rather than in
  provider adapters.
- **Outbound adapters** implement ports for infrastructure providers such as
  S3, Convex, or external APIs. Adapters translate provider inputs, outputs, and
  errors into application-owned types; provider SDK types must not escape the
  adapter.
- **Inbound adapters** such as TanStack server functions, server routes, and
  Convex functions validate transport input, authenticate and authorize the
  caller, invoke an application service, and serialize its result. They must
  not contain provider orchestration or instantiate SDK clients.
- **Composition roots** construct concrete adapters and inject them into
  application services. Read environment configuration and select providers in
  server-only composition-root modules, not in domain or application code.

Prefer feature-first organization for UI code and capability-first
organization for server integrations. For example:

```text
src/
  features/<feature>/          # Client-facing components, hooks, and schemas
  functions/*.functions.ts     # TanStack server-function inbound adapters
  server/<capability>/
    <port>.ts                  # Provider-neutral ports, types, and errors
    <use-case>.server.ts       # Application services
    <capability>.server.ts     # Composition root
    providers/<provider>/      # Outbound adapters
```

Use `.server.ts` for secrets, SDK clients, provider adapters, and other
server-only implementation. Keep client-safe schemas and transport types in
files without the `.server` suffix. Convex queries, mutations, and actions are
inbound adapters; keep reusable business workflows in plain TypeScript helpers
or application services instead of coupling them to a Convex context.

Do not introduce a port, adapter, factory, or abstraction until there is a real
application boundary to isolate. One port may have one implementation. Do not
mirror entire third-party SDKs, add a dependency-injection framework, or create
generic repository layers over already-purposeful ports.

## Result Types and Error Handling

Use `neverthrow` for operations that can fail. Expected failures must be
represented explicitly:

- Use `Result<T, E>` for synchronous operations.
- Use `ResultAsync<T, E>` for asynchronous operations instead of
  `Promise<Result<T, E>>`.
- Use `ok`, `err`, `okAsync`, `errAsync`, and
  `ResultAsync.fromPromise(..., mapError)` at exception-throwing boundaries.
- Compose workflows with `map`, `mapErr`, `andThen`, `orElse`, and `match`
  instead of throwing and catching expected failures.
- Define application-owned discriminated error unions. Do not use bare
  `Error`, `unknown`, strings, or provider exception classes as a public error
  type.
- Adapters must catch or wrap provider promise rejections and translate them
  into typed application errors. Public error messages must be
  provider-neutral and must not contain raw SDK error text, credentials,
  provider configuration, response bodies, request IDs, stack traces, or
  signed values. Preserve the original exception as a server logging cause when
  useful, but do not expose it across trust boundaries.
- Reserve thrown exceptions for programmer errors, violated invariants, or
  truly unrecoverable defects.

`neverthrow` class instances are internal values. Before returning a result
through a TanStack server function, server route, Convex function, JSON API, or
other serialization boundary, convert it to a plain discriminated union:

```ts
type ApiResult<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E }
```

For bulk operations, distinguish failure of the overall operation from
per-item failures. Return `ResultAsync<BulkResult, OperationError>`, where an
`Ok` bulk result may contain both successful items and typed per-item failures.
Do not pretend multi-resource provider operations are transactional.

Test application services against fake or in-memory port implementations, and
run shared contract tests against each real adapter. Test observable port and
use-case behavior rather than SDK command construction details.

# AGENTS.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

## Project Workflow

### Read Before Editing

Before changing code:

- Read the relevant implementation, tests, configuration, and nearby documentation.
- Search the repository for existing patterns and reuse them.
- Consult authoritative documentation for the installed version of a dependency.
- Never invent APIs, configuration fields, file paths, or project conventions.
- Distinguish verified facts from assumptions.
- If an assumption could materially change the implementation, verify it or ask the user.
- Do not ask questions whose answers can be found safely in the repository or documentation.

### Define Success First

Before implementation, state:

- The behavior being changed.
- The files or subsystem expected to be affected.
- How the result will be verified.

For non-trivial work, use a short plan with a verification step for each outcome.

### Follow Existing Architecture

- Search for an existing implementation of similar behavior before introducing a new pattern.
- Follow established naming, file organization, error handling, state management, and testing conventions.
- Do not add abstractions, dependencies, utilities, or configuration unless required.
- Do not manually edit generated files unless the repository explicitly requires it.
- When generated output must change, update its source and run the appropriate generator.

### Keep Changes Surgical

- Every changed line must directly support the requested outcome.
- Do not reformat, rename, reorganize, or refactor unrelated code.
- Preserve user changes already present in the working tree.
- Inspect `git diff` before finishing.
- Remove only unused code or imports created by the current change.
- Never discard or overwrite existing work without explicit approval.

### Verification Is Mandatory for Code Changes

After changing application code, tests, configuration, dependencies, schemas, build tooling, or generated code:

1. Run `scripts/check.sh`.
2. Fix failures caused by the change.
3. Run `scripts/check.sh` again until it passes.
4. Inspect the final diff for accidental or unrelated changes.

Documentation-only changes do not require `scripts/check.sh`.

Do not claim completion unless `scripts/check.sh` passes.

If `scripts/check.sh` cannot run:

- Report the exact command and relevant failure.
- Explain whether the failure appears pre-existing or caused by the change.
- Run the narrowest applicable substitute checks.
- Describe the work as not fully verified.

Never weaken, skip, delete, or bypass checks merely to make verification pass.

### Test Behavior, Not Implementation Details

- Bug fixes should include a regression test when the project has a suitable test location.
- New behavior should test its observable contract and important failure cases.
- Prefer extending an existing test suite over creating a new testing pattern.
- Do not rewrite valid tests merely to accommodate an incorrect implementation.

### Dependencies and APIs

- Confirm the installed dependency version before relying on documentation.
- Prefer official, version-matched documentation and repository examples.
- Do not add or upgrade dependencies without explaining why existing dependencies are insufficient.
- Use the repository's existing package manager.
- Never manually modify a lockfile; regenerate it with the package manager.

### Security and Privacy

- Never print, commit, expose, or copy secrets.
- Do not read `.env` or credential files unless the task requires it.
- Validate authorization and trust boundaries for server-side changes.
- Treat user-controlled input as untrusted.
- Do not weaken authentication, authorization, validation, or security controls to fix a test.
- Do not send repository code or data to an external service without authorization.

### Database and Schema Safety

- Do not perform destructive migrations or data operations without explicit approval.
- Prefer backward-compatible, staged schema changes.
- Explain rollback and deployment-order requirements for migrations.
- Never assume production data matches fixtures or local development data.

### Completion Report

At completion, report:

- What changed.
- What was deliberately left unchanged.
- The verification commands and their results.
- Any remaining risks, assumptions, or follow-up work.

Be precise: distinguish "implemented," "tested," "verified," and "not verified."
