// Unit tests for the pure core: temporal semantics, model filtering, anchors.
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  BLOCK_END,
  BLOCK_START,
  buildBlock,
  canonicalModelId,
  formatDuration,
  formatLocalTime,
  formatUtc,
  isModelEligible,
  isValidTimeZone,
  localDateKey,
  modelMatches,
  offsetFor,
  parseOptions,
  selectAnchors,
  type AssistantMark,
  type ToolMark,
  type UserMark,
} from "../src/core.ts"

const LA = "America/Los_Angeles"

const baseInput = {
  timezone: LA,
  users: [] as UserMark[],
  assistants: [] as AssistantMark[],
  tools: [] as ToolMark[],
  historyAnchorsLimit: 6,
  maxBlockChars: 1500,
}

describe("timezone and offset handling", () => {
  test("valid and invalid IANA timezones", () => {
    assert.equal(isValidTimeZone("America/Los_Angeles"), true)
    assert.equal(isValidTimeZone("UTC"), true)
    assert.equal(isValidTimeZone("Not/AZone"), false)
    // note: ICU accepts some legacy aliases such as "PST"; they still resolve
    // to a real zone with correct per-instant offsets, so validation allows them
  })

  test("offset flips on DST boundary (PDT vs PST; no hard-coded offset)", () => {
    const summer = Date.UTC(2026, 6, 1, 12, 0, 0) // 2026-07-01 12:00Z
    const winter = Date.UTC(2026, 0, 15, 12, 0, 0) // 2026-01-15 12:00Z
    assert.equal(offsetFor(summer, LA), "-07:00")
    assert.equal(offsetFor(winter, LA), "-08:00")
    assert.match(formatLocalTime(summer, LA), /-07:00$/)
    assert.match(formatLocalTime(winter, LA), /-08:00$/)
  })

  test("UTC zone renders +00:00 and UTC ISO 8601", () => {
    const t = Date.UTC(2026, 9, 8, 3, 31, 0, 0)
    assert.equal(offsetFor(t, "UTC"), "+00:00")
    assert.equal(formatUtc(t), "2026-10-08T03:31:00.000Z")
  })

  test("non-hour offsets render minutes (Asia/Kathmandu +05:45)", () => {
    const t = Date.UTC(2026, 9, 7, 12, 0, 0)
    assert.equal(offsetFor(t, "Asia/Kathmandu"), "+05:45")
  })

  test("local midnight and UTC midnight diverge correctly", () => {
    // 2026-10-08T07:05Z = 2026-10-08 00:05 in LA (same instant, different day locally vs 07:05 UTC)
    const now = Date.UTC(2026, 9, 8, 7, 5, 0)
    assert.equal(localDateKey(now, LA), "2026-10-08")
    assert.equal(formatUtc(now).slice(0, 10), "2026-10-08")
    // 7 minutes earlier: 23:58 LA on the PREVIOUS local day
    const anchor = now - 7 * 60_000
    assert.equal(localDateKey(anchor, LA), "2026-10-07")
    const block = buildBlock({
      ...baseInput,
      now,
      users: [{ id: "u1", created: anchor }],
      assistants: [],
      tools: [],
    })
    // cross-day anchor keeps its full local date so "yesterday vs minutes" is unambiguous
    const latestLine = block.split("\n").find((l) => l.includes("Latest user message:"))!
    assert.match(latestLine, /Latest user message: 2026-10-07 23:58:00 -07:00 \(7 min ago\)/)
    assert.doesNotMatch(latestLine, /yesterday/i)
  })

  test("UTC midnight does not imply a local day change", () => {
    // 2026-10-08T00:30Z = 2026-10-07 17:30 in LA; anchor 40 min earlier, same LOCAL day
    const now = Date.UTC(2026, 9, 8, 0, 30, 0)
    const anchor = now - 40 * 60_000
    assert.equal(localDateKey(now, LA), localDateKey(anchor, LA))
    const block = buildBlock({ ...baseInput, now, users: [{ id: "u1", created: anchor }] })
    assert.match(block, /Latest user message: 2026-10-07 16:50:00 -07:00 \(40 min ago\)/)
  })
})

describe("durations", () => {
  test("unit mixing and rounding", () => {
    assert.equal(formatDuration(0), "0 sec")
    assert.equal(formatDuration(15_000), "15 sec")
    assert.equal(formatDuration(315_000), "5 min 15 sec")
    assert.equal(formatDuration(3_600_000), "1 hr")
    assert.equal(formatDuration(3_900_000), "1 hr 5 min")
    assert.equal(formatDuration(176_400_000), "2 days 1 hr")
  })

  test("negative and malformed durations clamp instead of going negative", () => {
    assert.equal(formatDuration(-5_000), "0 sec")
    assert.equal(formatDuration(Number.NaN), "0 sec")
  })
})

describe("model filtering", () => {
  test("canonical id is provider/model", () => {
    assert.equal(canonicalModelId("local-vllm", "moonshotai/Kimi-K3"), "local-vllm/moonshotai/Kimi-K3")
    assert.equal(canonicalModelId(undefined, "moonshotai/Kimi-K3"), undefined)
  })

  test("exact full-form match only; similar substrings and other providers do not match", () => {
    assert.equal(modelMatches("local-vllm/moonshotai/Kimi-K3", "local-vllm", "moonshotai/Kimi-K3"), true)
    assert.equal(modelMatches("vllm/moonshotai/Kimi-K3", "local-vllm", "moonshotai/Kimi-K3"), false)
    assert.equal(modelMatches("local-vllm/moonshotai/Kimi", "local-vllm", "moonshotai/Kimi-K3"), false)
    // case sensitivity
    assert.equal(modelMatches("local-vllm/moonshotai/kimi-k3", "local-vllm", "moonshotai/Kimi-K3"), false)
  })

  test("exact model-id entry matches that model on any provider (documented convenience)", () => {
    assert.equal(modelMatches("moonshotai/Kimi-K3", "local-vllm", "moonshotai/Kimi-K3"), true)
    assert.equal(modelMatches("moonshotai/Kimi-K3", "openrouter", "moonshotai/Kimi-K3"), true)
    // bare fragments that are not the full model ID never match
    assert.equal(modelMatches("Kimi-K3", "local-vllm", "moonshotai/Kimi-K3"), false)
    assert.equal(modelMatches("Kimi", "local-vllm", "moonshotai/Kimi-K3"), false)
  })

  const cfg = (over: Partial<Parameters<typeof isModelEligible>[0]>) => ({
    enabled: true,
    includeModels: [],
    excludeModels: [],
    timezone: undefined,
    historyAnchorsLimit: 6,
    maxBlockChars: 1500,
    debug: false,
    ...over,
  })

  test("empty include/exclude lists: every model eligible (model-agnostic default)", () => {
    const c = cfg({})
    for (const [p, m] of [
      ["local-vllm", "moonshotai/Kimi-K3"],
      ["anthropic", "claude-sonnet-4-6"],
      ["openai", "gpt-5"],
      ["example", "completely-unrelated-model"],
    ]) {
      assert.equal(isModelEligible(c, p, m).eligible, true, `${p}/${m}`)
    }
  })

  test("include list injects only matches; exclusion blocks matches; exclusion wins", () => {
    const c = cfg({
      includeModels: ["local-vllm/moonshotai/Kimi-K3", "anthropic/claude-sonnet-4-6"],
      excludeModels: ["anthropic/claude-sonnet-4-6"],
    })
    assert.equal(isModelEligible(c, "local-vllm", "moonshotai/Kimi-K3").eligible, true)
    assert.equal(isModelEligible(c, "anthropic", "claude-sonnet-4-6").eligible, false)
    assert.equal(isModelEligible(c, "openai", "gpt-5").eligible, false)
    assert.match(isModelEligible(c, "anthropic", "claude-sonnet-4-6").reason, /excludeModels/)
  })

  test("unknown identity: allowed with empty filters, blocked+diagnostic with filters", () => {
    assert.equal(isModelEligible(cfg({}), undefined, undefined).eligible, true)
    const denied = isModelEligible(cfg({ includeModels: ["a/b"] }), undefined, undefined)
    assert.equal(denied.eligible, false)
    assert.match(denied.reason, /unknown|unverified/i)
  })
})

describe("config parsing", () => {
  test("defaults when no options given", () => {
    const { config, warnings } = parseOptions(undefined)
    assert.deepEqual(config, {
      enabled: true,
      includeModels: [],
      excludeModels: [],
      timezone: undefined,
      historyAnchorsLimit: 6,
      maxBlockChars: 1500,
      debug: false,
    })
    assert.deepEqual(warnings, [])
  })

  test("full options round-trip", () => {
    const { config, warnings } = parseOptions({
      enabled: false,
      includeModels: ["local-vllm/moonshotai/Kimi-K3"],
      excludeModels: ["x/y"],
      timezone: "America/Los_Angeles",
      historyAnchorsLimit: 4,
      maxBlockChars: 900,
      debug: true,
    })
    assert.equal(config.enabled, false)
    assert.deepEqual(config.includeModels, ["local-vllm/moonshotai/Kimi-K3"])
    assert.deepEqual(config.excludeModels, ["x/y"])
    assert.equal(config.timezone, "America/Los_Angeles")
    assert.equal(config.historyAnchorsLimit, 4)
    assert.equal(config.maxBlockChars, 900)
    assert.equal(config.debug, true)
    assert.deepEqual(warnings, [])
  })

  test("invalid timezone falls back to host local with a warning", () => {
    const { config, warnings } = parseOptions({ timezone: "Not/AZone" })
    assert.equal(config.timezone, undefined)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0]!, /IANA/)
  })

  test("malformed options degrade to defaults with warnings", () => {
    const { config, warnings } = parseOptions({
      enabled: "yes",
      includeModels: "all",
      historyAnchorsLimit: -3.5,
      maxBlockChars: Number.NaN,
    })
    assert.equal(config.enabled, true)
    assert.deepEqual(config.includeModels, [])
    assert.equal(config.historyAnchorsLimit, 6)
    assert.equal(config.maxBlockChars, 1500)
    assert.ok(warnings.length >= 3)
  })

  test("limits are clamped to sane ranges", () => {
    assert.equal(parseOptions({ historyAnchorsLimit: 99 }).config.historyAnchorsLimit, 12)
    assert.equal(parseOptions({ maxBlockChars: 10 }).config.maxBlockChars, 300)
  })
})

describe("timeline anchors", () => {
  const now = Date.UTC(2026, 9, 8, 3, 31, 0, 0)

  test("orders anchors, applies limit, returns chronological", () => {
    const users: UserMark[] = [
      { id: "u1", created: now - 600_000 },
      { id: "u2", created: now - 300_000 },
      { id: "u3", created: now - 15_000 },
    ]
    const assistants: AssistantMark[] = [
      { id: "a1", created: now - 500_000, completed: now - 480_000, mode: "build" },
      { id: "a2", created: now - 200_000, completed: now - 120_000, mode: "build" },
    ]
    const tools: ToolMark[] = [{ id: "t1", tool: "bash", end: now - 60_000 }]
    const anchors = selectAnchors(users, assistants, tools, 4, now)
    assert.equal(anchors.length, 4)
    const times = anchors.map((a) => a.time)
    assert.deepEqual([...times].sort((a, b) => a - b), times) // chronological
    assert.equal(times.at(-1), now - 15_000) // newest anchor last
  })

  test("excludes records with unknown semantics or unreliable times", () => {
    const users: UserMark[] = [
      { id: "u1", created: Number.NaN },
      { id: "u2", created: -5 },
    ]
    const assistants: AssistantMark[] = [
      { id: "a1", created: now - 10_000, mode: "build" }, // never completed: unknown completion
      { id: "a2", created: now - 10_000, completed: now - 9_000, mode: "compaction" }, // hidden aux
      { id: "a3", created: now - 10_000, completed: now - 8_000, mode: "build", summary: true }, // compaction summary
      { id: "a4", created: now - 10_000, completed: now + 10 * 60_000, mode: "build" }, // far-future: unreliable
    ]
    const tools: ToolMark[] = [
      { id: "t1", tool: "bash" }, // never finished
      { id: "t2", tool: "bash", end: now - 5_000 },
      { id: "t3", tool: "read", end: now - 4_000, failed: true },
    ]
    const anchors = selectAnchors(users, assistants, tools, 6, now)
    // chronological: the older bash completion prints before the newer read failure
    assert.deepEqual(
      anchors.map((a) => a.label),
      ['tool "bash" finished', 'tool "read" failed'],
    )
  })

  test("limit 0 disables the timeline", () => {
    const anchors = selectAnchors([{ id: "u1", created: now - 1_000 }], [], [], 0, now)
    assert.deepEqual(anchors, [])
  })
})

describe("block assembly", () => {
  const now = Date.UTC(2026, 9, 8, 3, 31, 0, 0) // 2026-10-07 20:31:00 -07:00

  test("verified same-day 5-minute-old event reads as minutes, never yesterday (matrix #1)", () => {
    const block = buildBlock({
      ...baseInput,
      now,
      users: [{ id: "u1", created: now - 5 * 60_000 - 15_000 }],
    })
    assert.match(block, /Latest user message: 2026-10-07 20:25:45 -07:00 \(5 min 15 sec ago\)/)
    // no age field may claim "yesterday" or "day(s) ago"
    assert.doesNotMatch(block, /\((?:yesterday|[^)]*days?) ago\)/i)
    assert.match(block, new RegExp(`^Now: 2026-10-07 20:31:00 -07:00 \\(America/Los_Angeles\\)$`, "m"))
    assert.match(block, /^UTC now: 2026-10-08T03:31:00\.000Z$/m)
  })

  test("latest/previous user lines carry verified times and the real gap (matrix #4)", () => {
    const block = buildBlock({
      ...baseInput,
      now,
      users: [
        { id: "u1", created: now - 330_000 },
        { id: "u2", created: now - 15_000 },
      ],
      // assistant/tool activity between the two user messages must not distort the gap
      assistants: [{ id: "a1", created: now - 300_000, completed: now - 240_000, mode: "build" }],
      tools: [{ id: "t1", tool: "bash", end: now - 100_000 }],
    })
    assert.match(block, /Latest user message: 2026-10-07 20:30:45 -07:00 \(15 sec ago\)/)
    assert.match(block, /Previous user message: 2026-10-07 20:25:30 -07:00 \(5 min 15 sec before latest\)/)
  })

  test("last assistant completion is labelled when available", () => {
    const block = buildBlock({
      ...baseInput,
      now,
      users: [{ id: "u1", created: now - 15_000 }],
      assistants: [{ id: "a1", created: now - 90_000, completed: now - 62_000, mode: "build" }],
    })
    assert.match(block, /Latest assistant completion: 2026-10-07 20:29:58 -07:00 \(1 min 2 sec ago\)/)
  })

  test("clock skew (user message newer than now) clamps to 0 sec, no negative ages (matrix #8)", () => {
    const block = buildBlock({ ...baseInput, now, users: [{ id: "u1", created: now + 20_000 }] })
    assert.match(block, /\(0 sec ago\)/)
    assert.doesNotMatch(block, /\(-\d/) // no negative ages anywhere
  })

  test("missing timestamps produce a smaller block, not fabricated data", () => {
    const block = buildBlock({ ...baseInput, now, users: [], assistants: [], tools: [] })
    assert.match(block, /^Now: /m)
    assert.doesNotMatch(block, /Latest user message:/)
    assert.doesNotMatch(block, /Recent timeline:/)
  })

  test("block always starts and ends with the plugin markers", () => {
    const block = buildBlock({ ...baseInput, now })
    assert.ok(block.startsWith(BLOCK_START))
    assert.ok(block.endsWith(BLOCK_END))
  })

  test("hard size cap sheds oldest anchors first (matrix #19)", () => {
    const users: UserMark[] = Array.from({ length: 40 }, (_, i) => ({
      id: `u${i}`,
      created: now - (40 - i) * 60_000,
    }))
    const block = buildBlock({ ...baseInput, now, users, historyAnchorsLimit: 12, maxBlockChars: 700 })
    assert.ok(block.length <= 700, `block length ${block.length}`)
    assert.match(block, /Timing rule:/)
  })
})
