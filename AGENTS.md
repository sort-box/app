# UI/UX

- All UI/UX should preferably be built with shadcn/ui components. Before hand-rolling custom UI, search the shadcn registries (via the shadcn MCP tools) for an existing component and install it with `bunx shadcn@latest add <component>`.

# Project Architecture

## Environment Variable Documentation

Whenever a new application environment variable is introduced, add it with an
empty example value and a concise comment to `.env.example`. Whenever a new
Convex deployment environment variable is introduced, document it in
`.env.example.convex`. Never place real secrets or deployment-specific values
in either example file.

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

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
