import assert from "node:assert/strict"
import { test } from "node:test"
import type { SessionContext } from "@opencode/plugin/promise/session"
import packageServer from "opencode-time-context"
import { createV2ContextHook, type V2Deps } from "../src/plugin.v2.ts"
import server from "../server.ts"
import tui from "../tui.ts"

const NOW = Date.UTC(2026, 9, 15, 12)
const SECRET = "SECRET-PROMPT-CONTENTS"
type Records = Awaited<ReturnType<V2Deps["context"]>>
function event(sessionID = "session-a"): SessionContext {
  return { sessionID, agent: "build", model: { providerID: "local", id: "model" },
    system: [{ text: SECRET }], options: {}, tools: {},
    messages: [{ id: "u1", role: "user", content: [{ type: "text", text: SECRET }] },
      { id: "a1", role: "assistant", content: [{ type: "text", text: SECRET }] }],
  } as unknown as SessionContext
}
const records: Records = [
  { id: "u1", type: "user", time: { created: NOW - 10_000 }, text: SECRET },
  { id: "a1", type: "assistant", agent: "build", model: { providerID: "local", id: "model" },
    time: { created: NOW - 9000, completed: NOW - 1000 }, content: [
      { type: "tool", id: "t1", name: "bash", time: { created: NOW - 8000, completed: NOW - 2000 },
        state: { status: "completed", input: { secret: SECRET }, content: [{ type: "text", text: SECRET }] } },
    ] },
]
function block(e: SessionContext) {
  const tail = e.messages.at(-1)
  assert.equal(tail?.role, "user", "tail message role")
  assert.equal(tail?.id, "msg_time_context_ephemeral", "tail message id")
  const part = tail?.content[0]
  assert.equal(part?.type, "text")
  return (part as { text: string }).text
}
function hook(overrides: Partial<V2Deps> = {}) {
  return createV2ContextHook({ context: async () => records, now: () => NOW, hostTimezone: "UTC", ...overrides })
}

test("v2: tail-only, fresh clock, recorded tool times, no bodies, no duplicate block", async () => {
  const e = event(), prefix = JSON.stringify(e), logs: string[] = []
  let now = NOW
  const run = hook({ now: () => now, options: { debug: true }, log: (s) => logs.push(s) })
  await run(e)
  assert.match(block(e), /Latest user message:.*10 sec ago/)
  assert.match(block(e), /Latest assistant completion:/)
  assert.match(block(e), /tool "bash" finished/)
  assert.doesNotMatch(block(e), new RegExp(SECRET))
  assert.ok(!logs.join().includes(SECRET))
  assert.equal(JSON.stringify({ ...e, messages: e.messages.slice(0, -1) }), prefix)
  now += 5000
  await run(e)
  assert.equal(e.messages.length, 3)
  assert.match(block(e), /15 sec ago/)
})

test("v2: filters use request model, exclusion wins, disabled/no-user requests do no reads", async () => {
  for (const options of [{ enabled: false }, { includeModels: ["wrong"] },
    { includeModels: ["model"], excludeModels: ["local/model"] }]) {
    let reads = 0
    const e = event()
    await hook({ options, context: async () => { reads++; return records } })(e)
    assert.equal(e.messages.length, 2)
    assert.equal(reads, 0)
  }
  const e = event()
  const run = hook({ options: { includeModels: ["local/model"] } })
  await run(e)
  assert.equal(e.messages.length, 3)
  Object.assign(e, { model: { providerID: "other", id: "model" } })
  await run(e)
  assert.equal(e.messages.length, 2)
  e.messages = []
  let reads = 0
  await hook({ context: async () => { reads++; return records } })(e)
  assert.equal(e.messages.length, 0)
  assert.equal(reads, 0)
})

test("v2: lookup failures, timeouts and logging failures fail open without invented history", async () => {
  for (const context of [async () => { throw new Error(SECRET) }, () => new Promise<Records>(() => {})]) {
    const e = event()
    await hook({ context, lookupTimeoutMs: 5, options: { debug: true }, log: () => { throw Error(SECRET) } })(e)
    assert.match(block(e), /UTC now:/)
    assert.doesNotMatch(block(e), /Latest user|Latest assistant|SECRET/)
  }
})

test("v2: session-local lookup; the 64-record window boundary is exact, user anchors exempt", async () => {
  // 68 records, cutoff = 4: indices 0-3 sit outside the tail window.
  // u1 (idx 0) must be rescued as a user anchor; a-out (idx 1) and a-edge
  // (idx 3, one below the cutoff) must NOT anchor; a-in (idx 4, exactly at
  // the cutoff) and its tool must. Any off-by-one in the cutoff fails one
  // of the assertions below.
  const longRecords: Records = [
    { id: "u1", type: "user", time: { created: NOW - 10_000 }, text: SECRET },
    { id: "a-out", type: "assistant", agent: "build", model: { providerID: "local", id: "model" },
      time: { created: NOW - 7000, completed: NOW - 6900 }, content: [
        { type: "tool", id: "t-out", name: "bash", time: { created: NOW - 6800, completed: NOW - 6700 },
          state: { status: "completed", input: {}, content: [{ type: "text", text: SECRET }] } },
      ] },
    { id: "gap-filler", type: "user", time: { created: NOW - 5500 }, text: SECRET },
    { id: "a-edge", type: "assistant", agent: "build", model: { providerID: "local", id: "model" },
      time: { created: NOW - 5000, completed: NOW - 4400 }, content: [] },
    { id: "a-in", type: "assistant", agent: "build", model: { providerID: "local", id: "model" },
      time: { created: NOW - 4000, completed: NOW - 3000 }, content: [
        { type: "tool", id: "t-in", name: "read", time: { created: NOW - 2500, completed: NOW - 2000 },
          state: { status: "completed", input: {}, content: [{ type: "text", text: SECRET }] } },
      ] },
    ...Array.from({ length: 63 }, (_, i) => ({
      id: `filler-${i}`, type: "user" as const, time: { created: NOW - 1000 }, text: SECRET,
    })),
  ]
  const run = hook({ context: async ({ sessionID }) => (sessionID === "session-a" ? records : longRecords) })
  const a = event()
  const b = event("session-b")
  b.messages = [
    { id: "u1", role: "user", content: [{ type: "text", text: SECRET }] },
    { id: "a-out", role: "assistant", content: [{ type: "text", text: SECRET }] },
    { id: "a-edge", role: "assistant", content: [{ type: "text", text: SECRET }] },
    { id: "a-in", role: "assistant", content: [{ type: "text", text: SECRET }] },
  ] as SessionContext["messages"]
  await Promise.all([run(a), run(b)])
  assert.match(block(a), /Latest user message/)
  assert.match(block(a), /Latest assistant completion/)
  assert.match(block(b), /Latest user message: .*10 sec ago/)
  assert.match(block(b), /Latest assistant completion: .*3 sec ago/)
  assert.match(block(b), /tool "read" finished/)
  assert.doesNotMatch(block(b), /Previous user|7 sec ago|tool "bash"/)
  // the timeline must hold only the in-window tool anchor; a permissive
  // cutoff would leak a-edge as an extra assistant anchor
  assert.equal((block(b).match(/assistant message completed/g) ?? []).length, 0)
})

test("v2: agent names never get filtered (an agent named summary stays visible)", async () => {
  const summaryRecords: Records = [
    { id: "u1", type: "user", time: { created: NOW - 10_000 }, text: SECRET },
    { id: "a1", type: "assistant", agent: "summary", model: { providerID: "local", id: "model" },
      time: { created: NOW - 9000, completed: NOW - 1000 }, content: [] },
  ]
  const e = event()
  await hook({ context: async () => summaryRecords })(e)
  assert.match(block(e), /Latest assistant completion: .*1 sec ago/)
})

test("v2: compaction, idle and synthetic records never supply users or anchors", async () => {
  const mixed = [
    { id: "u1", type: "user", time: { created: NOW - 10_000 }, text: SECRET },
    { id: "m-comp", type: "compaction", agent: "", time: { created: NOW - 5000 } },
    { id: "m-idle", type: "idle", agent: "", time: { created: NOW - 4000 } },
    { id: "m-syn", type: "synthetic", agent: "", time: { created: NOW - 3000 } },
  ] as unknown as Records
  const e = event()
  e.messages = [
    { id: "u1", role: "user", content: [{ type: "text", text: SECRET }] },
    { id: "m-comp", role: "user", content: [{ type: "text", text: SECRET }] },
    { id: "m-idle", role: "user", content: [{ type: "text", text: SECRET }] },
    { id: "m-syn", role: "user", content: [{ type: "text", text: SECRET }] },
  ] as SessionContext["messages"]
  await hook({ context: async () => mixed })(e)
  assert.match(block(e), /Latest user message: .*10 sec ago/)
  assert.doesNotMatch(block(e), /Latest assistant|Recent timeline|Previous user/)
})

test("v2: garbage history timestamps are omitted, never fabricated, through the hook", async () => {
  const garbage: Records = [
    { id: "u1", type: "user", time: { created: Number.NaN }, text: SECRET },
    { id: "u2", type: "user", time: { created: -5 }, text: SECRET },
    { id: "a1", type: "assistant", agent: "build", model: { providerID: "local", id: "model" },
      time: { created: NOW - 9000, completed: NOW + 10 * 60_000 }, content: [] },
  ]
  const e = event()
  e.messages = [
    { id: "u1", role: "user", content: [{ type: "text", text: SECRET }] },
    { id: "u2", role: "user", content: [{ type: "text", text: SECRET }] },
    { id: "a1", role: "assistant", content: [{ type: "text", text: SECRET }] },
  ] as SessionContext["messages"]
  await hook({ context: async () => garbage })(e)
  const text = block(e)
  assert.match(text, /UTC now:/)
  assert.doesNotMatch(text, /Latest user message|Latest assistant|Recent timeline|NaN/)
})

test("v2: running tool parts are excluded and errored tools render as failed", async () => {
  const toolRecords: Records = [
    { id: "u1", type: "user", time: { created: NOW - 10_000 }, text: SECRET },
    { id: "a1", type: "assistant", agent: "build", model: { providerID: "local", id: "model" },
      time: { created: NOW - 9000, completed: NOW - 1000 }, content: [
        { type: "tool", id: "t-run", name: "bash", time: { created: NOW - 8000, completed: NOW - 5000 },
          state: { status: "running", input: {}, metadata: {} } },
        { type: "tool", id: "t-err", name: "read", time: { created: NOW - 8000, completed: NOW - 2000 },
          state: { status: "error", input: {}, error: { type: "Error", message: SECRET }, content: [{ type: "text", text: SECRET }] } },
      ] },
  ]
  const e = event()
  await hook({ context: async () => toolRecords })(e)
  assert.match(block(e), /tool "read" failed/)
  assert.doesNotMatch(block(e), /tool "bash" (finished|failed)/)
})

test("v2: unknown model identity skips only when filters are configured", async () => {
  const noModel = () => {
    const e = event()
    ;(e as unknown as { model?: unknown }).model = undefined
    return e
  }
  let reads = 0
  const read = async () => { reads++; return records }
  const skipped = noModel()
  await hook({ context: read, options: { includeModels: ["local/model"] } })(skipped)
  assert.equal(skipped.messages.length, 2)
  assert.equal(reads, 0)
  const injected = noModel()
  await hook({ context: read })(injected)
  assert.equal(injected.messages.length, 3)
})

test("v2: a frozen request message array fails open without throwing", async () => {
  const e = event()
  Object.freeze(e.messages)
  await hook()(e)
  assert.equal(e.messages.length, 2)
})

test("v2: a synchronously throwing lookup degrades to fresh current time", async () => {
  const e = event()
  await hook({ context: () => { throw new Error(SECRET) } })(e)
  assert.match(block(e), /UTC now:/)
  assert.doesNotMatch(block(e), /Latest user|Latest assistant|SECRET/)
})

test("v2: lookups settling after the deadline stay fail-open with no unhandled rejection", async () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on("unhandledRejection", onUnhandled)
  try {
    const settling = [
      () => new Promise<Records>((resolve) => { setTimeout(() => resolve(records), 40) }),
      () => new Promise<Records>((_, reject) => { setTimeout(() => reject(new Error("late")), 40) }),
    ]
    for (const context of settling) {
      const e = event()
      await hook({ context, lookupTimeoutMs: 5 })(e)
      assert.match(block(e), /UTC now:/)
      assert.doesNotMatch(block(e), /Latest user|Latest assistant/)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
  assert.equal(unhandled.length, 0)
})

test("v2: configured timezone wins over the host's; anchors and caps flow through options", async () => {
  const configured = event()
  await hook({ options: { timezone: "America/Los_Angeles" }, hostTimezone: "Europe/Paris" })(configured)
  assert.match(block(configured), /, America\/Los_Angeles\)/)
  assert.doesNotMatch(block(configured), /Europe\/Paris/)
  const fallback = event()
  await hook({ hostTimezone: "Europe/Paris" })(fallback)
  assert.match(block(fallback), /, Europe\/Paris\)/)
  const capped = event()
  await hook({ options: { historyAnchorsLimit: 0 } })(capped)
  assert.doesNotMatch(block(capped), /Recent timeline/)
  const trimmed = event()
  await hook({ options: { maxBlockChars: 300 } })(trimmed)
  assert.ok(block(trimmed).length <= 300)
})

test("entrypoints: registers only context and disposes hook", async () => {
  assert.equal(packageServer, server)
  assert.equal(packageServer.id, "opencode-time-context")
  assert.equal(typeof tui.setup, "function")
  let disposed = false
  const cleanup = await server.setup({ options: {}, session: {
    context: async () => [], hook: async (name: string, callback: unknown) => {
      assert.equal(name, "context")
      assert.equal(typeof callback, "function")
      return { dispose: async () => { disposed = true } }
    },
  } } as unknown as Parameters<typeof server.setup>[0])
  await cleanup()
  assert.equal(disposed, true)
})
