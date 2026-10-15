import type { Plugin } from "@opencode/plugin/promise/plugin"
import { createV2ContextHook } from "./src/plugin.v2.ts"

export default {
  id: "opencode-time-context",
  async setup(ctx) {
    // Only primary requests, including subagents; auxiliary hooks are separate.
    const registration = await ctx.session.hook("context", createV2ContextHook({
      context: (...args) => ctx.session.context(...args),
      options: ctx.options,
      log: (message) => console.warn(`[time-context] ${message}`),
    }))
    return () => registration.dispose()
  },
} satisfies Plugin
