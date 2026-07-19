# Deferred authentication work

The first Clerk integration authenticates Clerk session tokens without storing
application users.

- Add Postgres/SQLx and an application-owned user table keyed by Clerk `sub`.
- Provision users idempotently on their first authenticated request.
- Add signed, idempotent Clerk webhooks only if profile synchronization becomes
  necessary.
- Add application-owned roles or Clerk organization authorization when product
  requirements exist.
- Add `CLERK_SECRET_KEY` only when Clerk Backend API calls are introduced.
- Reassess an official Rust SDK if Clerk publishes one.

## Clerk setup

Create separate development and production Clerk instances, enable the desired
sign-in and verification methods, and use session token version 2.

Set `CLERK_ISSUER` to the instance Frontend API origin. The provided
`FRONTEND_URL` is accepted as a temporary alias. Set
`CLERK_AUTHORIZED_PARTIES` to the application's exact origins, not the Clerk
Frontend API origin. The supplied `https://api.clerk.com` Backend API URL is not
needed for JWT verification.

Initialize the frontend with Clerk's official SDK and its publishable key. A
Vite frontend typically uses `VITE_CLERK_PUBLISHABLE_KEY`. In production, serve
the frontend and `/api` from the same origin. During local development, proxy
`/api` to `http://127.0.0.1:8080`.

Do not expose or commit `CLERK_SECRET_KEY`. This version does not require it.
