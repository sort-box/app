import { cronJobs } from "convex/server"

import { internal } from "./_generated/api"

const crons = cronJobs()

crons.interval(
  "clean abandoned R2 uploads",
  { hours: 6 },
  internal.fileCleanup.run,
  {}
)

export default crons
