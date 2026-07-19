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
```

The Convex development deployment also has
`CLERK_JWT_ISSUER_DOMAIN` configured. Clerk session tokens include the
`aud: "convex"` claim required by `convex/auth.config.ts`.

## Checks

```bash
bun run typecheck
bun run lint
bun run test
bun run build
```
