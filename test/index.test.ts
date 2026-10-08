// Hook-level tests for tail placement: fake clock, payload fixtures shaped like
// the real `experimental.chat.messages.transform` payload ({info, parts} rows),
// and stub logs. Placement and prefix-cache stability are asserted directly.
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { BLOCK_START } from "../src/core.ts"
import { createTimeContextHooks } from "../src/hooks.ts"

const LA = "America/Los_Angeles"
const KIMI = { providerID: "local-vllm", modelID: "moonshotai/Kimi-K3" }
const CLAUDE = { providerID: "anthropic", modelID: "claude-sonnet-4-6" }

const T0 = Date.UTC(2026, 9, 8, 3, 20, 0, 0) // 2026-10-07 20:20:00 -07:00

interface LogEntry {
  level: string
  message: string
  extra?: Record<string, unknown>
}

function makeDeps(over: { options?: unknown } = {}) {
  const logs: LogEntry[] = []
  let clock = 0
  const deps = {
    options: over.options,
    client: {
      app: {
        async log(input: { body: { level: string; message: string; extra?: Record<string, unknown> } }) {
          logs.push(input.body)
          return true
        },
      },
    },
    hostTimezone: LA,
    now: () => clock,
    setClock(t: number) {
      clock = t
    },
  }
  return { deps, logs }
}

type Hooks = ReturnType<typeof createTimeContextHooks>

// Payload row builders mirroring opencode's stored message shapes.
function userRow(sessionID: string, id: string, created: number, over: { model?: { providerID: string; modelID: string }; text?: string } = {}) {
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created },
      agent: "build",
      model: over.model ?? KIMI,
    },
    parts: [{ id: `${id}p1`, sessionID, messageID: id, type: "text", text: over.text ?? "hi" }],
  }
}

function assistantRow(sessionID: string, id: string, over: { created: number; completed?: number; mode?: string; summary?: boolean; tools?: unknown[] }) {
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      time: { created: over.created, ...(over.completed ? { completed: over.completed } : {}) },
      mode: over.mode ?? "build",
      ...(over.summary ? { summary: true } : {}),
      parentID: "u0",
      modelID: KIMI.modelID,
      providerID: KIMI.providerID,
      path: { cwd: "/x", root: "/x" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: (over.tools as unknown[]) ?? [],
  }
}

function toolPart(sessionID: string, messageID: string, id: string, over: { tool?: string; status: string; start: number; end?: number }) {
  return {
    id,
    sessionID,
    messageID,
    type: "tool",
    callID: `call-${id}`,
    tool: over.tool ?? "bash",
    state: { status: over.status, time: { start: over.start, ...(over.end ? { end: over.end } : {}) } },
  }
}

async function transform(hooks: Hooks, messages: unknown[]) {
  const output = { messages: messages as never[] }
  await (hooks as any)["experimental.chat.messages.transform"]({}, output)
  return output.messages as Array<{ info?: { id?: string }; parts?: Array<{ text?: string }> }>
}

function blockOf(messages: Array<{ info?: { id?: string }; parts?: Array<{ text?: string }> }>) {
  const tail = messages.at(-1)
  const text = tail?.parts?.map((p) => p.text ?? "").join("") ?? ""
  return tail?.info?.id === "msg_time_context_ephemeral" ? text : undefined
}

async function emitAssistant(hooks: Hooks, sessionID: string, id: string, over: { created: number; completed?: number; mode?: string; summary?: boolean }) {
  await hooks.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id,
          sessionID,
          role: "assistant",
          time: { created: over.created, ...(over.completed ? { completed: over.completed } : {}) },
          mode: over.mode ?? "build",
          ...(over.summary ? { summary: true } : {}),
        },
      },
    },
  } as any)
}

describe("tail placement and prefix-cache stability", () => {
  test("block is a synthetic trailing user message containing only plugin text; all real rows untouched (matrix #17)", async () => {
    const { deps } = makeDeps()
    deps.setClock(T0 + 60_000)
    const hooks = createTimeContextHooks(deps)
    const rows = [userRow("s1", "u1", T0, { text: "SECRET-PROMPT-CONTENTS" })]
    const snapshot = JSON.parse(JSON.stringify(rows))
    const messages = await transform(hooks, rows)

    assert.equal(rows.length, 2)
    assert.deepEqual(rows[0], snapshot[0]) // real row untouched
    const tail = rows.at(-1)! as any
    assert.equal(tail.info.role, "user")
    assert.equal(tail.info.id, "msg_time_context_ephemeral")
    assert.ok(tail.parts[0].synthetic === true)
    assert.match(tail.parts[0].text, /^(\[OpenCode time context\])/)
    assert.match(tail.parts[0].text, /Now: 2026-10-07 20:21:00 -07:00/)
    assert.doesNotMatch(tail.parts[0].text, /SECRET-PROMPT-CONTENTS/)
    assert.ok(blockOf(messages)!.length > 0)
  })

  test("history entries keep their verified times while Now refreshes per request (matrix #5)", async () => {
    const { deps } = makeDeps()
    const hooks = createTimeContextHooks(deps)
    deps.setClock(T0 + 60_000)
    const first = blockOf(await transform(hooks, [userRow("s1", "u1", T0)]))!
    deps.setClock(T0 + 150_000)
    const second = blockOf(await transform(hooks, [userRow("s1", "u1", T0)]))!
    assert.match(first, /Now: 2026-10-07 20:21:00 -07:00/)
    assert.match(second, /Now: 2026-10-07 20:22:30 -07:00/)
    for (const block of [first, second]) assert.match(block, /Latest user message: 2026-10-07 20:20:00 -07:00/)
  })

  test("re-transforming the same output array replaces the stale block exactly once (matrix #15)", async () => {
    const { deps } = makeDeps()
    deps.setClock(T0)
    const hooks = createTimeContextHooks(deps)
    const rows = [userRow("s1", "u1", T0 - 5_000)]
    await transform(hooks, rows)
    deps.setClock(T0 + 30_000)
    await transform(hooks, rows)
    assert.equal(rows.filter((r) => r.info?.id === "msg_time_context_ephemeral").length, 1)
    assert.match(blockOf(rows)!, /Now: 2026-10-07 20:20:30 -07:00/)
  })

  test("prefix stability: everything before the tail row is byte-identical across requests", async () => {
    const { deps } = makeDeps()
    const hooks = createTimeContextHooks(deps)
    deps.setClock(T0)
    const sessionMessages = () => [
      userRow("s1", "u1", T0 - 600_000, { text: "first question" }),
      assistantRow("s1", "a1", { created: T0 - 590_000, completed: T0 - 540_000 }),
      userRow("s1", "u2", T0 - 30_000, { text: "follow-up" }),
    ]
    const a = await transform(hooks, sessionMessages())
    deps.setClock(T0 + 90_000)
    const b = await transform(hooks, sessionMessages())
    // provider sees identical bytes for the whole history in both requests
    assert.deepEqual(JSON.stringify(a.slice(0, -1)), JSON.stringify(b.slice(0, -1)))
    assert.notDeepEqual(JSON.stringify(a.at(-1)), JSON.stringify(b.at(-1)))
  })

  test("requests with no user message in the payload get nothing", async () => {
    const { deps } = makeDeps()
    deps.setClock(T0)
    const hooks = createTimeContextHooks(deps)
    const rows = [assistantRow("s1", "a1", { created: T0 - 10_000 })]
    const before = JSON.stringify(rows)
    await transform(hooks, rows)
    assert.equal(JSON.stringify(rows), before)
  })
})

describe("historical timestamps derived from the request payload", () => {
  test("older verified times render on a resumed continuation with no prior plugin state (matrix #6)", async () => {
    const { deps } = makeDeps()
    deps.setClock(T0)
    const hooks = createTimeContextHooks(deps) // brand new instance = process restart
    const rows = [
      userRow("s1", "u1", T0 - 600_000, { text: "SECRET-PROMPT-CONTENTS" }),
      assistantRow("s1", "a1", {
        created: T0 - 590_000,
        completed: T0 - 540_000,
        tools: [toolPart("s1", "a1", "tp1", { status: "completed", start: T0 - 580_000, end: T0 - 570_000 })],
      }),
      userRow("s1", "u2", T0 - 30_000),
    ]
    const block = blockOf(await transform(hooks, rows))!
    assert.match(block, /Latest user message: 2026-10-07 20:19:30 -07:00 \(30 sec ago\)/)
    assert.match(block, /Previous user message: .*\(9 min 30 sec before latest\)/)
    assert.match(block, /Latest assistant completion: 2026-10-07 20:11:00 -07:00 \(9 min ago\)/)
    assert.match(block, /tool "bash" finished/)
    assert.doesNotMatch(block, /SECRET-PROMPT-CONTENTS/)
  })

  test("gap between the two latest user messages ignores interleaved tools/assistant (matrix #4)", async () => {
    const { deps } = makeDeps()
    deps.setClock(T0 + 1_000)
    const hooks = createTimeContextHooks(deps)
    const rows = [
      userRow("s1", "u1", T0 - 120_000),
      assistantRow("s1", "a1", {
        created: T0 - 110_000,
        completed: T0 - 100_000,
        tools: [toolPart("s1", "a1", "tp1", { status: "completed", start: T0 - 95_000, end: T0 - 90_000 })],
      }),
      userRow("s1", "u2", T0 - 45_000),
    ]
    const block = blockOf(await transform(hooks, rows))!
    assert.match(block, /Latest user message: 2026-10-07 20:19:15 -07:00 \(46 sec ago\)/)
    assert.match(block, /Previous user message: 2026-10-07 20:18:00 -07:00 \(1 min 15 sec before latest\)/)
  })

  test("malformed/missing timestamps are dropped instead of fabricated (matrix #8)", async () => {
    const { deps } = makeDeps()
    deps.setClock(T0)
    const hooks = createTimeContextHooks(deps)
    const rows = [userRow("s1", "u-weird", Number.NaN), userRow("s1", "u-real", T0 - 5_000)]
    const block = blockOf(await transform(hooks, rows))!
    assert.match(block, /Latest user message: .*\(5 sec ago\)/)
    assert.doesNotMatch(block, /NaN/)
  })

  test("large histories stay bounded: anchors limited, block capped (matrix #19)", async () => {
    const rows = Array.from({ length: 500 }, (_, i) =>
      userRow("s1", `u${i}`, T0 - (500 - i) * 60_000, { text: `message ${i}` }),
    )
    const { deps } = makeDeps({ options: { maxBlockChars: 1200, historyAnchorsLimit: 6 } })
    deps.setClock(T0)
    const hooks = createTimeContextHooks(deps)
    const block = blockOf(await transform(hooks, rows))!
    assert.ok(block.length <= 1200, `block length ${block.length}`)
    assert.ok(block.split("\n").filter((l) => l.startsWith("- ")).length <= 6)
    // anchored times come from the payload; payload order preserved
    assert.equal(rows.length, 501)
  })
})

describe("model filtering per outgoing request", () => {
  test("default empty lists inject for Kimi, Claude, GPT and unrelated models (matrix #9)", async () => {
    const { deps } = makeDeps()
    deps.setClock(T0)
    const hooks = createTimeContextHooks(deps)
    for (const model of [KIMI, { providerID: "anthropic", modelID: "claude-sonnet-4-6" }, { providerID: "openai", modelID: "gpt-5" }, { providerID: "x", modelID: "y" }]) {
      const messages = await transform(hooks, [userRow("s1", "u1", T0 - 1_000, { model })])
      assert.ok(blockOf(messages), `${model.providerID}/${model.modelID}`)
    }
  })

  test("include/exclude lists apply per request; exclusion wins (matrix #10)", async () => {
    const { deps } = makeDeps({
      options: {
        includeModels: ["local-vllm/moonshotai/Kimi-K3", "anthropic/claude-sonnet-4-6"],
        excludeModels: ["anthropic/claude-sonnet-4-6"],
      },
    })
    deps.setClock(T0)
    const hooks = createTimeContextHooks(deps)
    assert.ok(blockOf(await transform(hooks, [userRow("s1", "u1", T0 - 1_000, { model: KIMI })])))
    assert.equal(blockOf(await transform(hooks, [userRow("s1", "u2", T0 - 1_000, { model: CLAUDE })])), undefined)
    assert.equal(
      blockOf(await transform(hooks, [userRow("s1", "u3", T0 - 1_000, { model: { providerID: "openai", modelID: "gpt-5" } })])),
      undefined,
    )
  })

  test("a mid-session model switch takes effect on the very next request (matrix #12)", async () => {
    const { deps } = makeDeps({ options: { excludeModels: ["anthropic/claude-sonnet-4-6"] } })
    deps.setClock(T0)
    const hooks = createTimeContextHooks(deps)
    assert.ok(blockOf(await transform(hooks, [userRow("s1", "u1", T0 - 10_000, { model: KIMI })])))
    // next turn of the SAME session uses Claude -> excluded immediately
    assert.equal(blockOf(await transform(hooks, [userRow("s1", "u2", T0 - 5_000, { model: CLAUDE })])), undefined)
    assert.ok(blockOf(await transform(hooks, [userRow("s1", "u3", T0, { model: KIMI })])))
  })

  test("subagent sessions are filtered independently and carry only their own history (matrix #13, #16)", async () => {
    const { deps } = makeDeps({ options: { includeModels: ["anthropic/claude-sonnet-4-6"] } })
    deps.setClock(T0)
    const hooks = createTimeContextHooks(deps)
    const childBlock = blockOf(await transform(hooks, [userRow("child", "uc1", T0 - 60_000, { model: CLAUDE })]))!
    assert.match(childBlock, /Latest user message: .*\(1 min ago\)/)
    assert.equal(blockOf(await transform(hooks, [userRow("parent", "up1", T0 - 300_000, { model: KIMI })])), undefined)
  })

  test("enabled: false yields no injection (matrix #14)", async () => {
    const { deps } = makeDeps({ options: { enabled: false } })
    deps.setClock(T0)
    const hooks = createTimeContextHooks(deps)
    assert.equal(blockOf(await transform(hooks, [userRow("s1", "u1", T0 - 1_000)])), undefined)
  })

  test("two interleaved concurrent sessions never share history (matrix #16)", async () => {
    const { deps } = makeDeps()
    deps.setClock(T0)
    const hooks = createTimeContextHooks(deps)
    const a = blockOf(await transform(hooks, [userRow("sA", "uA1", T0 - 10_000)]))!
    const b = blockOf(await transform(hooks, [userRow("sB", "uB1", T0 - 40_000)]))!
    assert.match(a, /\(10 sec ago\)/)
    assert.match(b, /\(40 sec ago\)/)
  })

  test("host-local timezone is used when none is configured; explicit override wins", async () => {
    const { deps } = makeDeps()
    deps.setClock(T0)
    const hooks = createTimeContextHooks(deps)
    const block = blockOf(await transform(hooks, [userRow("s1", "u1", T0 - 1_000)]))!
    assert.match(block, /\([A-Za-z]+, America\/Los_Angeles\)/)
    const overridden = createTimeContextHooks({ ...deps, options: { timezone: "UTC" } })
    const block2 = blockOf(await transform(overridden, [userRow("s2", "u1", T0 - 1_000)]))!
    assert.match(block2, /Now: 2026-10-08 03:20:00 \+00:00 \(Thursday, UTC\)/)
  })

  test("unknown model identity: allowed with no filters, skipped with diagnostic when filters exist (matrix #14)", async () => {
    const { deps, logs } = makeDeps({
      options: { includeModels: ["anthropic/claude-sonnet-4-6"] },
    })
    deps.setClock(T0)
    const hooks = createTimeContextHooks(deps)
    const noModelRow = {
      info: { id: "u1", sessionID: "s1", role: "user", time: { created: T0 - 1_000 }, agent: "build" },
      parts: [{ id: "u1p1", type: "text", text: "hi" }],
    }
    assert.equal(blockOf(await transform(hooks, [noModelRow])), undefined)
    assert.ok(logs.some((l) => l.level === "debug" && /unverified/.test(l.message)))
    // and the permissive default
    const { deps: deps2 } = makeDeps()
    deps2.setClock(T0)
    const hooks2 = createTimeContextHooks(deps2)
    assert.ok(blockOf(await transform(hooks2, [noModelRow])))
  })
})

describe("auxiliary request suppression", () => {
  test("only-aux pending (compaction/summary) suppresses injection; completion re-enables (matrix #15 aux)", async () => {
    const { deps } = makeDeps()
    deps.setClock(T0)
    const hooks = createTimeContextHooks(deps)
    await emitAssistant(hooks, "s1", "ac1", { created: T0 - 1_000, mode: "compaction", summary: true })
    assert.equal(blockOf(await transform(hooks, [userRow("s1", "u1", T0 - 500)])), undefined)
    await emitAssistant(hooks, "s1", "ac1", { created: T0 - 1_000, completed: T0 - 100, mode: "compaction", summary: true })
    assert.ok(blockOf(await transform(hooks, [userRow("s1", "u1", T0 - 500)])))
  })

  test("a pending compaction plus a pending primary turn does not suppress (title/summary run alongside)", async () => {
    const { deps } = makeDeps()
    deps.setClock(T0)
    const hooks = createTimeContextHooks(deps)
    await emitAssistant(hooks, "s1", "ac1", { created: T0 - 2_000, mode: "compaction", summary: true })
    await emitAssistant(hooks, "s1", "aa1", { created: T0 - 1_000, mode: "build" })
    assert.ok(blockOf(await transform(hooks, [userRow("s1", "u1", T0 - 500)])))
  })

  test("message.removed events drop pending state", async () => {
    const { deps } = makeDeps()
    deps.setClock(T0)
    const hooks = createTimeContextHooks(deps)
    await emitAssistant(hooks, "s1", "ac1", { created: T0 - 1_000, mode: "compaction", summary: true })
    await hooks.event({ event: { type: "message.removed", properties: { sessionID: "s1", messageID: "ac1" } } } as any)
    assert.ok(blockOf(await transform(hooks, [userRow("s1", "u1", T0 - 500)])))
  })
})

describe("logging hygiene (matrix #18)", () => {
  test("logs never contain prompt contents", async () => {
    const { deps, logs } = makeDeps({ options: { debug: true } })
    deps.setClock(T0)
    const hooks = createTimeContextHooks(deps)
    await transform(hooks, [userRow("s1", "u1", T0 - 1_000, { text: "SECRET-PROMPT-CONTENTS" })])
    for (const entry of logs) assert.doesNotMatch(JSON.stringify(entry), /SECRET-PROMPT-CONTENTS/)
  })
})
