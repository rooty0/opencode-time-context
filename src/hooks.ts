// Hook wiring for the opencode time-context plugin. Separated from the entry
// module because opencode's legacy module adapter registers EVERY function-valued
// export as a plugin; the entry must export only the plugin function itself.

import {
  BLOCK_START,
  buildBlock,
  canonicalModelId,
  isModelEligible,
  isSaneTimestamp,
  parseOptions,
  type AssistantMark,
  type ToolMark,
  type UserMark,
} from "./core.ts"

// Hidden opencode agents whose in-flight requests skip injection.
const AUX_AGENT_MODES: ReadonlySet<string> = new Set(["compaction", "title", "summary"])

// Bounded mirror of a session's reliable message/event timestamps.
// Only IDs and times are stored here, never message text or tool content.
interface SessionClock {
  users: Map<string, UserMark>
  assistants: Map<string, AssistantMark>
  tools: Map<string, ToolMark>
  /** assistant message id -> mode, for messages with no recorded completion yet. */
  pendingAssistants: Map<string, { mode: string; summary?: boolean }>
  seed: "never" | "ok" | "failed"
  seeding?: Promise<void>
}

interface Registry {
  sessions: Map<string, SessionClock>
}

const MAX_SESSIONS = 64
const MAX_USERS_PER_SESSION = 50
const MAX_ASSISTANTS_PER_SESSION = 80
const MAX_TOOLS_PER_SESSION = 40
// Bounded read used to backfill timestamps for sessions resumed by a process
// that has not seen their events yet.
const SEED_FETCH_LIMIT = 64

function newSessionClock(): SessionClock {
  return {
    users: new Map(),
    assistants: new Map(),
    tools: new Map(),
    pendingAssistants: new Map(),
    seed: "never",
  }
}

function sessionClock(registry: Registry, sessionID: string): SessionClock {
  let entry = registry.sessions.get(sessionID)
  if (!entry) {
    entry = newSessionClock()
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

function trimMap<V>(map: Map<string, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

function recordUserMessage(session: SessionClock, mark: UserMark): void {
  if (!isSaneTimestamp(mark.created)) return
  session.users.set(mark.id, { id: mark.id, created: mark.created })
  trimMap(session.users, MAX_USERS_PER_SESSION)
}

function recordAssistantMessage(session: SessionClock, mark: AssistantMark): void {
  if (!isSaneTimestamp(mark.created)) return
  const existing = session.assistants.get(mark.id)
  session.assistants.set(mark.id, { ...mark, completed: mark.completed ?? existing?.completed })
  trimMap(session.assistants, MAX_ASSISTANTS_PER_SESSION)
  if (isSaneTimestamp(mark.completed)) {
    session.pendingAssistants.delete(mark.id)
  } else {
    session.pendingAssistants.set(mark.id, { mode: mark.mode, summary: mark.summary })
  }
}

function recordToolMark(session: SessionClock, mark: ToolMark): void {
  if (mark.end !== undefined && !isSaneTimestamp(mark.end)) return
  session.tools.set(mark.id, mark)
  trimMap(session.tools, MAX_TOOLS_PER_SESSION)
}

/** True when only auxiliary/hidden agents have in-flight messages for this session. */
function onlyAuxiliaryPending(session: SessionClock): boolean {
  if (session.pendingAssistants.size === 0) return false
  for (const pending of session.pendingAssistants.values()) {
    if (!AUX_AGENT_MODES.has(pending.mode) && !pending.summary) return false
  }
  return true
}

/** True when this session has any sign of life, i.e. is not a throwaway/synthetic id. */
function sessionLooksReal(session: SessionClock): boolean {
  return (
    session.users.size > 0 ||
    session.assistants.size > 0 ||
    session.tools.size > 0 ||
    session.pendingAssistants.size > 0
  )
}

type LogLevel = "debug" | "info" | "warn" | "error"

// Minimal structural types describing only the surfaces this plugin consumes,
// so the core wiring stays testable with stubs instead of a live client.
interface SessionMessagesClient {
  messages(options: {
    path: { id: string }
    query?: { limit?: number }
  }): Promise<{ data?: Array<{ info: unknown; parts: unknown[] }>; error?: unknown }>
}

interface LogClient {
  log(options: {
    body: { service: string; level: LogLevel; message: string; extra?: Record<string, unknown> }
  }): Promise<unknown>
}

export interface PluginDeps {
  client: { session: SessionMessagesClient; app: LogClient }
  options?: unknown
  /** opencode instance directory; diagnostics only. */
  directory?: string
  /** Clock source; injectable for tests. Must never be cached per session. */
  now?: () => number
  /** Host timezone override; injectable for tests. */
  hostTimezone?: string
}

interface MessageInfoLite {
  id: string
  sessionID: string
  role: "user" | "assistant"
  time: { created: number; completed?: number }
  agent?: string
  mode?: string
  summary?: boolean
}

interface ToolPartLite {
  id: string
  sessionID: string
  type: string
  tool?: string
  state?: { status?: string; time?: { start: number; end?: number } }
}

function asMessageInfo(value: unknown): MessageInfoLite | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const v = value as Record<string, unknown>
  if (typeof v.id !== "string" || typeof v.sessionID !== "string") return undefined
  if (v.role !== "user" && v.role !== "assistant") return undefined
  const time = v.time as Record<string, unknown> | undefined
  if (!time || typeof time.created !== "number") return undefined
  return {
    id: v.id,
    sessionID: v.sessionID,
    role: v.role,
    time: { created: time.created, ...(typeof time.completed === "number" ? { completed: time.completed } : {}) },
    agent: typeof v.agent === "string" ? v.agent : undefined,
    mode: typeof v.mode === "string" ? v.mode : undefined,
    summary: v.summary === true ? true : undefined,
  }
}

function asToolPart(value: unknown): ToolPartLite | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const v = value as Record<string, unknown>
  if (v.type !== "tool" || typeof v.id !== "string" || typeof v.sessionID !== "string") return undefined
  return v as unknown as ToolPartLite
}

// Distinguishes simultaneous registrations of this plugin inside one process
// in diagnostics; not used for any behavioral purpose.
let registrationCounter = 0

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

  function recordMessageInfo(info: MessageInfoLite): void {
    const session = sessionClock(registry, info.sessionID)
    if (info.role === "user") {
      recordUserMessage(session, { id: info.id, created: info.time.created })
      return
    }
    recordAssistantMessage(session, {
      id: info.id,
      created: info.time.created,
      completed: info.time.completed,
      mode: info.mode ?? info.agent ?? "",
      summary: info.summary,
    })
  }

  function recordToolPart(part: ToolPartLite): void {
    const status = part.state?.status
    if (status !== "completed" && status !== "error") return
    const time = part.state?.time
    if (!time || !isSaneTimestamp(time.end)) return
    recordToolMark(sessionClock(registry, part.sessionID), {
      id: part.id,
      tool: part.tool ?? "unknown",
      end: time.end,
      failed: status === "error",
    })
  }

  async function seed(session: SessionClock, sessionID: string): Promise<void> {
    if (session.seed !== "never") return
    session.seeding ??= (async () => {
      try {
        const res = await deps.client.session.messages({
          path: { id: sessionID },
          query: { limit: SEED_FETCH_LIMIT },
        })
        if (res.error) throw new Error("session.messages returned an error")
        for (const row of res.data ?? []) {
          const info = asMessageInfo(row.info)
          if (info) {
            // Backfill without replacing anything the event/chat hooks already saw.
            if (info.role === "user" && !session.users.has(info.id)) recordMessageInfo(info)
            if (info.role === "assistant" && !session.assistants.has(info.id)) recordMessageInfo(info)
          }
          for (const raw of row.parts ?? []) {
            const part = asToolPart(raw)
            if (part && !session.tools.has(part.id)) recordToolPart(part)
          }
        }
        session.seed = "ok"
      } catch {
        session.seed = "failed"
        log("warn", "could not fetch session message history; older timestamps will be omitted", {
          sessionID,
        })
      }
    })()
    await session.seeding
  }

  function recordDecisionLog(sessionID: string, canonical: string | undefined, eligible: boolean, reason: string) {
    const key = `${sessionID}|${canonical ?? "unknown"}`
    if (lastDecisionLog.get(key) === eligible) return
    lastDecisionLog.set(key, eligible)
    if (!eligible) log("debug", `injection skipped: ${reason}`, { sessionID, model: canonical, registration })
  }

  return {
    // Fired when a user message is admitted. The hook is awaited by opencode
    // before the session loop starts, so admission times are synchronous here.
    async "chat.message"(
      input: { sessionID: string },
      output: { message: { id: string; time?: { created?: number } } },
    ): Promise<void> {
      try {
        const created = output.message.time?.created
        if (!isSaneTimestamp(created)) return
        recordUserMessage(sessionClock(registry, input.sessionID), { id: output.message.id, created })
      } catch {
        // fail open: never block message admission
      }
    },

    // Bus events are delivered fire-and-forget; keep handlers cheap and pure.
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
          const info = asMessageInfo((event.properties as { info?: unknown } | undefined)?.info)
          if (info) recordMessageInfo(info)
          return
        }
        if (event.type === "message.removed") {
          const props = event.properties as { sessionID?: string; messageID?: string } | undefined
          if (props?.sessionID && props.messageID) {
            const session = registry.sessions.get(props.sessionID)
            session?.users.delete(props.messageID)
            session?.assistants.delete(props.messageID)
            session?.pendingAssistants.delete(props.messageID)
          }
          return
        }
        if (event.type === "message.part.updated") {
          const part = asToolPart((event.properties as { part?: unknown } | undefined)?.part)
          if (part) recordToolPart(part)
          return
        }
      } catch {
        // fail open: events must never break the session
      }
    },

    // opencode 1.18.35 invokes this inside LLMRequestPrep.prepare once per
    // model-visible request (initial call, tool continuations, retries), with
    // the request's session and model. Mutate `output.system` in place.
    async "experimental.chat.system.transform"(
      input: { sessionID?: string; model: { providerID?: string; id?: string } },
      output: { system: string[] },
    ): Promise<void> {
      try {
        if (!config.enabled) return

        const providerID = typeof input.model?.providerID === "string" ? input.model.providerID : undefined
        const modelID = typeof input.model?.id === "string" ? input.model.id : undefined
        const canonical = canonicalModelId(providerID, modelID)
        const decision = isModelEligible(config, providerID, modelID)
        if (!decision.eligible) {
          recordDecisionLog(input.sessionID ?? "<none>", canonical, false, decision.reason)
          return
        }
        recordDecisionLog(input.sessionID ?? "<none>", canonical, true, decision.reason)

        if (!input.sessionID) return // auxiliary request without a session (e.g. agent generation)

        const session = sessionClock(registry, input.sessionID)
        await seed(session, input.sessionID)

        if (onlyAuxiliaryPending(session)) return // compaction title/summary generation
        // Synthetic session ids (e.g. project-name generation) leave no trace
        // in the session store; skip them. A real session always reached us via
        // chat.message/events, so mirror-empty plus a resolved seed means "not
        // a real session". Mirror-empty plus a FAILED seed means the same in
        // practice, so skip rather than add noise to auxiliary calls.
        if (!sessionLooksReal(session)) return

        const current = now()
        const anchorsInput = {
          now: current,
          timezone,
          users: [...session.users.values()],
          assistants: [...session.assistants.values()],
          tools: [...session.tools.values()],
          historyAnchorsLimit: config.historyAnchorsLimit,
          maxBlockChars: config.maxBlockChars,
        }
        const block = buildBlock(anchorsInput)

        // Exactly one fresh block per request: replace a stale plugin-owned
        // entry if this output object was already transformed, and keep every
        // other plugin's content untouched.
        const stale = output.system.findIndex((s) => typeof s === "string" && s.includes(BLOCK_START))
        if (stale >= 0) output.system.splice(stale, 1)
        output.system.push(block)

        if (config.debug) {
          log("debug", "injected time-context block", {
            sessionID: input.sessionID,
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
