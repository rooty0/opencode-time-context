# AGENTS.md — opencode-time-context

Guidance for coding agents working in this repo. User-facing docs live in
README.md; don't copy them here. This file holds the verified runtime contract,
invariants, and verification recipes you must not break.

## Project layout

```
src/core.ts    Pure logic: config parsing, timezones/offsets, durations,
               model filtering, anchor selection, block assembly. Fully
               unit-tested, no opencode imports.
src/hooks.ts   Event mirror + the messages.transform injection. Imports core.
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
- `experimental.chat.messages.transform({}, {messages})` fires in
  `SessionPrompt.run`'s per-step loop once per model-visible request — initial
  call, every tool-continuation step, retries — right before
  `toModelMessagesEffect` converts the rows. The payload is rebuilt from the
  store per call, so appended rows are request-only (never persisted) and the
  site is self-sufficient: history, session, and model identity all come from
  the payload (`msg.info`) — no seeding fetch required. Conversions preserve
  array order and include user text parts (`synthetic` allowed).
- Provider prefix caching is positional: byte changes near the prompt front
  invalidate all later cache blocks. Never put per-request changing text in
  `system[]` entries — that's why injection moved from
  `experimental.chat.system.transform` (v1 of this plugin) to the tail.
- `event({event})` is fire-and-forget (not awaited). `message.updated` carries
  assistant `mode`/`summary`/`time` — enough to gate auxiliary agents.
- `client.app.log({body:{service, level, message, extra}})` is the logging
  channel; `--print-logs` surfaces it on stderr for `opencode run`.
- Plugin options come from the config tuple `["file://…/index.ts", {…}]`.
  Config/plugins load once at process start; no hot reload — module code is
  cached per process, so plugin source edits need a full OpenCode restart
  (instance churn alone does not reload code).
- The per-request model identity is on the turn's latest user message
  (`info.model.providerID/modelID`), snapshotted at admission — no event
  ordering dependency for the filter.

### Loading pitfalls (real, observed)

1. **Legacy adapter registers EVERY function-valued export as a plugin.**
   `src/index.ts` exporting a pure helper factory silently double-registered the
   hooks and produced a phantom default-options registration that won requests
   over the configured one. Entry module: one default export, nothing else.
2. **Cross-layer double declaration is not deduped** by file URL: the same file
   auto-discovered under `~/.config/opencode/plugin/` AND listed in a config
   array (or listed in two server-config layers) registers twice with competing
   options. Documented in README; declare the plugin in exactly one place.
3. **Server and TUI loading are separate.** The Plugins window lists only the
   TUI host, which reads `plugin` arrays from `tui.json` files (global/project),
   NOT the server `plugin` array in `opencode.jsonc`. A no-op TUI half
   (`src/tui.ts`) is registered so the plugin shows as active there.
4. **One module = one half.** `readV1Plugin` throws if a default export has both
   `server` and `tui`. Both halves live in one directory and are dispatched via
   `src/package.json` `exports` (`./server`, `./tui`) — the same pattern npm
   plugins use. A package.json with NO `./server` export would still fall back
   to the file itself as the server entry; the explicit export just documents
   intent. The canonical spec `file://…/src/index.ts` is valid in both
   `opencode.jsonc` (server) and `tui.json` (tui).

## Invariants — do not break these

1. Never cache "now". Compute per request via the injected clock (`deps.now`).
   Historical message times are cached and refreshed incrementally — never the
   current time.
2. Exactly one plugin block per request: sweep rows with the ephemeral message
   id before appending. Never touch real rows — only ever append one synthetic
   trailing user message; history must stay byte-stable for prefix caching.
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
7. Bounded resources: per-session maps capped; registry LRU-capped; block
   hard-capped by `maxBlockChars`. All history values come from the single
   request payload — no unbounded history scan, no extra fetches.
8. Request scope: primary agent turns + subagent turns only. Skip when the
   payload has no user message, or when the event mirror says the session's
   only pending assistant work is auxiliary (`compaction`/`title`/`summary`
   modes or `summary: true`). Title generation and late-evented compaction may
   still carry the block — known and harmless (~250 tokens, prompts that
   recompute anyway), documented in README.
9. ASCII-only in the injected block (quotes, dashes): some model pipelines mangle
   Unicode punctuation. Tests pin this implicitly via exact-match regexes.

## Design map

- `src/core.ts` is pure and knows nothing about OpenCode; push all
  decisions there (timezones, offsets, durations, filters, anchor selection,
  block assembly) so they stay testable without a server.
- `src/hooks.ts` owns: the event mirror (only `pendingAssistants` for aux-mode
  gating), the `experimental.chat.messages.transform` handler
  (enabled → sessionID from payload → aux gate → model from latest user
  message → derive marks from payload rows → build → sweep stale ephemeral row
  → append synthetic trailing message), and logging.
- Offsets come from `Intl` with `timeZoneName: "longOffset"`, recomputed per
  instant (DST-safe). Config timezone validated once at init; host local
  timezone is the fallback and the default.
- Placement invariant: the block is the LAST row of the payload. Everything
  before it must stay byte-identical across requests of a session (tests pin
  this against byte-equality). Only ever append; never edit real rows.

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
