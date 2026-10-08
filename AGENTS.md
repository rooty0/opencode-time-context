# AGENTS.md — opencode-time-context

Guidance for coding agents working in this repo. User-facing docs live in
README.md; don't copy them here. This file holds the verified runtime contract,
invariants, and verification recipes you must not break.

## Project layout

```
src/core.ts    Pure logic: config parsing, timezones/offsets, durations,
               model filtering, anchor selection, block assembly. No imports
               besides nothing (dependency-free). Fully unit-tested.
src/hooks.ts   State registry + hook implementations. Imports core.
src/index.ts   Plugin entry. MUST export only the default plugin function.
test/          node:test suites driving core directly and hooks via stubs.
```

## Commands

```bash
npm install          # devDeps: typescript, @opencode-ai/plugin 1.18.27, @types/bun
npm test             # node --test; Node >= 23.6 runs .ts natively (type stripping)
npm run typecheck    # tsc --noEmit --strict
```

Run both before committing. No build step: OpenCode loads the TypeScript source
directly at runtime (Bun), Node strips types in tests.

## Verified runtime contract (OpenCode 1.18.35, plugin pkg 1.18.27)

These were verified against the installed binary/source, not from docs. Re-verify
against the actual installed version before changing hook usage.

- V1-style promise API: plugin module default-exports
  `(input: PluginInput, options?) => Promise<Hooks>`.
- `experimental.chat.system.transform({sessionID?, model}, {system: string[]})`
  fires inside `LLMRequestPrep.prepare` once per model-visible request — initial
  call, every tool-continuation step, and retries. Awaited; mutate
  `output.system` in place. Entries land as system-role messages (or joined
  `instructions` on the OAuth/workflow paths). `model.providerID` + `model.id`
  are the request's actual model, evaluated per request (mid-session switches
  and subagents covered by construction).
- `chat.message({sessionID, ...}, {message, parts})` is awaited at user-message
  admission; `message.time.created` is the admission time (epoch ms).
- `event({event})` is fire-and-forget (not awaited). `message.updated` carries
  the full message info (`UserMessage.time.created`; `AssistantMessage`
  `time.created`/`time.completed`, `mode`, `summary`);
  `message.part.updated` carries tool parts (`state.time.start/end`,
  `state.status`). Events are near-synchronous in-process, but the hooks treat
  them as eventually-consistent; the bounded seed read is the backstop.
- `client.session.messages({path:{id}, query:{limit}})` returns persisted
  `{info, parts}[]` — the authoritative resume source.
- `client.app.log({body:{service, level, message, extra}})` is the logging
  channel; `--print-logs` surfaces it on stderr for `opencode run`.
- Plugin options come from the config tuple `["file://…/index.ts", {…}]`.
  Config/plugins load once at process start; no hot reload.
- Session storage (`~/.local/share/opencode/opencode.db`) outlives process
  restarts; `AssistantMessage.summary: true` marks compaction summaries.

### Loading pitfalls (real, observed)

1. **Legacy adapter registers EVERY function-valued export as a plugin.**
   `src/index.ts` exporting a pure helper factory silently double-registered the
   hooks and produced a phantom default-options registration that won requests
   over the configured one. Entry module: one default export, nothing else.
2. **Cross-layer double declaration is not deduped** by file URL: the same file
   auto-discovered under `~/.config/opencode/plugin/` AND listed in a config
   array (or listed in two config layers) registers twice with competing
   options. Documented in README; declare the plugin in exactly one place.

## Invariants — do not break these

1. Never cache "now". Compute per request via the injected clock (`deps.now`).
   Historical message times are cached and refreshed incrementally — never the
   current time.
2. Exactly one plugin block per request: sweep the `[OpenCode time context]`
   marker before pushing. Never touch other system entries or user messages.
3. Fail open everywhere: hooks must not throw (a rejected hook poisons the
   request). Wrap hook bodies in try/catch; on errors skip or degrade, never
   fabricate timestamps. Missing/invalid times → omit that line. Negative
   durations → clamp. Far-future anchors (>60s) → drop.
4. Nothing prompt-derived crosses boundaries: the block, the state, and the logs
   contain only roles, coarse event kinds, tool NAMES, and timestamps. Assert
   this in tests (see the SECRET-PROMPT-CONTENTS fixture).
5. Session isolation: state keyed by sessionID; a child (subagent) session gets
   only its own timeline. `Session.parentID` is not used to merge.
6. Model matching is exact and case-sensitive: full `providerID/modelID`, or an
   entry equal to the bare `modelID` matches that model on any provider.
   Exclusion wins. Unknown identity: inject when no filters configured; skip +
   log one diagnostic when filters exist. Evaluated per request, never at init.
7. Bounded resources: per-session maps capped; registry LRU-capped; seed read
   `limit: 64`; block hard-capped by `maxBlockChars`. No unbounded history scan
   on the request path.
8. Request scope: primary agent turns + subagent turns only. Skip when the only
   pending assistant(s) are aux modes (`compaction`/`title`/`summary` or
   `summary: true`), when there is no sessionID, or when the session has no
   trace anywhere (synthetic ids). Title generation leaks the block on its one
   request — known, inherent to this hook's inputs, documented in README.
9. ASCII-only in the injected block (quotes, dashes): some model pipelines mangle
   Unicode punctuation. Tests pin this implicitly via exact-match regexes.

## Design map

- `src/core.ts` is pure and knows nothing about OpenCode; push all
  decisions there (timezones, offsets, durations, filters, anchor selection,
  block assembly) so they stay testable without a server.
- `src/hooks.ts` owns: per-session mirror (`users`/`assistants`/`tools`/
  `pendingAssistants`), chat.message admission capture, event merging, the
  one-time seed fetch (`seed: never → ok|failed`, promise-collapsed), the
  injection gate (enabled → model filter → sessionID → aux check →
  reality check → build → marker sweep → push), logging.
- Offsets come from `Intl` with `timeZoneName: "longOffset"`, recomputed per
  instant (DST-safe). Config timezone validated once at init; host local
  timezone is the fallback and the default.

## Testing

- `test/core.test.ts` — pure: temporal semantics (midnights, DST, skew),
  filtering matrix, anchor selection, block caps. Fake clock = pass `now`.
- `test/index.test.ts` — hooks with a stub client (in-memory
  `session.messages`, capture-log) and driven events. `transform()` in that
  file reproduces opencode 1.18.35's system-array post-processing (collapse
  when plugins appended >1 entries) so tests assert on what providers receive.
- When adding behavior: unit-test the pure part, hook-test the wiring, and keep
  matrix-style test names referencing the requirement numbers.

## End-to-end verification (after changes to injection/filtering)

Never claim model-visible delivery from logs alone — make the model quote it:

```bash
# 1. Injection present, fresh values:
cd /private/tmp/oc-smoke && opencode run -m local-vllm/moonshotai/Kimi-K3 \
  'Without calling any tool: if your instructions contain a block starting
   with "[OpenCode time context]", quote that whole block verbatim; otherwise
   reply exactly NO_BLOCK'

# 2. Filter governs the request (project-level tuple with options):
mkdir -p /private/tmp/oc-filter && cat > /private/tmp/oc-filter/opencode.json <<'EOF'
{ "plugin": [["file:///ABS/PATH/opencode-time-context/src/index.ts",
  { "excludeModels": ["local-vllm/moonshotai/Kimi-K3"], "debug": true }]] }
EOF
cd /private/tmp/oc-filter && opencode run -m local-vllm/moonshotai/Kimi-K3 \
  --print-logs --log-level DEBUG '…same prompt…'
# expect: NO_BLOCK + debug log 'injection skipped: … blocked by excludeModels'

# 3. Resume (`--continue` shows seeded history), subagent isolation (task tool
#    with subagent_type explore; child's "Latest user message" differs from
#    parent's). See git history / smoke logs for observed outputs.
```

`opencode run` boots a fresh process, so it always loads current code/config —
no restart of other sessions needed for verification.

## House style

- Comments explain *why* (non-obvious runtime behavior, version-specific
  pitfalls), not *what*. No narration of the code's own actions.
- Keep third-party deps at zero for `src/`; devDeps pin to the installed
  OpenCode plugin package version for type fidelity.
- README is for humans (install/config/support); this file is for agents.
  Update both when behavior, options, or invariants change.
