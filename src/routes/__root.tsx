import { ClerkProvider, useAuth } from "@clerk/tanstack-react-start"
import { auth } from "@clerk/tanstack-react-start/server"
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRouteWithContext,
  useRouteContext,
} from "@tanstack/react-router"
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools"
import { TanStackDevtools } from "@tanstack/react-devtools"
import { createServerFn } from "@tanstack/react-start"
import type { QueryClient } from "@tanstack/react-query"
import type { ConvexQueryClient } from "@convex-dev/react-query"
import { ConvexProviderWithClerk } from "convex/react-clerk"
import type { ConvexReactClient } from "convex/react"
import { TooltipProvider } from "@/components/ui/tooltip"

import appCss from "../styles.css?url"

const fetchClerkAuth = createServerFn({ method: "GET" }).handler(async () => {
  const { userId, getToken } = await auth()

  return {
    userId,
    token: await getToken(),
  }
})

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient
  convexClient: ConvexReactClient
  convexQueryClient: ConvexQueryClient
}>()({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "Untie",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  notFoundComponent: () => (
    <main className="container mx-auto p-4 pt-16">
      <h1>404</h1>
      <p>The requested page could not be found.</p>
    </main>
  ),
  beforeLoad: async ({ context }) => {
    const clerkAuth = await fetchClerkAuth()

    if (clerkAuth.token) {
      context.convexQueryClient.serverHttpClient?.setAuth(clerkAuth.token)
    }

    return clerkAuth
  },
  component: RootComponent,
  shellComponent: RootDocument,
})

function RootComponent() {
  const { convexClient } = useRouteContext({ from: Route.id })

  return (
    <ClerkProvider>
      <ConvexProviderWithClerk client={convexClient} useAuth={useAuth}>
        <TooltipProvider>
          <Outlet />
        </TooltipProvider>
      </ConvexProviderWithClerk>
    </ClerkProvider>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <TanStackDevtools
          config={{
            position: "bottom-right",
          }}
          plugins={[
            {
              name: "Tanstack Router",
              render: <TanStackRouterDevtoolsPanel />,
            },
          ]}
        />
        <Scripts />
      </body>
    </html>
  )
}
