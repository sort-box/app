import migrations from "@convex-dev/migrations/convex.config.js"
import rag from "@convex-dev/rag/convex.config.js"
import { defineApp } from "convex/server"
import { v } from "convex/values"

const app = defineApp({
  env: {
    CLOUDFLARE_ACCESS_KEY_ID: v.string(),
    CLOUDFLARE_R2_BUCKET_NAME: v.string(),
    CLOUDFLARE_R2_EUROPE_ENDPOINT: v.string(),
    CLOUDFLARE_SECRET_ACCESS_KEY: v.string(),
    FILE_SERVICE_SECRET: v.string(),
    VOYAGE_API_KEY: v.string(),
  },
})

app.use(migrations)
app.use(rag)

export default app
