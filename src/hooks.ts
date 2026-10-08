// Hook wiring for the opencode time-context plugin. Separated from the entry
// module because opencode's legacy module adapter registers EVERY function-valued
// export as a plugin; the entry must export only the plugin function itself.
//
// Injection point: `experimental.chat.messages.transform`, which fires once per
// model-visible request (initial call, tool continuations, retries) BEFORE the
// stored messages become model messages. The block is appended as a synthetic,
// request-only trailing message so that everything before it stays stable for
// provider-side KV prefix caching. (Injecting into `system[]` — the front of
// the prompt — changed second-resolution text invalidated the cache for the
// entire history on every turn.)

import {
  buildBlock,
  canonicalModelId,
  isModelEligible,
  isSaneTimestamp,
  parseOptions,
  type AssistantMark,
  type ToolMark,
  type UserMark,
} from "./core.ts"

// Distinguishes simultaneous registrations of this plugin inside one process
// in diagnostics; not used for any behavioral purpose.
let registrationCounter = 0

// Hidden opencode agents whose summaries must not receive the block. Detected
// via the in-flight assistant message's mode/summary flags from the event stream.
const AUX_AGENT_MODES: ReadonlySet<string> = new Set(["compaction", "title", "summary"])

// IDs for the appended request-only row. Never persisted; rebuilt per request.
const EPHEMERAL_MESSAGE_ID = "msg_time_context_ephemeral"
const EPHEMERAL_PART_ID = "prt_time_context_ephemeral"

interface SessionSignal {
  /** assistant message id -> mode, for assistant messages not yet completed. */
  pendingAssistants: Map<string, { mode: string; summary?: boolean }>
}

interface Registry {
  sessions: Map<string, SessionSignal>
}

const MAX_SESSIONS = 64

function newSessionSignal(): SessionSignal {
  return { pendingAssistants: new Map() }
}

function sessionSignal(registry: Registry, sessionID: string): SessionSignal {
  let entry = registry.sessions.get(sessionID)
  if (!entry) {
    entry = newSessionSignal()
    registry.sessions.set(sessionID, entry)
  }
  // LRU touch: re-insert so iteration order tracks recency.
  registry.sessions.delete(sessionID)
  registry.sessions.set(sessionID, entry)
  while (registry.sessions.size > MAX_SESSIONS) {
    const oldest = registry.sessions.keys().next().value
    if (oldest === undefined) break
    registry.sessions.delete(oldest)
  }
  return entry
}

/** True when only auxiliary/hidden agents have in-flight messages for this session. */
function onlyAuxiliaryPending(session: SessionSignal): boolean {
  if (session.pendingAssistants.size === 0) return false
  for (const pending of session.pendingAssistants.values()) {
    if (!AUX_AGENT_MODES.has(pending.mode) && !pending.summary) return false
  }
  return true
}

type LogLevel = "debug" | "info" | "warn" | "error"

// Minimal structural types describing only the surfaces this plugin consumes,
// so the core wiring stays testable with stubs instead of a live client.
interface LogClient {
  log(options: {
    body: { service: string; level: LogLevel; message: string; extra?: Record<string, unknown> }
  }): Promise<unknown>
}

export interface PluginDeps {
  client: { app: LogClient }
  options?: unknown
  /** opencode instance directory; diagnostics only. */
  directory?: string
  /** Clock source; injectable for tests. Must never be cached per session. */
  now?: () => number
  /** Host timezone override; injectable for tests. */
  hostTimezone?: string
}

// Payload row surfaces — one {info, parts} row per session message, covering only
// fields this plugin reads.
interface UserInfoLite {
  id: string
  sessionID: string
  role: "user"
  time: { created: number }
  agent?: string
  model?: { providerID: string; modelID: string; variant?: string }
}

interface AssistantInfoLite {
  id: string
  sessionID: string
  role: "assistant"
  time: { created: number; completed?: number }
  mode?: string
  summary?: boolean
}

interface ToolPartLite {
  id: string
  type: "tool"
  tool?: string
  state?: { status?: string; time?: { start: number; end?: number } }
}

interface PayloadRow {
  info?: UserInfoLite | AssistantInfoLite
  parts?: Array<ToolPartLite | { type: string; [key: string]: unknown }>
}

function asUserInfo(value: unknown): UserInfoLite | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const v = value as Record<string, unknown>
  if (v.role !== "user") return undefined
  if (typeof v.id !== "string" || typeof v.sessionID !== "string") return undefined
  const time = v.time as Record<string, unknown> | undefined
  if (!time || typeof time.created !== "number") return undefined
  const model = v.model as Record<string, unknown> | undefined
  return {
    id: v.id,
    sessionID: v.sessionID,
    role: "user",
    time: { created: time.created },
    agent: typeof v.agent === "string" ? v.agent : undefined,
    ...(model && typeof model.providerID === "string" && typeof model.modelID === "string"
      ? { model: { providerID: model.providerID, modelID: model.modelID } }
      : {}),
  }
}

function asAssistantInfo(value: unknown): AssistantInfoLite | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const v = value as Record<string, unknown>
  if (v.role !== "assistant") return undefined
  if (typeof v.id !== "string" || typeof v.sessionID !== "string") return undefined
  const time = v.time as Record<string, unknown> | undefined
  if (!time || typeof time.created !== "number") return undefined
  return {
    id: v.id,
    sessionID: v.sessionID,
    role: "assistant",
    time: { created: time.created, ...(typeof time.completed === "number" ? { completed: time.completed } : {}) },
    mode: typeof v.mode === "string" ? v.mode : undefined,
    summary: v.summary === true ? true : undefined,
  }
}

function asToolPart(value: unknown): ToolPartLite | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const v = value as Record<string, unknown>
  if (v.type !== "tool" || typeof v.id !== "string") return undefined
  const state = v.state as ToolPartLite["state"]
  return { id: v.id, type: "tool", tool: typeof v.tool === "string" ? v.tool : undefined, state }
}

function eventMessageInfo(value: unknown): { id: string; sessionID: string; mode: string; summary?: boolean; completed?: number } | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const v = value as Record<string, unknown>
  if (v.role !== "assistant") return undefined
  if (typeof v.id !== "string" || typeof v.sessionID !== "string") return undefined
  const time = v.time as Record<string, unknown> | undefined
  return {
    id: v.id,
    sessionID: v.sessionID,
    mode: typeof v.mode === "string" ? v.mode : "",
    summary: v.summary === true ? true : undefined,
    completed: time && typeof time.completed === "number" ? time.completed : undefined,
  }
}

export function createTimeContextHooks(deps: PluginDeps) {
  const { config, warnings } = parseOptions(deps.options)
  const registration = ++registrationCounter
  const now = deps.now ?? (() => Date.now())
  const hostTimezone = deps.hostTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC"
  const timezone = config.timezone ?? hostTimezone
  const registry: Registry = { sessions: new Map() }
  // De-dupe repeated filter diagnostics so tool-continuation bursts don't spam the log.
  const lastDecisionLog = new Map<string, boolean>()

  const log = (level: LogLevel, message: string, extra?: Record<string, unknown>) => {
    // Diagnostics must never throw nor contain prompt/conversation contents.
    try {
      void deps.client.app
        .log({ body: { service: "time-context", level, message, ...(extra ? { extra } : {}) } })
        .catch(() => {})
    } catch {
      // logging is best-effort
    }
  }

  for (const warning of warnings) log("warn", `config: ${warning}`)
  log("info", "loaded", {
    registration,
    directory: deps.directory,
    enabled: config.enabled,
    includeModels: config.includeModels,
    excludeModels: config.excludeModels,
    timezone,
    historyAnchorsLimit: config.historyAnchorsLimit,
    maxBlockChars: config.maxBlockChars,
  })

  function recordDecisionLog(sessionID: string, canonical: string | undefined, eligible: boolean, reason: string) {
    const key = `${sessionID}|${canonical ?? "unknown"}`
    if (lastDecisionLog.get(key) === eligible) return
    lastDecisionLog.set(key, eligible)
    if (!eligible) log("debug", `injection skipped: ${reason}`, { sessionID, model: canonical, registration })
  }

  return {
    // Bus events are delivered fire-and-forget; keep handlers cheap and pure.
    // Only pending-assistant modes are tracked — everything else about history
    // is derived per request from the transform payload itself.
    async event(input: { event: { type: string; properties?: unknown } }): Promise<void> {
      try {
        const event = input.event
        if (event.type === "session.deleted") {
          const props = event.properties as { info?: { id?: string }; sessionID?: string } | undefined
          const id = props?.info?.id ?? props?.sessionID
          if (id) registry.sessions.delete(id)
          return
        }
        if (event.type === "message.updated") {
          const info = eventMessageInfo((event.properties as { info?: unknown } | undefined)?.info)
          if (!info) return
          const session = sessionSignal(registry, info.sessionID)
          if (isSaneTimestamp(info.completed)) {
            session.pendingAssistants.delete(info.id)
          } else {
            session.pendingAssistants.set(info.id, { mode: info.mode, summary: info.summary })
          }
          return
        }
        if (event.type === "message.removed") {
          const props = event.properties as { sessionID?: string; messageID?: string } | undefined
          if (props?.sessionID && props.messageID) {
            registry.sessions.get(props.sessionID)?.pendingAssistants.delete(props.messageID)
          }
          return
        }
      } catch {
        // fail open: events must never break the session
      }
    },

    // opencode 1.18.35 invokes this per model-visible request, before the
    // stored messages are converted for the provider. The block is appended as
    // a synthetic trailing user message so the front of the prompt (system +
    // full history) stays byte-stable for prefix caching; the appended row is
    // not persisted anywhere.
    async "experimental.chat.messages.transform"(
      input: {},
      output: { messages: Array<PayloadRow> },
    ): Promise<void> {
      try {
        if (!config.enabled) return
        const messages = output.messages
        if (!Array.isArray(messages) || messages.length === 0) return

        // Never stack duplicates if this payload object was already transformed.
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i]?.info?.id === EPHEMERAL_MESSAGE_ID) messages.splice(i, 1)
        }

        const sessionID = [...messages].reverse().map((row) => row.info?.sessionID).find((s) => typeof s === "string")
        if (!sessionID) return

        // Gate on the session's in-flight assistant modes when known, so the
        // compaction/summary summarizer prompts don't get a trailing block.
        const signal = registry.sessions.get(sessionID)
        if (signal && onlyAuxiliaryPending(signal)) return

        // Model identity for THIS turn is the latest user message's model;
        // opencode snapshots it at admission, so mid-session switches and
        // subagent model choices are honored on the very next request.
        const lastUserInfo = [...messages].reverse().map((row) => row.info && asUserInfo(row.info)).find(Boolean)
        if (!lastUserInfo) return
        const providerID = lastUserInfo.model?.providerID
        const modelID = lastUserInfo.model?.modelID
        const canonical = canonicalModelId(providerID, modelID)
        const decision = isModelEligible(config, providerID, modelID)
        if (!decision.eligible) {
          recordDecisionLog(sessionID, canonical, false, decision.reason)
          return
        }
        recordDecisionLog(sessionID, canonical, true, decision.reason)

        const current = now()
        const users: UserMark[] = []
        const assistants: AssistantMark[] = []
        const tools: ToolMark[] = []
        for (const row of messages) {
          if (row.info?.role === "user") {
            const info = asUserInfo(row.info)
            if (info) users.push({ id: info.id, created: info.time.created })
            continue
          }
          const info = asAssistantInfo(row.info)
          if (!info) continue
          assistants.push({
            id: info.id,
            created: info.time.created,
            completed: info.time.completed,
            mode: info.mode ?? "",
            summary: info.summary,
          })
          for (const part of row.parts ?? []) {
            const tool = asToolPart(part)
            if (!tool) continue
            const status = tool.state?.status
            if (status !== "completed" && status !== "error") continue
            if (!isSaneTimestamp(tool.state?.time?.end)) continue
            tools.push({
              id: tool.id,
              tool: tool.tool ?? "unknown",
              end: tool.state!.time!.end!,
              failed: status === "error",
            })
          }
        }

        const block = buildBlock({
          now: current,
          timezone,
          users,
          assistants,
          tools,
          historyAnchorsLimit: config.historyAnchorsLimit,
          maxBlockChars: config.maxBlockChars,
        })

        messages.push({
          info: {
            id: EPHEMERAL_MESSAGE_ID,
            sessionID,
            role: "user",
            time: { created: current },
            agent: lastUserInfo.agent,
            model: lastUserInfo.model,
          },
          parts: [
            {
              id: EPHEMERAL_PART_ID,
              sessionID,
              messageID: EPHEMERAL_MESSAGE_ID,
              type: "text",
              text: block,
              synthetic: true,
            },
          ],
        })

        if (config.debug) {
          log("debug", "injected time-context block", {
            sessionID,
            model: canonical,
            chars: block.length,
            block,
          })
        }
      } catch (error) {
        // fail open: a bad request must never be caused by this plugin
        log("error", "failed to build time-context block", { error: String(error) })
      }
    },

    async dispose(): Promise<void> {
      registry.sessions.clear()
      lastDecisionLog.clear()
    },
  }
}

export type TimeContextHooks = ReturnType<typeof createTimeContextHooks>
