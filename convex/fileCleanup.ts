import { internalAction } from "./_generated/server"

export const run = internalAction({
  args: {},
  handler: async () => {
    const cleanupUrl = process.env.FILE_CLEANUP_URL
    const serviceSecret = process.env.FILE_SERVICE_SECRET
    if (!cleanupUrl || !serviceSecret || serviceSecret.length < 32) {
      console.error("Scheduled file cleanup is not configured.")
      return
    }
    const response = await fetch(cleanupUrl, {
      method: "POST",
      headers: { "x-file-service-secret": serviceSecret },
    })
    if (!response.ok) {
      console.error(
        `Scheduled file cleanup failed with status ${response.status}.`
      )
    }
  },
})
