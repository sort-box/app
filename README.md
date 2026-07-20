# Untie

Untie is a Bun-powered TanStack Start application with Clerk authentication,
Convex realtime data, TanStack Query SSR, and shadcn/ui.

## Development

```bash
bun install
bunx convex dev
```

In a second terminal:

```bash
bun run dev
```

Open `http://localhost:3000`.

## Environment

Local development values live in `.env.local` and are intentionally ignored by
Git. The configured variables are:

```dotenv
VITE_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
VITE_CLERK_SIGN_IN_URL=/sign-in
VITE_CLERK_SIGN_UP_URL=/sign-up
VITE_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/
VITE_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/
CONVEX_DEPLOYMENT=
VITE_CONVEX_URL=
VITE_CONVEX_SITE_URL=
FILE_API_ORIGIN=http://localhost:3000
```

The Convex development deployment also has
`CLERK_JWT_ISSUER_DOMAIN` configured. Clerk session tokens include the
`aud: "convex"` claim required by `convex/auth.config.ts`.

### Private file API and R2 CORS

The `/api/files` REST endpoints accept authenticated, same-origin browser
requests only. Keep the R2 bucket private. Browser transfers use short-lived
presigned URLs, so configure the bucket CORS policy for the exact application
origin:

```json
[
  {
    "AllowedOrigins": ["https://app.example.com"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["Content-Type", "Content-Length"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Do not use `*` for `AllowedOrigins` in production.

After deploying the widened Convex schema, backfill legacy file paths, directory
entries, and usage ledgers with:

```bash
bunx convex run fileMigration:backfillFiles
```

The migration processes resumable batches and can safely be invoked again.

After deploying the unified usage and entitlement tables, migrate the legacy
file usage ledger with a dry run followed by the live migration:

```bash
bunx convex run migrations:backfillUnifiedFileUsage '{"dryRun":true}'
bunx convex run migrations:backfillUnifiedFileUsage
```

## Checks

```bash
bun run typecheck
bun run lint
bun run test
bun run build
```
