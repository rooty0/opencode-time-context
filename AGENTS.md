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
src/plugin.v2.ts V2 context hook + read-only timestamp lookup.
server.ts      V2 directory entry; tui.ts is its no-op TUI half.
src/index.ts   V1 plugin entry. MUST export only the default plugin function.
test/          node:test suites driving core directly and hooks via stubs.
```

## Commands

```bash
npm install          # devDeps include both V1 and V2 plugin SDK types
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
   Historical message times are derived per request; no timestamp cache.
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
   Exclusion wins. Unknown identity: inject when no filters configured; skip when filters exist (V1 dedupes diagnostics; V2 logs per request
   only with debug enabled). Evaluated per request, never at init.
7. Bounded resources: per-session maps capped; registry LRU-capped; block
   hard-capped by `maxBlockChars`. V1 history comes from the single
   request payload. V2 reads active context with a deadline and processes only
   the last 64 records (see the V2 contract below).
8. Request scope: primary agent turns + subagent turns only. Skip when the
   payload has no user message, or when the event mirror says the session's
   only pending assistant work is auxiliary (`compaction`/`title`/`summary`
   modes or `summary: true`). Title generation and late-evented compaction may
   still carry the block — known and harmless (~250 tokens, prompts that
   recompute anyway), documented in README.
9. ASCII-only in the injected block (quotes, dashes): some model pipelines mangle
   Unicode punctuation. An explicit ASCII test covers timeline punctuation.

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

V1 `opencode run` boots a fresh process; V2 requires `--standalone` to do so —
no restart of other sessions needed for verification.

## House style

- Comments explain *why* (non-obvious runtime behavior, version-specific
  pitfalls), not *what*. No narration of the code's own actions.
- Keep third-party deps at zero for `src/`; devDeps pin to the installed
  OpenCode plugin package version for type fidelity.
- README is for humans (install/config/support); this file is for agents.
  Update both when behavior, options, or invariants change.

## Decisions (with rationale — read before re-litigating)

Mechanism-level facts live in "Verified runtime contract" above; this section
records the judgment calls and their rejected alternatives.

1. **Tail append, not system-layer injection.** A volatile per-request string in
   `system[]` sits before the whole history; positional KV prefix caches then
   invalidate everything after it each turn (measured on vLLM-B300: hit rate
   pinned ~17% with full-history prefills every ~35 s). Same failure fixed
   third-party in opencode-agent-memory PR #25 (~10% → ~90% hit rate).
   Rejected alternative: revert to `system.transform` with minute-bucketed
   timestamps — still periodic full-prefill storms, and it degrades the core
   feature (freshness) to save a problem we no longer have.
2. **Per-request refresh, not diff-gated re-emission.** Codex re-emits its env
   date only when it changes (day granularity) and its open issue #38333
   documents a "repetition attractor" from identical text repeated across tool
   loops. We accept per-request refresh because: the block lives in the tail
   region that recomputes regardless (zero cache cost), the content changes
   every request (which defeats attractor drift, unlike Codex's static repeat),
   and the feature's entire premise is sub-minute freshness across long turns.
   Fallback hedge if tool-loop repetition symptoms ever appear: add a refresh
   interval option (e.g. refresh Now at most every N seconds within a turn).
3. **Ephemeral-only, never persisted.** The block exists only in the outgoing
   request payload. Anything written into the stored transcript permanently
   freezes the claim ("15 sec ago" forever) — that's the failure mode of
   message-mutation plugins like opencode-time-refresh. afriemann/opencode-timed
   is the good prior art for this discipline; its tradeoff (in-memory store
   empties on restart, old stamps vanish) we avoid by deriving everything from
   persisted payload metadata instead of recording it ourselves.
4. **Filtering is exact-match with exclusion winning, evaluated per request.**
   Rejected: substring/fuzzy matching (accidental matches across similar model
   ids, the exact thing the task warned about) and init-time filtering (breaks
   on mid-session model switch). Model identity comes from the latest user
   message's snapshot, so per-request evaluation is free of event ordering.
5. **Aux-suppression tolerates rare leaks over risky synchronous gating.**
   Title generation runs inline without touching our hook; a compaction whose
   in-flight assistant event hasn't landed yet may carry one block (~250 tokens
   into a prompt that recomputes anyway). Deliberately accepted: the
   alternative (blocking the request path to query state) violates fail-open.
6. **Single-layer config only.** Declaring the plugin in two config layers
   double-registers it in 1.18.35 with competing options (verified live).
   We document the pitfall instead of building config-snapshot merging to
   defend against it.

## V2 runtime contract (OpenCode / @opencode/plugin 2.0.25)

- Root `server.ts` default-exports `{id, setup}`. `setup` awaits registration
  and returns a cleanup that disposes it. Root `tui.ts` is a no-op V2 definition.
  V2 local directory loading resolves these files. Keep `src/index.ts` and
  `src/package.json` unchanged for the separate legacy V1 entry.
- `src/plugin.v2.ts` registers only `ctx.session.hook("context")`, per primary
  model request, including tool continuations and subagents. Auxiliary title,
  compaction, and generate requests have separate hooks; do not register them.
- Request model identity is `event.model.providerID/id`. Messages expose IDs,
  roles, and content but **no recorded timestamps**. Append a plain trailing
  user model message; never mutate the admission `prompt` hook or system array.
- Necessary exception to V1's no-extra-fetch rule: read the public
  `ctx.session.context({sessionID})` once per eligible request. It returns the
  whole active context, without a limit argument. Process only its last 64
  records and intersect outgoing message IDs. This avoids reintroducing pruned
  history or treating synthetic/compaction user-role messages as real users.
  No history pagination, private API, database access, or cached message bodies.
- Context lookup races a one-second deadline and abort signal. Missing history
  degrades to fresh current time. Error objects are not logged (they may contain
  prompt text). All state is per invocation; no cross-session timestamp cache.
- Stored V2 user/assistant `time.created/completed` and assistant tool
  `time.completed` are numeric epoch milliseconds through the promise API.
- `test/v2.test.ts` verifies fresh tail-only injection, byte-stable prefix,
  deduplication, filters, failures/timeouts, session isolation, bounded record
  processing, privacy, and registration disposal. Both SDK dependencies are
  type-only; production has no third-party runtime imports.
- For V2 smoke tests use the directory URL and `opencode run --standalone`
  with isolated XDG directories. Ask the real model to quote its final block,
  resume the session, check a tool continuation, test exclusion, and inspect
  stored message IDs to ensure the ephemeral row was not persisted.
