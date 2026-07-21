import { useState } from "react"
import { useMutation } from "convex/react"
import type { FunctionReturnType } from "convex/server"
import {
  ArrowRightIcon,
  CheckIcon,
  FolderTreeIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"

import { api } from "../../../convex/_generated/api"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"

type Plan = FunctionReturnType<
  typeof api.organizationPlans.listForConversation
>[number]

const statusLabels: Record<Plan["status"], string> = {
  draft: "Ready to review",
  superseded: "Superseded",
  applied: "Applied",
  rejected: "Rejected",
  stale: "Needs refresh",
  undone: "Undone",
  partially_undone: "Partially undone",
  failed: "Failed",
}

export function OrganizationPlanCard({
  plan,
  onRequestChanges,
  onFilesChanged,
}: {
  plan: Plan
  onRequestChanges: (planId: string, feedback: string) => void
  onFilesChanged: () => void
}) {
  const confirm = useMutation(api.organizationPlans.confirm)
  const reject = useMutation(api.organizationPlans.reject)
  const undo = useMutation(api.organizationPlans.undo)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [feedback, setFeedback] = useState("")
  const [pending, setPending] = useState<"confirm" | "reject" | "undo" | null>(
    null
  )

  const perform = async (
    action: "confirm" | "reject" | "undo",
    run: () => Promise<{ ok: boolean; error?: { message: string } }>
  ) => {
    setPending(action)
    try {
      const result = await run()
      if (!result.ok) {
        toast.error(
          result.error?.message ?? "The proposal could not be updated."
        )
        return
      }
      toast.success(
        action === "confirm"
          ? "Organization applied."
          : action === "undo"
            ? "Undo finished."
            : "Proposal rejected."
      )
      if (action !== "reject") onFilesChanged()
    } catch {
      toast.error("The proposal service is temporarily unavailable.")
    } finally {
      setPending(null)
    }
  }

  const files = plan.operations.filter((operation) => operation.kind === "file")
  const folders = plan.operations.length - files.length
  const draft = plan.status === "draft"

  return (
    <Card className="border border-border/70 shadow-none">
      <CardHeader>
        <div className="flex items-center gap-2 text-muted-foreground">
          <FolderTreeIcon className="size-4" />
          <span className="text-xs font-medium tracking-wide uppercase">
            Organization proposal
            {plan.revision > 1 ? ` · Revision ${plan.revision}` : ""}
          </span>
        </div>
        <CardTitle>{plan.summary}</CardTitle>
        <CardDescription>
          {files.length} {files.length === 1 ? "file" : "files"}
          {folders > 0
            ? ` and ${folders} ${folders === 1 ? "folder" : "folders"}`
            : ""}
        </CardDescription>
        <CardAction>
          <Badge variant={draft ? "default" : "secondary"}>
            {statusLabels[plan.status]}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Before</TableHead>
                <TableHead className="w-8">
                  <span className="sr-only">becomes</span>
                </TableHead>
                <TableHead>After</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plan.operations.map((operation) => (
                <TableRow key={operation.operationId}>
                  <TableCell className="max-w-64 truncate font-mono text-xs text-muted-foreground">
                    {operation.beforePath}
                  </TableCell>
                  <TableCell>
                    <ArrowRightIcon className="size-3.5 text-muted-foreground" />
                  </TableCell>
                  <TableCell className="max-w-64 truncate font-mono text-xs font-medium">
                    {operation.afterPath}
                    {operation.undoStatus === "skipped" && (
                      <span className="mt-1 block font-sans text-destructive">
                        {operation.undoReason}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {plan.warnings.length > 0 && (
          <div className="rounded-lg bg-muted px-3 py-2 text-xs leading-5 text-muted-foreground">
            {plan.warnings.join(" ")}
          </div>
        )}
      </CardContent>
      {(draft || plan.canUndo) && (
        <CardFooter className="gap-2 border-t">
          {draft && (
            <>
              <AlertDialog>
                <AlertDialogTrigger render={<Button size="sm" />}>
                  <CheckIcon /> Confirm
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Apply this exact plan?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Untie will first verify that every shown path is
                      unchanged. If anything is stale, no files move.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      disabled={pending !== null}
                      onClick={() =>
                        void perform("confirm", () =>
                          confirm({ planId: plan.planId })
                        )
                      }
                    >
                      Apply plan
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setFeedbackOpen(true)}
              >
                Request changes
              </Button>
            </>
          )}
          {plan.canUndo && (
            <Button
              size="sm"
              variant="outline"
              disabled={pending !== null}
              onClick={() =>
                void perform("undo", () => undo({ planId: plan.planId }))
              }
            >
              <RotateCcwIcon /> Undo
            </Button>
          )}
        </CardFooter>
      )}

      <Dialog open={feedbackOpen} onOpenChange={setFeedbackOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request a revised plan</DialogTitle>
            <DialogDescription>
              Explain what should change. The current plan will remain visible
              as a superseded revision.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder="For example: Put client work inside /Work/Clients."
            maxLength={2_000}
            className="min-h-28"
          />
          <DialogFooter className="justify-between sm:justify-between">
            <Button
              variant="ghost"
              disabled={pending !== null}
              onClick={() => {
                void perform("reject", () => reject({ planId: plan.planId }))
                setFeedbackOpen(false)
              }}
            >
              <XIcon /> Reject proposal
            </Button>
            <Button
              disabled={!feedback.trim()}
              onClick={() => {
                onRequestChanges(plan.planId, feedback.trim())
                setFeedback("")
                setFeedbackOpen(false)
              }}
            >
              Create revision
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
