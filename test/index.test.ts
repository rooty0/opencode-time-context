// Hook-level tests: fake clock, fake session store, stub logs. These drive the
// plugin exactly the way opencode 1.18.35 invokes the hooks, including a mocked
// reproduction of LLMRequestPrep.prepare's system-array post-processing.
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { BLOCK_START } from "../src/core.ts"
import { createTimeContextHooks } from "../src/hooks.ts"

const LA = "America/Los_Angeles"
const KIMI = { providerID: "local-vllm", id: "moonshotai/Kimi-K3" }
const CLAUDE = { providerID: "anthropic", id: "claude-sonnet-4-6" }

interface LogEntry {
  level: string
  message: string
  extra?: Record<string, unknown>
}

function makeDeps(over: {
  options?: unknown
  messages?: Array<{ info: unknown; parts: unknown[] }>
  failFetch?: boolean
}) {
  const logs: LogEntry[] = []
  let clock = 0
  const deps = {
    options: over.options,
    client: {
      session: {
        async messages() {
          if (over.failFetch) throw new Error("simulated store failure")
          return { data: over.messages ?? [] }
        },
      },
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

async function transform(hooks: Hooks, system: string[], over: { sessionID?: string; model?: { providerID?: string; id?: string } } = {}) {
  // opencode 1.18.35 LLMRequestPrep.prepare semantics: l starts as one joined
  // string, the hook mutates it, and if a plugin append left >2 entries the tail
  // is re-joined into one. Reproduced here so tests assert on what reaches the
  // provider-facing system array.
  const input: { sessionID?: string; model: { providerID?: string; id?: string } } = { model: KIMI }
  if (over.sessionID) input.sessionID = over.sessionID
  if (over.model) input.model = over.model
  const first = system[0]
  await (hooks as any)["experimental.chat.system.transform"](input, { system })
  if (system.length > 2 && system[0] === first) {
    const rest = system.slice(1)
    system.length = 0
    system.push(first!, rest.join("\n"))
  }
  return system
}

async function admitUser(hooks: Hooks, sessionID: string, id: string, created: number) {
  await (hooks as any)["chat.message"](
    { sessionID },
    { message: { id, sessionID, role: "user", time: { created }, agent: "build", model: { providerID: "local-vllm", modelID: "moonshotai/Kimi-K3" } }, parts: [] },
  )
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
          parentID: "u0",
          modelID: "moonshotai/Kimi-K3",
          providerID: "local-vllm",
          path: { cwd: "/x", root: "/x" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    },
  } as any)
}

async function emitTool(hooks: Hooks, sessionID: string, partID: string, over: { tool?: string; status: string; start: number; end?: number }) {
  await hooks.event({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: partID,
          sessionID,
          messageID: "a1",
          type: "tool",
          callID: `call-${partID}`,
          tool: over.tool ?? "bash",
          state: { status: over.status, time: { start: over.start, ...(over.end ? { end: over.end } : {}) } },
        },
      },
    },
  } as any)
}

const T0 = Date.UTC(2026, 9, 8, 3, 20, 0, 0) // 2026-10-07 20:20:00 -07:00

describe("request scope and fresh clock", () => {
  test("injects exactly one fresh block per request; Now refreshes across continuations while history stays stable (matrix #5, #15, #20)", async () => {
    const { deps } = makeDeps({})
    deps.setClock(T0 + 60_000)
    const hooks = createTimeContextHooks(deps)
    await admitUser(hooks, "s1", "u1", T0)

    // initial request and a tool continuation: same turn, 90s apart
    const initial = await transform(hooks, ["<base system>"], { sessionID: "s1" })
    deps.setClock(T0 + 150_000)
    const cont = await transform(hooks, ["<base system>"], { sessionID: "s1" })

    assert.match(initial[1]!, /Now: 2026-10-07 20:21:00 -07:00/)
    assert.match(cont[1]!, /Now: 2026-10-07 20:22:30 -07:00/)
    for (const sys of [initial, cont]) {
      assert.match(sys[1]!, /Latest user message: 2026-10-07 20:20:00 -07:00/)
    }
    assert.match(initial[1]!, /\(1 min ago\)/)
    assert.match(cont[1]!, /\(2 min 30 sec ago\)/)

    // the base system content stays first and untouched; only one block present
    assert.equal(initial[0], "<base system>")
    assert.equal(initial.filter((s) => s.includes(BLOCK_START)).length, 1)
  })

  test("stale plugin block is replaced when the same output array is re-transformed (matrix #15)", async () => {
    const { deps } = makeDeps({})
    deps.setClock(T0)
    const hooks = createTimeContextHooks(deps)
    await admitUser(hooks, "s1", "u1", T0 - 5_000)
    const system = ["<base system>"]
    await transform(hooks, system, { sessionID: "s1" })
    deps.setClock(T0 + 30_000)
    // rerun the hook against the same (uncollapsed) array: only one block, freshest Now
    const again = await transform(hooks, ["<base system>"], { sessionID: "s1" })
    const hooks2 = createTimeContextHooks(deps)
    await admitUser(hooks2, "s1", "u1", T0 - 5_000)
    const direct = ["<base system>"]
    await (hooks2 as any)["experimental.chat.system.transform"]({ sessionID: "s1", model: KIMI }, { system: direct })
    await (hooks2 as any)["experimental.chat.system.transform"]({ sessionID: "s1", model: KIMI }, { system: direct })
    assert.equal(direct.filter((s) => s.includes(BLOCK_START)).length, 1)
    assert.match(direct.at(-1)!, /Now: 2026-10-07 20:20:30 -07:00/)
    assert.ok(again.some((s) => s.includes(BLOCK_START)))
  })

  test("requests without a session id (auxiliary generation) get nothing", async () => {
    const { deps } = makeDeps({})
    const hooks = createTimeContextHooks(deps)
    const system = ["<base system>"]
    await transform(hooks, system)
    assert.deepEqual(system, ["<base system>"])
  })

  test("compaction: a pending compaction assistant suppresses injection (matrix #15 aux)", async () => {
    const { deps } = makeDeps({})
    deps.setClock(T0)
    const hooks = createTimeContextHooks(deps)
    await admitUser(hooks, "s1", "u1", T0 - 10_000)
    await emitAssistant(hooks, "s1", "ac1", { created: T0 - 1_000, mode: "compaction", summary: true })
    const system = await transform(hooks, ["<base system>"], { sessionID: "s1" })
    assert.deepEqual(system, ["<base system>"])
  })

  test("synthetic/unknown sessions (no history, resolvable but empty) get nothing", async () => {
    const { deps } = makeDeps({ messages: [] })
    deps.setClock(T0)
    const hooks = createTimeContextHooks(deps)
    const system = await transform(hooks, ["<base system>"], { sessionID: "synthetic-xyz" })
    assert.deepEqual(system, ["<base system>"])
  })
})

describe("historical timestamps", () => {
  test("restart/resume seeds times from persisted messages (matrix #6)", async () => {
    const stored = [
      {
        info: {
          id: "u1",
          sessionID: "s1",
          role: "user",
          time: { created: T0 - 600_000 },
          agent: "build",
          model: { providerID: "local-vllm", modelID: "moonshotai/Kimi-K3" },
        },
        parts: [{ id: "p1", sessionID: "s1", messageID: "u1", type: "text", text: "SECRET-PROMPT-CONTENTS" }],
      },
      {
        info: {
          id: "a1",
          sessionID: "s1",
          role: "assistant",
          time: { created: T0 - 590_000, completed: T0 - 540_000 },
          mode: "build",
          parentID: "u1",
          modelID: "moonshotai/Kimi-K3",
          providerID: "local-vllm",
          path: { cwd: "/x", root: "/x" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [
          {
            id: "toolp1",
            sessionID: "s1",
            messageID: "a1",
            type: "tool",
            callID: "c1",
            tool: "bash",
            state: { status: "completed", input: {}, output: "ok", title: "bash", metadata: {}, time: { start: T0 - 580_000, end: T0 - 570_000 } },
          },
        ],
      },
      {
        info: {
          id: "u2",
          sessionID: "s1",
          role: "user",
          time: { created: T0 - 30_000 },
          agent: "build",
          model: { providerID: "local-vllm", modelID: "moonshotai/Kimi-K3" },
        },
        parts: [],
      },
    ]
    const { deps, logs } = makeDeps({ messages: stored })
    deps.setClock(T0)
    const hooks = createTimeContextHooks(deps) // brand new instance = process restart
    const system = await transform(hooks, ["<base system>"], { sessionID: "s1" })
    const block = system.find((s) => s.includes(BLOCK_START))!
    assert.match(block, /Latest user message: 2026-10-07 20:19:30 -07:00 \(30 sec ago\)/)
    assert.match(block, /Previous user message: .*\(9 min 30 sec before latest\)/)
    assert.match(block, /Latest assistant completion: 2026-10-07 20:11:00 -07:00 \(9 min ago\)/)
    assert.match(block, /tool "bash" finished/)
    // the block must carry times only, never message contents
    assert.doesNotMatch(block, /SECRET-PROMPT-CONTENTS/)
    assert.ok(logs.every((l) => !JSON.stringify(l).includes("SECRET-PROMPT-CONTENTS")))
  })

  test("store failure fails open: no block, session continues, warning logged (matrix #8, #18)", async () => {
    const { deps, logs } = makeDeps({ failFetch: true })
    deps.setClock(T0)
    const hooks = createTimeContextHooks(deps)
    const system = await transform(hooks, ["<base system>"], { sessionID: "s1" })
    assert.deepEqual(system, ["<base system>"])
    assert.ok(logs.some((l) => l.level === "warn" && /history/.test(l.message)))
    // after a real user admission, injection works even though the seed failed
    await admitUser(hooks, "s1", "u1", T0 - 5_000)
    const second = await transform(hooks, ["<base system>"], { sessionID: "s1" })
    assert.ok(second.some((s) => s.includes(BLOCK_START)))
  })

  test("gap between the two latest user messages ignores interleaved tools/assistant (matrix #4)", async () => {
    const { deps } = makeDeps({})
    deps.setClock(T0)
    const hooks = createTimeContextHooks(deps)
    await admitUser(hooks, "s1", "u1", T0 - 120_000)
    await emitAssistant(hooks, "s1", "a1", { created: T0 - 110_000, completed: T0 - 100_000 })
    await emitTool(hooks, "s1", "tp1", { status: "completed", start: T0 - 95_000, end: T0 - 90_000 })
    await admitUser(hooks, "s1", "u2", T0 - 45_000)
    deps.setClock(T0 + 1_000)
    const system = await transform(hooks, ["<base system>"], { sessionID: "s1" })
    const block = system.find((s) => s.includes(BLOCK_START))!
    assert.match(block, /Latest user message: 2026-10-07 20:19:15 -07:00 \(46 sec ago\)/)
    assert.match(block, /Previous user message: 2026-10-07 20:18:00 -07:00 \(1 min 15 sec before latest\)/)
  })

  test("malformed/missing timestamps are dropped instead of fabricated (matrix #8)", async () => {
    const { deps } = makeDeps({
      messages: [
        { info: { id: "u-weird", sessionID: "s1", role: "user", time: { created: Number.NaN } }, parts: [] },
        { info: { id: "u-real", sessionID: "s1", role: "user", time: { created: T0 - 5_000 } }, parts: [] },
      ],
    })
    deps.setClock(T0)
    const hooks = createTimeContextHooks(deps)
    const system = await transform(hooks, ["<base system>"], { sessionID: "s1" })
    const block = system.find((s) => s.includes(BLOCK_START))!
    assert.match(block, /Latest user message: .*\(5 sec ago\)/)
    assert.doesNotMatch(block, /NaN/)
  })
})

describe("model filtering per outgoing request", () => {
  test("default empty lists inject for Kimi, Claude, GPT and unrelated models (matrix #9)", async () => {
    const { deps } = makeDeps({})
    deps.setClock(T0)
    const hooks = createTimeContextHooks(deps)
    await admitUser(hooks, "s1", "u1", T0 - 1_000)
    for (const model of [KIMI, CLAUDE, { providerID: "openai", id: "gpt-5" }, { providerID: "x", id: "y" }]) {
      const system = await transform(hooks, ["<base>"], { sessionID: "s1", model })
      assert.ok(system.some((s) => s.includes(BLOCK_START)), `${model.providerID}/${model.id}`)
    }
  })

  test("include/exclude lists apply per request; exclusion wins (matrix #10)", async () => {
    const { deps } = makeDeps({
      options: { includeModels: ["local-vllm/moonshotai/Kimi-K3", "anthropic/claude-sonnet-4-6"], excludeModels: ["anthropic/claude-sonnet-4-6"] },
    })
    deps.setClock(T0)
    const hooks = createTimeContextHooks(deps)
    await admitUser(hooks, "s1", "u1", T0 - 1_000)
    assert.ok((await transform(hooks, ["<base>"], { sessionID: "s1", model: KIMI })).length > 1)
    assert.deepEqual(await transform(hooks, ["<base>"], { sessionID: "s1", model: CLAUDE }), ["<base>"])
    assert.deepEqual(await transform(hooks, ["<base>"], { sessionID: "s1", model: { providerID: "openai", id: "gpt-5" } }), ["<base>"])
  })

  test("a mid-session model switch takes effect on the very next request (matrix #12)", async () => {
    const { deps } = makeDeps({ options: { excludeModels: ["anthropic/claude-sonnet-4-6"] } })
    deps.setClock(T0)
    const hooks = createTimeContextHooks(deps)
    await admitUser(hooks, "s1", "u1", T0 - 1_000)
    assert.ok((await transform(hooks, ["<base>"], { sessionID: "s1", model: KIMI })).length > 1)
    assert.deepEqual(await transform(hooks, ["<base>"], { sessionID: "s1", model: CLAUDE }), ["<base>"])
    assert.ok((await transform(hooks, ["<base>"], { sessionID: "s1", model: KIMI })).length > 1)
  })

  test("subagent sessions are filtered independently and carry only their own history (matrix #13, #16)", async () => {
    const { deps } = makeDeps({ options: { includeModels: ["anthropic/claude-sonnet-4-6"] } })
    deps.setClock(T0)
    const hooks = createTimeContextHooks(deps)
    await admitUser(hooks, "parent", "up1", T0 - 300_000)
    await admitUser(hooks, "child", "uc1", T0 - 60_000)
    // child uses Claude: injected, with the CHILD session's history
    const childSys = await transform(hooks, ["<base>"], { sessionID: "child", model: CLAUDE })
    const childBlock = childSys.find((s) => s.includes(BLOCK_START))!
    assert.match(childBlock, /Latest user message: .*\(1 min ago\)/)
    // parent uses Kimi (excluded): nothing
    assert.deepEqual(await transform(hooks, ["<base>"], { sessionID: "parent", model: KIMI }), ["<base>"])
  })

  test("host-local timezone is used when none is configured; explicit override wins", async () => {
    const { deps } = makeDeps({})
    deps.setClock(T0)
    const hooks = createTimeContextHooks(deps)
    await admitUser(hooks, "s1", "u1", T0 - 1_000)
    const block = (await transform(hooks, ["<base>"], { sessionID: "s1" })).find((s) => s.includes(BLOCK_START))!
    assert.match(block, /\(America\/Los_Angeles\)/)
    const overridden = createTimeContextHooks({ ...deps, options: { timezone: "UTC" } })
    await admitUser(overridden, "s2", "u1", T0 - 1_000)
    const block2 = (await transform(overridden, ["<base>"], { sessionID: "s2" })).find((s) => s.includes(BLOCK_START))!
    assert.match(block2, /Now: 2026-10-08 03:20:00 \+00:00 \(UTC\)/)
  })

  test("enabled: false yields no injection (matrix #14)", async () => {
    const { deps } = makeDeps({ options: { enabled: false } })
    const hooks = createTimeContextHooks(deps)
    await admitUser(hooks, "s1", "u1", T0 - 1_000)
    deps.setClock(T0)
    assert.deepEqual(await transform(hooks, ["<base>"], { sessionID: "s1" }), ["<base>"])
  })

  test("two interleaved concurrent sessions never share history (matrix #16)", async () => {
    const { deps } = makeDeps({})
    deps.setClock(T0)
    const hooks = createTimeContextHooks(deps)
    await admitUser(hooks, "sA", "uA1", T0 - 10_000)
    await admitUser(hooks, "sB", "uB1", T0 - 40_000)
    const a = await transform(hooks, ["<base>"], { sessionID: "sA" })
    const b = await transform(hooks, ["<base>"], { sessionID: "sB" })
    assert.match(a.find((s) => s.includes(BLOCK_START))!, /\(10 sec ago\)/)
    assert.match(b.find((s) => s.includes(BLOCK_START))!, /\(40 sec ago\)/)
  })

  test("large histories stay bounded: anchors limited, block capped (matrix #19)", async () => {
    const stored = Array.from({ length: 500 }, (_, i) => ({
      info: {
        id: `u${i}`,
        sessionID: "s1",
        role: "user",
        time: { created: T0 - (500 - i) * 60_000 },
        agent: "build",
        model: { providerID: "local-vllm", modelID: "moonshotai/Kimi-K3" },
      },
      parts: [],
    }))
    const { deps } = makeDeps({ messages: stored, options: { maxBlockChars: 1200, historyAnchorsLimit: 6 } })
    deps.setClock(T0)
    const hooks = createTimeContextHooks(deps)
    const system = await transform(hooks, ["<base>"], { sessionID: "s1" })
    const block = system.find((s) => s.includes(BLOCK_START))!
    assert.ok(block.length <= 1200, `block length ${block.length}`)
    const anchorLines = block.split("\n").filter((l) => l.startsWith("- "))
    assert.ok(anchorLines.length <= 6)
  })

  test("other plugins' system content and canonical message text are untouched (matrix #17)", async () => {
    const { deps } = makeDeps({})
    deps.setClock(T0)
    const hooks = createTimeContextHooks(deps)
    const userMessage = {
      id: "u1",
      sessionID: "s1",
      role: "user",
      time: { created: T0 - 1_000 },
      agent: "build",
      model: { providerID: "local-vllm", modelID: "moonshotai/Kimi-K3" },
    }
    const parts = [{ id: "p1", type: "text", text: "please refactor this" }]
    const snapshot = JSON.parse(JSON.stringify({ message: userMessage, parts }))
    await (hooks as any)["chat.message"]({ sessionID: "s1" }, { message: userMessage, parts })
    assert.deepEqual({ message: userMessage, parts }, snapshot)
    const system = ["<base system>", "<another plugin>"]
    await transform(hooks, system, { sessionID: "s1" })
    assert.ok(system.some((s) => s.includes("<another plugin>")))
    assert.ok(system.some((s) => s.includes("<base system>")))
  })
})
