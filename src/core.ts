// Pure, dependency-free logic for the opencode time-context plugin.
// Everything here is testable with a fake clock and fabricated session data.

export const BLOCK_START = "[OpenCode time context]"
export const BLOCK_END = "[/OpenCode time context]"

// Hidden opencode agents whose in-flight requests must not receive the block.
const AUX_AGENT_MODES: ReadonlySet<string> = new Set(["compaction", "title", "summary"])

export interface PluginConfig {
  enabled: boolean
  includeModels: string[]
  excludeModels: string[]
  /** Validated IANA timezone, or undefined for the host's local timezone. */
  timezone: string | undefined
  historyAnchorsLimit: number
  maxBlockChars: number
  debug: boolean
}

export const DEFAULT_CONFIG: PluginConfig = {
  enabled: true,
  includeModels: [],
  excludeModels: [],
  timezone: undefined,
  historyAnchorsLimit: 6,
  maxBlockChars: 1500,
  debug: false,
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/**
 * Resolves raw plugin options (the tuple options from opencode.json `plugin`
 * entries) into a validated config. Unknown fields are ignored; invalid values
 * fall back to defaults with a warning so startup never breaks.
 */
export function parseOptions(raw: unknown): { config: PluginConfig; warnings: string[] } {
  const warnings: string[] = []
  const config: PluginConfig = { ...DEFAULT_CONFIG }
  if (raw === undefined || raw === null) return { config, warnings }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push("plugin options must be an object; all defaults are in effect")
    return { config, warnings }
  }
  const opts = raw as Record<string, unknown>

  if (opts.enabled !== undefined) {
    if (typeof opts.enabled === "boolean") config.enabled = opts.enabled
    else warnings.push('"enabled" must be a boolean; using default true')
  }

  const readList = (key: "includeModels" | "excludeModels"): string[] | undefined => {
    const value = opts[key]
    if (value === undefined) return undefined
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim() === "")) {
      warnings.push(`"${key}" must be an array of non-empty strings; ignoring it`)
      return []
    }
    return value as string[]
  }
  const include = readList("includeModels")
  if (include) config.includeModels = include
  const exclude = readList("excludeModels")
  if (exclude) config.excludeModels = exclude

  if (opts.timezone !== undefined) {
    if (typeof opts.timezone === "string" && isValidTimeZone(opts.timezone)) {
      config.timezone = opts.timezone
    } else {
      warnings.push(
        `"timezone" must be a valid IANA timezone name; got ${JSON.stringify(opts.timezone)}; using the host local timezone`,
      )
    }
  }

  if (opts.historyAnchorsLimit !== undefined) {
    if (typeof opts.historyAnchorsLimit === "number" && Number.isInteger(opts.historyAnchorsLimit) && opts.historyAnchorsLimit >= 0) {
      config.historyAnchorsLimit = Math.min(12, opts.historyAnchorsLimit)
    } else {
      warnings.push('"historyAnchorsLimit" must be a non-negative integer; using default 6')
    }
  }

  if (opts.maxBlockChars !== undefined) {
    if (typeof opts.maxBlockChars === "number" && Number.isInteger(opts.maxBlockChars) && opts.maxBlockChars > 0) {
      config.maxBlockChars = Math.max(300, Math.min(4000, opts.maxBlockChars))
    } else {
      warnings.push('"maxBlockChars" must be a positive integer; using default 1500')
    }
  }

  if (opts.debug !== undefined) {
    if (typeof opts.debug === "boolean") config.debug = opts.debug
    else warnings.push('"debug" must be a boolean; using default false')
  }

  return { config, warnings }
}

/**
 * Canonical per-request model identity. opencode's Model carries `providerID`
 * and `id` (the model ID); the canonical form is "providerID/modelID".
 */
export function canonicalModelId(providerID: string | undefined, modelID: string | undefined): string | undefined {
  if (!providerID || !modelID) return undefined
  return `${providerID}/${modelID}`
}

/**
 * Exact matching against model identity, case-sensitive, no substrings.
 * An entry matches when it equals either:
 * - the canonical "providerID/modelID" (e.g. "local-vllm/moonshotai/Kimi-K3"), or
 * - the model ID exactly (e.g. "moonshotai/Kimi-K3"), which matches that model on
 *   ANY provider — a documented convenience. Model IDs may themselves contain
 *   "/", so slash-containing entries get this comparison too.
 */
export function modelMatches(entry: string, providerID: string, modelID: string): boolean {
  return entry === `${providerID}/${modelID}` || entry === modelID
}

export interface FilterDecision {
  eligible: boolean
  reason: string
}

/**
 * Per-request eligibility. Exclusion wins over inclusion. Unknown identity
 * (missing provider/model IDs) is allowed only when no filters are configured,
 * and reported so the caller can log a diagnostic.
 */
export function isModelEligible(
  config: PluginConfig,
  providerID: string | undefined,
  modelID: string | undefined,
): FilterDecision {
  const canonical = canonicalModelId(providerID, modelID)
  const filtersEmpty = config.includeModels.length === 0 && config.excludeModels.length === 0
  if (!canonical) {
    if (filtersEmpty) return { eligible: true, reason: "no filters configured; unknown model identity allowed" }
    return {
      eligible: false,
      reason: "model identity unavailable; refusing to claim an unverified filter match",
    }
  }
  if (!filtersEmpty) {
    const included =
      config.includeModels.length === 0 ||
      config.includeModels.some((entry) => modelMatches(entry, providerID!, modelID!))
    if (!included) return { eligible: false, reason: `"${canonical}" not in includeModels` }
    const excluded = config.excludeModels.some((entry) => modelMatches(entry, providerID!, modelID!))
    if (excluded) return { eligible: false, reason: `"${canonical}" blocked by excludeModels` }
  }
  return { eligible: true, reason: filtersEmpty ? "no filters configured" : `"${canonical}" allowed by filters` }
}

/** Formatter cache: Intl.DateTimeFormat construction is comparatively expensive. */
const formatterCache = new Map<string, Intl.DateTimeFormat>()
function formatterFor(tz: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(tz)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    })
    formatterCache.set(tz, fmt)
  }
  return fmt
}

const dateKeyCache = new Map<string, Intl.DateTimeFormat>()
function dateKeyFormatterFor(tz: string): Intl.DateTimeFormat {
  let fmt = dateKeyCache.get(tz)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, dateStyle: "short" })
    dateKeyCache.set(tz, fmt)
  }
  return fmt
}

const weekdayCache = new Map<string, Intl.DateTimeFormat>()
/** "Thursday" — weekday names prevent models from botching date-to-weekday arithmetic. */
export function weekdayName(epochMs: number, tz: string): string {
  let fmt = weekdayCache.get(tz)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" })
    weekdayCache.set(tz, fmt)
  }
  return fmt.format(new Date(epochMs))
}

/** "America/Los_Angeles"-aware local date key, e.g. "2026-10-07". */
export function localDateKey(epochMs: number, tz: string): string {
  const parts = dateKeyFormatterFor(tz).formatToParts(new Date(epochMs))
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ""
  return `${get("year")}-${get("month")}-${get("day")}`
}

const OFFSET_PATTERN = /GMT([+-])(\d{1,2})(?::(\d{2}))?/

/** Numeric UTC offset valid for the given instant in the given IANA timezone, e.g. "-07:00". */
export function offsetFor(epochMs: number, tz: string): string {
  const name = formatterFor(tz)
    .formatToParts(new Date(epochMs))
    .find((p) => p.type === "timeZoneName")?.value
  const m = name?.match(OFFSET_PATTERN)
  if (m) {
    const hours = m[2]!.padStart(2, "0")
    const minutes = (m[3] ?? "00").padStart(2, "0")
    return `${m[1]}${hours}:${minutes}`
  }
  if (name === "GMT") return "+00:00"
  // Fallback: derive the offset by comparing the same instant rendered in UTC
  // and in the target zone. Handles environments with unusual timeZoneName strings.
  const date = new Date(epochMs)
  const utc = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  )
  const local = formatterFor(tz).formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(local.find((p) => p.type === type)?.value ?? 0)
  const asIfUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"))
  let minutes = Math.round((asIfUtc - utc) / 60000)
  const sign = minutes < 0 ? "-" : "+"
  minutes = Math.abs(minutes)
  return `${sign}${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`
}

/** e.g. "2026-10-07 20:31:00 -07:00" — local wall time with the offset valid for that instant. */
export function formatLocalTime(epochMs: number, tz: string): string {
  const parts = formatterFor(tz).formatToParts(new Date(epochMs))
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ""
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")} ${offsetFor(epochMs, tz)}`
}

/** e.g. "2026-10-08T03:31:00.000Z". */
export function formatUtc(epochMs: number): string {
  return new Date(epochMs).toISOString()
}

/**
 * Compact human duration, up to two units: "0 sec", "15 sec", "5 min 15 sec",
 * "1 hr 5 min", "2 days 3 hr". Negative input (clock skew) clamps to "0 sec".
 */
export function formatDuration(ms: number): string {
  let seconds = Math.round(ms / 1000)
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const units: Array<[label: string, size: number]> = [
    ["day", 86400],
    ["hr", 3600],
    ["min", 60],
    ["sec", 1],
  ]
  if (seconds === 0) return "0 sec"
  const out: string[] = []
  for (const [label, size] of units) {
    if (seconds < size) continue
    const count = Math.floor(seconds / size)
    seconds -= count * size
    const text = label === "day" ? (count === 1 ? "day" : "days") : label
    out.push(`${count} ${text}`)
    if (out.length === 2) break
  }
  return out.join(" ")
}

export function isSaneTimestamp(t: number | undefined | null): t is number {
  return typeof t === "number" && Number.isFinite(t) && t > 0
}

/** Anchors far into the future beyond this tolerance indicate bad data; drop them. */
const FUTURE_TOLERANCE_MS = 60_000

export interface UserMark {
  id: string
  created: number
}

export interface AssistantMark {
  id: string
  created: number
  completed?: number
  mode: string
  summary?: boolean
}

export interface ToolMark {
  id: string
  tool: string
  end?: number
  failed?: boolean
}

export interface Anchor {
  time: number
  label: string
}

/**
 * Picks a bounded, ordered timeline of recent reliable message/event anchors.
 * - Assistant anchors use completion time; aux agents (compaction/title/summary)
 *   and compaction summaries are excluded.
 * - Tool anchors use the recorded end time only when the tool settled.
 * - Records with invalid or implausible (far-future) times are excluded.
 * Returned ascending by time so the block reads chronologically.
 */
export function selectAnchors(
  users: UserMark[],
  assistants: AssistantMark[],
  tools: ToolMark[],
  limit: number,
  now: number,
  omit?: ReadonlyArray<Anchor>,
): Anchor[] {
  if (limit <= 0) return []
  const omitted = new Set((omit ?? []).map((a) => `${a.time}|${a.label}`))
  const candidates: Anchor[] = []
  for (const u of users) {
    if (!isSaneTimestamp(u.created) || u.created > now + FUTURE_TOLERANCE_MS) continue
    candidates.push({ time: u.created, label: "user message" })
  }
  for (const a of assistants) {
    if (AUX_AGENT_MODES.has(a.mode) || a.summary) continue
    if (!isSaneTimestamp(a.completed) || a.completed > now + FUTURE_TOLERANCE_MS) continue
    candidates.push({ time: a.completed, label: "assistant message completed" })
  }
  for (const t of tools) {
    if (!isSaneTimestamp(t.end) || t.end > now + FUTURE_TOLERANCE_MS) continue
    candidates.push({ time: t.end, label: t.failed ? `tool "${t.tool}" failed` : `tool "${t.tool}" finished` })
  }
  const seen = new Set<string>()
  const deduped = candidates.filter((a) => {
    const key = `${a.time}|${a.label}`
    if (omitted.has(key) || seen.has(key)) return false
    seen.add(key)
    return true
  })
  deduped.sort((a, b) => b.time - a.time)
  return deduped.slice(0, limit).sort((a, b) => a.time - b.time)
}

const TIMING_RULE =
  'Timing rule: use the timestamps above when you refer to how long ago something happened; conversation order alone does not tell you when events occurred. A message timestamp marks when that message was created, admitted, or completed, not when some external action finished. If timing is unknown, say "earlier" or "previously" rather than guessing "yesterday" or "last week".'

export interface BlockInput {
  now: number
  /** Effective timezone (explicit config or host-local), pre-validated IANA name. */
  timezone: string
  users: UserMark[]
  assistants: AssistantMark[]
  tools: ToolMark[]
  historyAnchorsLimit: number
  maxBlockChars: number
}

/**
 * Builds the single time-context block for one model request.
 * Omits lines whose times are unknown rather than fabricating history.
 * Never exceeds maxBlockChars: anchors are shed first, oldest dropped.
 */
export function buildBlock(input: BlockInput): string {
  const { now, timezone } = input
  const dateKey = localDateKey(now, timezone)

  const anchorAt = (time: number): string => {
    const t = formatLocalTime(time, timezone)
    // Same local day as "now": drop the date, keep "HH:MM:SS ±HH:MM".
    return localDateKey(time, timezone) === dateKey ? t.slice(t.indexOf(" ") + 1) : t
  }

  const saneUsers = input.users.filter((u) => isSaneTimestamp(u.created)).sort((a, b) => b.created - a.created)
  const latest = saneUsers[0]
  const previous = saneUsers[1]

  // Latest completed assistant message: when the previous model-visible turn
  // finished, per the assistant message's completed time.
  let latestAssistant: number | undefined
  for (const a of input.assistants) {
    if (AUX_AGENT_MODES.has(a.mode) || a.summary) continue
    if (!isSaneTimestamp(a.completed)) continue
    latestAssistant = latestAssistant === undefined ? a.completed : Math.max(latestAssistant, a.completed)
  }

  const lines: string[] = [
    BLOCK_START,
    `Now: ${formatLocalTime(now, timezone)} (${weekdayName(now, timezone)}, ${timezone})`,
    `UTC now: ${formatUtc(now)}`,
  ]

  const optional: string[] = []
  if (latest) {
    optional.push(`Latest user message: ${formatLocalTime(latest.created, timezone)} (${formatDuration(now - latest.created)} ago)`)
  }
  if (latest && previous) {
    optional.push(
      `Previous user message: ${formatLocalTime(previous.created, timezone)} (${formatDuration(latest.created - previous.created)} before latest)`,
    )
  }
  if (latestAssistant !== undefined) {
    optional.push(
      `Latest assistant completion: ${formatLocalTime(latestAssistant, timezone)} (${formatDuration(now - latestAssistant)} ago)`,
    )
  }

  // Headline lines already cover these two facts; don't restamp them in the timeline.
  const omit: Anchor[] = []
  if (latest) omit.push({ time: latest.created, label: "user message" })
  if (latestAssistant !== undefined) omit.push({ time: latestAssistant, label: "assistant message completed" })
  let anchors = selectAnchors(input.users, input.assistants, input.tools, input.historyAnchorsLimit, now, omit)
  const timelineHeader = "Recent timeline (recorded message/event times):"
  const withAnchors = (list: Anchor[]) =>
    list.length === 0
      ? []
      : [timelineHeader, ...list.map((a) => `- ${anchorAt(a.time)} — ${a.label}`)]

  const assemble = (anchorLines: string[], optionalLines: string[]) =>
    [...lines, ...optionalLines, ...anchorLines, TIMING_RULE, BLOCK_END].join("\n")

  let block = assemble(withAnchors(anchors), optional)
  while (block.length > input.maxBlockChars && anchors.length > 0) {
    anchors = anchors.slice(1) // timeline is chronological; drop oldest first
    block = assemble(withAnchors(anchors), optional)
  }
  if (block.length > input.maxBlockChars) {
    block = assemble([], [optional[0] ?? ""].filter(Boolean))
  }
  if (block.length > input.maxBlockChars) {
    block = assemble([], [])
  }
  return block
}
