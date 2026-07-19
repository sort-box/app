# Repository Engineering Guide

This guide defines how features must be designed, implemented, reviewed, and
verified in this repository. It applies to every contributor and coding agent.

## Core principles

1. Never assume repository behavior, dependency APIs, database structure, or
   product requirements. Inspect the code, configuration, migrations, tests, and
   relevant documentation before making a decision.
2. When a requirement is ambiguous, first look for evidence in the repository.
   If the answer would materially change behavior and cannot be verified, ask
   for clarification instead of guessing.
3. Prefer the simplest design that preserves clear boundaries and can evolve.
   Abstract repeated concepts and genuine variation points, but do not introduce
   speculative traits, layers, factories, or generic frameworks.
4. Research established patterns and current official documentation before
   introducing an architectural approach or unfamiliar library. Record
   non-obvious tradeoffs in code comments or an architecture decision record.
5. Prefer maintained, well-scoped libraries over reimplementing security,
   protocols, parsing, cryptography, serialization, database pooling, or other
   established infrastructure. Evaluate maintenance, license, ecosystem fit,
   transitive cost, and whether the dependency actually reduces complexity.
6. Keep changes focused. Do not mix a feature with unrelated refactoring,
   formatting churn, or dependency upgrades.
7. Correctness, clarity, security, and operability take priority over cleverness.

## Project architecture

The server should remain a modular monolith until there is concrete evidence
that another deployment boundary is necessary. Organize code by business
feature, with explicit boundaries inside each feature:

```text
src/
├── main.rs              # process startup and graceful shutdown
├── lib.rs               # testable application construction
├── config.rs            # validated runtime configuration
├── state.rs             # cheap-to-clone application handles
├── telemetry.rs         # tracing and metrics initialization
├── http/                # shared HTTP concerns
├── db/                  # pool, migrations, and shared DB infrastructure
└── features/
    └── <feature>/
        ├── domain.rs    # entities, value objects, invariants
        ├── dto.rs       # API request and response types
        ├── repository.rs
        ├── service.rs   # use cases and transaction boundaries
        └── routes.rs    # HTTP transport adapter
```

Use this dependency direction:

```text
HTTP routes -> application service -> repository/external adapter
                     |
                  domain
```

- HTTP handlers extract and validate input, call one application use case, and
  translate its result into an HTTP response. They must not contain SQL or
  substantial business logic.
- Services coordinate business workflows and own database transaction
  boundaries.
- Domain types express business meaning and enforce invariants without depending
  on Axum, SQLx, or HTTP concepts.
- Repositories contain persistence queries and row-to-domain mapping. They do
  not decide HTTP status codes or commit independent transactions for a larger
  use case.
- DTOs, domain entities, and database rows are separate types when their
  responsibilities differ. Do not expose database models directly as the API.
- Dependencies point inward. Domain code must not import transport or database
  frameworks.

Do not create a trait merely to wrap every concrete type. Add an interface when
there are multiple implementations, a meaningful external boundary, or a
demonstrated testing/design need. Prefer composition over inheritance-like
frameworks and prefer explicit code over hidden global behavior.

Keep the project as one crate initially. Split crates only when independent
ownership, reuse, compile-time enforcement, or build behavior provides a
measurable benefit.

## Procedure for implementing a feature

### 1. Establish the facts

- Read the complete request and identify observable acceptance criteria.
- Inspect adjacent features, routes, domain types, migrations, configuration,
  tests, and error conventions.
- Check the working tree and preserve unrelated user changes.
- Verify dependency APIs and framework behavior against official documentation.
- Identify unknowns, failure cases, authorization rules, concurrency behavior,
  data ownership, and compatibility requirements.

Do not begin by copying an external architecture wholesale. Adapt established
patterns to the actual repository and explain any material new abstraction.

### 2. Design the smallest complete change

Before editing, determine:

- The endpoint contract: method, path, authentication, input, output, status
  codes, and stable error codes.
- Domain invariants and which layer enforces each one.
- Database changes, constraints, indexes, and transaction boundary.
- Expected concurrent behavior and idempotency requirements.
- External side effects and their failure/retry behavior.
- Unit, integration, and API tests needed for the happy path and failures.
- Logging, metrics, configuration, and operational impact.

Prefer extending an existing feature module over adding a parallel abstraction.
If a design decision is costly to reverse or affects multiple features, document
the decision and alternatives.

### 3. Model the domain and contract

- Use descriptive domain types instead of passing primitive strings and integers
  when values have validation or business meaning.
- Make invalid states difficult to represent. Validate at construction
  boundaries and repeat critical guarantees with database constraints.
- Define dedicated request and response DTOs. Never serialize secrets or
  internal database fields accidentally.
- Keep public API behavior backward compatible unless a breaking change is
  explicitly requested and versioned.
- Update the OpenAPI contract with the endpoint implementation.

### 4. Implement persistence safely

- Add forward-only, reviewable migrations. Never edit a migration that may
  already have been applied outside local development.
- Use parameterized, preferably compile-time checked SQL.
- Add database constraints for uniqueness, referential integrity, nullability,
  and other invariants that must survive races.
- Add indexes based on actual query predicates and ordering, not speculation.
- Avoid N+1 queries and unbounded result sets.
- Do not log SQL parameters that may contain secrets or personal data.

Database transactions are asynchronous but logically sequential:

- Begin, query, commit, and rollback using awaited database APIs.
- Place the transaction boundary in the service/use-case layer.
- Pass the same transaction through all repository operations that must be
  atomic.
- Never detach transaction work with `tokio::spawn`.
- Keep transactions short and do not hold one open during unrelated network
  calls.
- Treat commit as fallible and retry only explicitly retryable, idempotent
  operations.
- Use a transactional outbox for reliable events or external side effects that
  must follow a database commit.

### 5. Implement the HTTP boundary

- Keep handlers thin and typed.
- Validate path, query, headers, and body at the boundary.
- Enforce request size, pagination, and resource limits.
- Return the repository's standard structured error format. Hide internal error
  details while logging enough context to diagnose them.
- Use middleware for cross-cutting behavior such as authentication, request IDs,
  tracing, timeouts, CORS, and body limits.
- Do not weaken CORS, authentication, or authorization merely to make a test
  pass.

### 6. Handle async work correctly

- Use async libraries for I/O. Do not call blocking filesystem, network,
  database, or CPU-heavy work directly on Tokio worker threads.
- Use `spawn_blocking` only for unavoidable blocking or CPU-bound work and keep
  its concurrency bounded.
- Do not hold a mutex guard across `.await`.
- Use bounded channels and bounded concurrency to provide backpressure.
- Add timeouts and cancellation behavior to outbound operations.
- Propagate errors from spawned tasks or supervise them; do not silently discard
  task failures.
- Ensure background workers and the HTTP server shut down gracefully.

### 7. Test behavior, not implementation details

Add the lowest-cost test that proves each behavior:

- Domain unit tests for invariants and pure business rules.
- Service tests for workflows, authorization, and failure mapping.
- Repository integration tests against the real database engine.
- API tests through the constructed router for status, headers, and JSON.
- Concurrency tests for uniqueness races, conflicting updates, idempotency, and
  rollback behavior where relevant.
- Contract tests or generated-spec checks for OpenAPI changes.

Tests must cover the successful path, invalid input, missing resources,
conflicts, unauthorized/forbidden access, dependency failures, and transaction
rollback as applicable. A mock is not evidence that real SQL, constraints,
locking, or migrations work.

Every bug fix must include a regression test that fails before the fix and
passes after it, unless a test is technically impossible; document that
exception.

### 8. Verify the complete change

When implementation is finished, the coding agent must run the repository check
script from the repository root:

```sh
./scripts/check.sh
```

This script is the authoritative local quality gate. It verifies formatting,
compilation, Clippy with warnings denied, all tests, and documentation tests.
Do not replace it with a subset of its commands.

Run relevant integration tests and migration checks that require external
services. If any check cannot run, report exactly which check was skipped and
why. Do not claim success based only on compilation.

Review the final diff for accidental files, secrets, generated build output,
debug logging, unrelated edits, and missing documentation.

## Rust coding style

`rustfmt` is the source of truth for formatting. Do not manually align code in a
way that fights the formatter. Use stable formatting settings unless the
repository explicitly adopts nightly Rust.

Clippy is the standard Rust linter. All default Clippy warnings and compiler
warnings must pass with `-D warnings` before completion. Do not enable the entire
`clippy::restriction` group; select individual restriction lints only when they
express a deliberate project rule.

When suppressing a lint:

```rust
#[allow(clippy::some_lint)] // Reason this exception is correct and necessary.
```

Scope the exception as narrowly as possible. Never add crate-wide allowances
just to silence warnings.

Additional style rules:

- Follow standard Rust naming: `snake_case` functions/modules, `CamelCase`
  types/traits, and `SCREAMING_SNAKE_CASE` constants.
- Prefer small, cohesive functions named for intent.
- Prefer early returns and `?` over deeply nested control flow.
- Use exhaustive `match` when every state matters.
- Avoid `unwrap`, `expect`, `panic!`, `todo!`, and `unimplemented!` in production
  request paths. At startup, `expect` is acceptable only for an invariant that
  cannot be recovered from and must contain a precise diagnostic.
- Use typed errors with preserved sources. Do not use strings as the primary
  internal error model.
- Do not discard `Result`, task join results, or rollback/commit failures.
- Avoid cloning merely to satisfy the borrow checker without understanding
  ownership. Clone cheap handles such as pools and `Arc`s intentionally.
- Keep visibility minimal. Prefer private or `pub(crate)` over `pub`.
- Document public APIs and non-obvious invariants, safety requirements, and
  architectural reasons. Comments should explain why, not narrate syntax.
- `unsafe` code requires explicit justification, documented invariants, focused
  tests, and review. Prefer a proven safe library.
- Prefer structured `tracing` fields over formatted log strings.
- Never log credentials, tokens, cookies, authorization headers, or sensitive
  request bodies.

## Dependency policy

Before adding a crate:

1. Confirm the standard library and existing dependencies do not already solve
   the problem cleanly.
2. Read the crate's current official documentation.
3. Check maintenance activity, release history, license, security posture,
   transitive dependencies, feature flags, and compatibility with Tokio and the
   selected framework.
4. Enable only required features and disable unnecessary defaults where useful.
5. Add it with an official Cargo command such as `cargo add`, not by guessing a
   version.
6. Commit `Cargo.lock` for this application.

Never implement custom cryptography, password hashing, token parsing, TLS, URL
parsing, database pooling, or serialization when an established audited library
is appropriate.

## Security and operations checklist

For every feature, consider:

- Authentication and resource-level authorization
- Input validation and output encoding
- SQL injection and parameterization
- Secret and personal-data exposure
- Abuse limits, request sizes, pagination, and rate limiting
- Timeouts, retries with jitter, and retry amplification
- Idempotency for retried mutations
- Dependency failure and graceful degradation
- Health/readiness behavior
- Structured logs, request IDs, useful metrics, and trace context
- Graceful shutdown and in-flight request handling

Use least privilege for database roles and external credentials. Configuration
must be validated at startup, and secrets must come from the deployment
environment or a secret manager rather than source control.

## Definition of done

A feature is complete only when:

- Acceptance criteria are demonstrably satisfied.
- Architecture and naming fit existing repository patterns.
- Domain rules exist in the correct layer and critical rules have database
  enforcement.
- Errors are typed, stable at the API boundary, and safe for clients.
- Database work is atomic where required and concurrency behavior is considered.
- Tests cover success, relevant failures, and regressions.
- OpenAPI and user/developer documentation are updated.
- `./scripts/check.sh` has been run after the final code change and passes.
- The final diff is focused and contains no secrets, build artifacts, debug code,
  placeholders, or unrelated changes.
- Any assumptions, tradeoffs, skipped verification, or follow-up work are
  explicitly reported.
