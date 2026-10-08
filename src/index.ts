// opencode-time-context: injects one fresh, compact time-context block into the
// system context of every primary agent model request. Model-agnostic by default;
// per-request model filtering is opt-in. See README.md for configuration.
//
// IMPORTANT: this module must export ONLY the plugin function. opencode 1.18.35
// registers every function-valued export as a plugin instance, so exporting
// helpers here would silently double-register hooks.

import type { Plugin } from "@opencode-ai/plugin"
import { createTimeContextHooks } from "./hooks.ts"

const pluginFn: Plugin = async (input, options) => {
  const hooks = createTimeContextHooks({ client: input.client, options, directory: input.directory })
  return hooks as unknown as Awaited<ReturnType<Plugin>>
}

export default pluginFn
