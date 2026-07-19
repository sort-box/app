import { describe, expect, it } from "vitest"

import { cn } from "./utils"

describe("cn", () => {
  it("merges Tailwind utility classes", () => {
    expect(cn("px-2", "px-4", { hidden: false })).toBe("px-4")
  })
})
