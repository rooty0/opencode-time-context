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

test("v2: context lookup is session-local and only last 64 matching records supply times", async () => {
  const run = hook({ context: async ({ sessionID }) => {
    if (sessionID === "session-a") return records
    return [records[0]!, ...Array.from({ length: 64 }, (_, i) => ({
      id: `other-${i}`, type: "user" as const, time: { created: NOW - 1000 }, text: SECRET,
    }))]
  } })
  const a = event(), b = event("session-b")
  await Promise.all([run(a), run(b)])
  assert.match(block(a), /Latest user message/)
  assert.doesNotMatch(block(b), /Latest user|Latest assistant/)
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
