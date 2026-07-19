import { createFileRoute } from "@tanstack/react-router"
import {
  SignInButton,
  SignUpButton,
  UserButton,
} from "@clerk/tanstack-react-start"
import {
  Authenticated,
  AuthLoading,
  Unauthenticated,
  useQuery,
} from "convex/react"
import { ArrowRightIcon, CheckCircle2Icon } from "lucide-react"

import { api } from "../../convex/_generated/api"
import { AppSidebar } from "@/components/app-sidebar"
import { ChartAreaInteractive } from "@/components/chart-area-interactive"
import { DataTable } from "@/components/data-table"
import { SectionCards } from "@/components/section-cards"
import { SiteHeader } from "@/components/site-header"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import data from "@/app/dashboard/data.json"

export const Route = createFileRoute("/")({ component: App })

function App() {
  return (
    <>
      <AuthLoading>
        <LoadingScreen />
      </AuthLoading>
      <Unauthenticated>
        <Welcome />
      </Unauthenticated>
      <Authenticated>
        <Dashboard />
      </Authenticated>
    </>
  )
}

function Welcome() {
  return (
    <main className="grid min-h-svh place-items-center bg-muted/30 px-6">
      <section className="w-full max-w-xl space-y-8">
        <div className="flex size-11 items-center justify-center rounded-lg bg-primary text-lg font-semibold text-primary-foreground">
          U
        </div>
        <div className="space-y-4">
          <p className="text-sm font-medium text-muted-foreground">
            TanStack Start · Convex · Clerk
          </p>
          <h1 className="max-w-lg text-4xl font-semibold tracking-tight sm:text-5xl">
            Untie is ready to build.
          </h1>
          <p className="max-w-md text-base leading-7 text-muted-foreground">
            Authentication, realtime data, server rendering, and the shadcn
            component system are connected.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <SignUpButton>
            <Button size="lg">
              Create an account
              <ArrowRightIcon />
            </Button>
          </SignUpButton>
          <SignInButton>
            <Button size="lg" variant="outline">
              Sign in
            </Button>
          </SignInButton>
        </div>
      </section>
    </main>
  )
}

function Dashboard() {
  const status = useQuery(api.status.current)

  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 72)",
          "--header-height": "calc(var(--spacing) * 12)",
        } as React.CSSProperties
      }
    >
      <AppSidebar variant="inset" />
      <SidebarInset>
        <div className="flex items-center justify-between border-b pr-4">
          <SiteHeader />
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <CheckCircle2Icon className="size-3.5 text-emerald-600" />
            {status?.authenticated ? "Convex authenticated" : "Connecting"}
            <UserButton />
          </div>
        </div>
        <div className="flex flex-1 flex-col">
          <div className="@container/main flex flex-1 flex-col gap-2">
            <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
              <SectionCards />
              <div className="px-4 lg:px-6">
                <ChartAreaInteractive />
              </div>
              <DataTable data={data} />
            </div>
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

function LoadingScreen() {
  return (
    <main className="grid min-h-svh place-items-center px-6">
      <div className="w-full max-w-xl space-y-5">
        <Skeleton className="size-11 rounded-lg" />
        <Skeleton className="h-10 w-4/5" />
        <Skeleton className="h-5 w-3/5" />
        <Skeleton className="h-11 w-48" />
      </div>
    </main>
  )
}
