import type { Context } from "@opencode/plugin/promise/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { buildBlock, isModelEligible, parseOptions, type UserMark, type AssistantMark, type ToolMark } from "./core.ts"

const EPHEMERAL_ID = "msg_time_context_ephemeral"
const MAX_RECORDS = 64
const LOOKUP_TIMEOUT_MS = 1000

export interface V2Deps {
  context: Context["session"]["context"]
  options?: unknown
  now?: () => number
  hostTimezone?: string
  lookupTimeoutMs?: number
  log?: (message: string) => void
}

export function createV2ContextHook(deps: V2Deps) {
  const { config, warnings } = parseOptions(deps.options)
  const timezone = config.timezone ?? deps.hostTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC"
  const log = (message: string) => {
    try { deps.log?.(message) } catch { /* diagnostics must not break requests */ }
  }
  for (const warning of warnings) log(`config: ${warning}`)

  return async (event: SessionContext): Promise<void> => {
    try {
      const messages = event.messages
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.id === EPHEMERAL_ID) messages.splice(i, 1)
      }
      if (!config.enabled || !messages.some((m) => m.role === "user")) return
      const decision = isModelEligible(config, event.model?.providerID, event.model?.id)
      if (!decision.eligible) {
        if (config.debug) log(`injection skipped: ${decision.reason}`)
        return
      }

      const users: UserMark[] = []
      const assistants: AssistantMark[] = []
      const tools: ToolMark[] = []
      const ids = new Set(messages.map((m) => m.id).filter(Boolean))
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        // V2 model messages have IDs but no times. Read active context (not the
        // full transcript), intersect request IDs, and never retain its bodies.
        const records = await Promise.race([
          deps.context({ sessionID: event.sessionID }, { signal: controller.signal }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort()
              reject(new Error("context lookup timeout"))
            }, deps.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS)
          }),
        ])
        for (const record of records.slice(-MAX_RECORDS)) {
          if (!ids.has(record.id)) continue
          if (record.type === "user") {
            users.push({ id: record.id, created: record.time.created })
          } else if (record.type === "assistant") {
            assistants.push({ id: record.id, created: record.time.created, completed: record.time.completed, mode: record.agent })
            for (const part of record.content) {
              if (part.type !== "tool" || !["completed", "error"].includes(part.state.status)) continue
              tools.push({ id: part.id, tool: part.name, end: part.time.completed, failed: part.state.status === "error" })
            }
          }
        }
      } catch {
        // Do not log error objects: upstream errors can contain conversation text.
        if (config.debug) log("history timestamps unavailable; using current time only")
      } finally {
        clearTimeout(timer)
      }

      const block = buildBlock({
        now: (deps.now ?? Date.now)(), timezone, users, assistants, tools,
        historyAnchorsLimit: config.historyAnchorsLimit, maxBlockChars: config.maxBlockChars,
      })
      messages.push({ id: EPHEMERAL_ID, role: "user", content: [{ type: "text", text: block }] })
      if (config.debug) log(`injected time-context block\n${block}`)
    } catch {
      log("failed to build time-context block")
    }
  }
}
