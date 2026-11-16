import assert from "node:assert/strict"
import { test } from "node:test"
import type { SessionContext } from "@opencode/plugin/promise/session"
import packageServer from "opencode-time-context"
import { createV2ContextHook, type V2Deps } from "../src/plugin.v2.ts"
import server from "../server.ts"
import tui from "../tui.ts"
import v1 from "../src/index.ts"

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
  const part = e.messages.at(-1)?.content[0]
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
  await hook({ context: async () => { assert.fail("must not read") } })(e)
  assert.equal(e.messages.length, 0)
})

test("v2: lookup failures, timeouts and logging failures fail open without invented history", async () => {
  for (const context of [async () => { throw new Error(SECRET) }, () => new Promise<Records>(() => {})]) {
    const e = event()
    await hook({ context, lookupTimeoutMs: 5, options: { debug: true }, log: () => { throw Error(SECRET) } })(e)
    assert.match(block(e), /UTC now:/)
    assert.doesNotMatch(block(e), /Latest user|Latest assistant|SECRET/)
  }
})

test("v2: session-local lookup; user anchors rescue from beyond the 64-record timeline window", async () => {
  // 66 records: the turn's own user record and an old assistant record sit
  // outside the 64-record tail window. The user must still anchor the block;
  // the out-of-window assistant must not (timeline processing stays bounded).
  const longRecords: Records = [
    { id: "a-out", type: "assistant", agent: "build", model: { providerID: "local", id: "model" },
      time: { created: NOW - 7000, completed: NOW - 6000 }, content: [] },
    { id: "u1", type: "user", time: { created: NOW - 10_000 }, text: SECRET },
    ...Array.from({ length: 64 }, (_, i) => ({
      id: `filler-${i}`, type: "user" as const, time: { created: NOW - 1000 }, text: SECRET,
    })),
  ]
  const run = hook({ context: async ({ sessionID }) => (sessionID === "session-a" ? records : longRecords) })
  const a = event()
  const b = event("session-b")
  b.messages = [
    { id: "u1", role: "user", content: [{ type: "text", text: SECRET }] },
    { id: "a-out", role: "assistant", content: [{ type: "text", text: SECRET }] },
  ] as SessionContext["messages"]
  await Promise.all([run(a), run(b)])
  assert.match(block(a), /Latest user message/)
  assert.match(block(a), /Latest assistant completion/)
  assert.match(block(b), /Latest user message: .*10 sec ago/)
  assert.doesNotMatch(block(b), /Latest assistant|Recent timeline/)
})

test("v2: a custom agent named like a v1 aux mode stays visible", async () => {
  const summaryRecords: Records = [
    { id: "u1", type: "user", time: { created: NOW - 10_000 }, text: SECRET },
    { id: "a1", type: "assistant", agent: "summary", model: { providerID: "local", id: "model" },
      time: { created: NOW - 9000, completed: NOW - 1000 }, content: [] },
  ]
  const e = event()
  await hook({ context: async () => summaryRecords })(e)
  assert.match(block(e), /Latest assistant completion: .*1 sec ago/)
})

test("v2: compaction and idle records never supply users or anchors", async () => {
  const mixed = [
    { id: "u1", type: "user", time: { created: NOW - 10_000 }, text: SECRET },
    { id: "m-comp", type: "compaction", agent: "", time: { created: NOW - 5000 } },
    { id: "m-idle", type: "idle", agent: "", time: { created: NOW - 4000 } },
  ] as unknown as Records
  const e = event()
  e.messages = [
    { id: "u1", role: "user", content: [{ type: "text", text: SECRET }] },
    { id: "m-comp", role: "user", content: [{ type: "text", text: SECRET }] },
    { id: "m-idle", role: "user", content: [{ type: "text", text: SECRET }] },
  ] as SessionContext["messages"]
  await hook({ context: async () => mixed })(e)
  assert.match(block(e), /Latest user message: .*10 sec ago/)
  assert.doesNotMatch(block(e), /Latest assistant|Recent timeline|Previous user/)
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

test("entrypoints: v1 function retained; v2 registers only context and disposes hook", async () => {
  assert.equal(typeof v1, "function")
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
