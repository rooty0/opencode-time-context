# AGENTS.md — opencode-time-context

Guidance for coding agents working in this repo. User-facing docs live in
README.md; don't copy them here. This file holds the verified runtime contract,
invariants, and verification recipes you must not break.

## Project layout

```
src/core.ts      Pure logic: config parsing, timezones/offsets, durations,
                 model filtering, anchor selection, block assembly. Fully
                 unit-tested, no opencode imports.
src/plugin.v2.ts The context hook + read-only timestamp lookup. Imports core.
server.ts        Package entry; tui.ts is its no-op TUI half.
test/            node:test suites driving core directly and the hook via stubs.
```

## Commands

```bash
npm install          # the @opencode/plugin devDep provides the SDK types
npm test             # node --test; Node >= 23.6 runs .ts natively (type stripping)
npm run typecheck    # tsc --noEmit (strict comes from tsconfig)
```

Run both before committing. No build step: OpenCode loads the TypeScript source
directly at runtime (Bun), Node strips types in tests.

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
4. Nothing prompt-derived crosses boundaries: the block and the logs contain
   only roles, coarse event kinds, tool NAMES, and timestamps. Assert
   this in tests (see the SECRET-PROMPT-CONTENTS fixture).
5. Session isolation: the context lookup is keyed by the request's sessionID; a
   child (subagent) session gets only its own timeline. `Session.parentID` is
   not used to merge.
6. Model matching is exact and case-sensitive: full `providerID/modelID`, or an
   entry equal to the bare `modelID` matches that model on any provider.
   Exclusion wins. Unknown identity: inject when no filters configured; skip
   when filters exist (logged per request only with debug enabled). Evaluated
   per request, never at init.
7. Bounded resources: block hard-capped by `maxBlockChars`. Active context is
   read with a deadline; assistant records (the latest-assistant headline and
   the assistant/tool timeline) are bounded to the last 64 records, while user
   anchors scan the whole returned context (id + created only - see the
   runtime contract below).
8. Request scope: primary agent turns + subagent turns only (the `context`
   hook). Requests without user messages and models filtered out are skipped.
   Title, compaction, and generate requests have separate hooks and receive no
   injection.
9. ASCII-only in the injected block (quotes, dashes): some model pipelines mangle
   Unicode punctuation. An explicit ASCII test covers timeline punctuation.

## Design map

- `src/core.ts` is pure and knows nothing about OpenCode; push all
  decisions there (timezones, offsets, durations, filters, anchor selection,
  block assembly) so they stay testable without a server.
- Offsets come from `Intl` with `timeZoneName: "longOffset"`, recomputed per
  instant (DST-safe). Config timezone validated once at init; host local
  timezone is the fallback and the default.
- Placement invariant: the block is the LAST row of the request. Everything
  before it must stay byte-identical across requests of a session (tests pin
  this against byte-equality). Only ever append; never edit real rows.

## Testing

- `test/core.test.ts` — pure: temporal semantics (midnights, DST, skew),
  filtering matrix, anchor selection, block caps. Fake clock = pass `now`.
- `test/v2.test.ts` — the context hook with stubbed lookups: injection and
  dedup, filters, failure/timeout paths, window and record-type semantics,
  registration disposal.
- When adding behavior: unit-test the pure part, hook-test the wiring, and name
  tests after the behavior they pin.

## End-to-end verification (after changes to injection/filtering)

Never claim model-visible delivery from logs alone — make the model quote it:

```bash
# 1. Injection present, fresh values. Isolated XDG + --standalone: a minimal
#    config declares ONLY this plugin, keeping the test off the shared service
#    and the real global config:
export XDG_CONFIG_HOME=/private/tmp/oc-xdg && mkdir -p "$XDG_CONFIG_HOME/opencode"
printf '{ "plugins": ["file:///ABS/PATH/opencode-time-context"] }\n' \
  > "$XDG_CONFIG_HOME/opencode/opencode.json"
cd /private/tmp/oc-smoke && opencode run --standalone \
  'Without calling any tool: if this conversation contains a block starting
   with "[OpenCode time context]", quote that whole block verbatim; otherwise
   reply exactly NO_BLOCK'

# 2. Filter governs the request. A DIFFERENT empty XDG root, so the project
#    config below is the only declaration (never combine this with a global
#    install - that is the double declaration README warns about):
mkdir -p /private/tmp/oc-filter-xdg /private/tmp/oc-filter
cat > /private/tmp/oc-filter/opencode.json <<'EOF'
{ "plugins": [{ "package": "file:///ABS/PATH/opencode-time-context",
  "options": { "excludeModels": ["<providerID>/<modelID>"], "debug": true } }] }
EOF
cd /private/tmp/oc-filter && XDG_CONFIG_HOME=/private/tmp/oc-filter-xdg opencode run --standalone \
  -m <providerID>/<modelID> '…same prompt…'
# expect: NO_BLOCK

# 3. Resume (`--continue` shows seeded history), subagent isolation (task tool
#    with subagent_type explore; child's "Latest user message" differs from
#    parent's). Inspect stored message IDs to confirm the ephemeral row was
#    not persisted. See git history / smoke logs for observed outputs.
```

## House style

- Comments explain *why* (non-obvious runtime behavior, version-specific
  pitfalls), not *what*. No narration of the code's own actions.
- Keep third-party deps at zero for `src/`; devDeps pin to the installed
  OpenCode plugin package version for type fidelity.
- README is for humans (install/config/support); this file is for agents.
  Update both when behavior, options, or invariants change.

## Decisions (with rationale — read before re-litigating)

Mechanism-level facts live in "Runtime contract" below; this section records
the judgment calls and their rejected alternatives.

1. **Tail append, not system-layer injection.** A volatile per-request string in
   `system[]` sits before the whole history; positional KV prefix caches then
   invalidate everything after it each turn (measured on vLLM-B300: hit rate
   pinned ~17% with full-history prefills every ~35 s). Same failure fixed
   third-party in opencode-agent-memory PR #25 (~10% → ~90% hit rate).
   Tail placement earns those hits on implicit-cache routes only -
   explicit-breakpoint hosts are the exception (see the runtime contract's
   cache bullet).
   Rejected alternative: system-layer injection with minute-bucketed timestamps
   — still periodic full-prefill storms, and it degrades the core feature
   (freshness) to save a problem we no longer have.
2. **Per-request refresh, not diff-gated re-emission.** Codex re-emits its env
   date only when it changes (day granularity) and its open issue #38333
   documents a "repetition attractor" from identical text repeated across tool
   loops. We accept per-request refresh because: the block lives in the tail
   region that implicit-cache routes recompute regardless (explicit-breakpoint
   hosts are the exception - see the cache bullet in the runtime contract),
   the content changes every request (which defeats attractor drift, unlike
   Codex's static repeat), and the feature's entire premise is sub-minute
   freshness across long turns.
   Fallback hedge if tool-loop repetition symptoms ever appear: add a refresh
   interval option (e.g. refresh Now at most every N seconds within a turn).
   (This hedge addresses attractor drift only: on explicit-breakpoint routes
   the cache penalty is positional, so diff-gating the block's content would
   not help there.)
3. **Ephemeral-only, never persisted.** The block exists only in the outgoing
   request payload. Anything written into the stored transcript permanently
   freezes the claim ("15 sec ago" forever) — that's the failure mode of
   message-mutation plugins like opencode-time-refresh. afriemann/opencode-timed
   is the good prior art for this discipline; its tradeoff (in-memory store
   empties on restart, old stamps vanish) we avoid by deriving every time from
   the session store per request instead of recording anything ourselves.
4. **Filtering is exact-match with exclusion winning, evaluated per request.**
   Rejected: substring/fuzzy matching (accidental matches across similar model
   ids) and init-time filtering (breaks on mid-session model switch). Model
   identity comes from the request's `event.model`, so per-request evaluation
   has no event ordering to worry about.
5. **Single-layer config only.** OpenCode 2.3.0 rejects duplicate plugin IDs at
   load, but competing options across layers remain a footgun; the documented
   shape is one global entry with one options object.

## Runtime contract (OpenCode / @opencode/plugin 2.3.0)

- Root `server.ts` default-exports `{id, setup}`. `setup` awaits registration
  and returns a cleanup that disposes it. Root `tui.ts` is a no-op TUI
  definition. The root package export map must point `.`/`./server` to
  `server.ts` and `./tui` to `tui.ts`: OpenCode follows package exports before
  filename conventions.
- `src/plugin.v2.ts` registers only `ctx.session.hook("context")`, per primary
  model request, including tool continuations and subagents. Auxiliary title,
  compaction, and generate requests have separate hooks; do not register them.
- Request model identity is `event.model.providerID/id`. Messages expose IDs,
  roles, and content but **no recorded timestamps**. Append a plain trailing
  user model message; never mutate the admission `prompt` hook or system array.
- The one sanctioned extra read: `ctx.session.context({sessionID})` once per
  eligible request. It returns the whole active context, without a limit
  argument. Intersect outgoing message IDs, process the last 64 records for
  the assistant records (latest-assistant headline and timeline), and scan
  the whole returned context for user
  anchors (id + created only). This avoids reintroducing pruned history or
  treating synthetic/compaction user-role messages as real users. No history
  pagination, private API, database access, or cached message bodies. The
  user-anchor scan is exempt from the window because a long turn stores one
  assistant record per model step, which pushes the turn's own user record past
  any fixed tail window (`test/v2.test.ts` pins the split).
- The context record union has more members than user/assistant/idle/compaction
  (verified live 2026-11-16: compaction rows are their own type, not assistant
  modes); the adapter positively matches only `user` and `assistant`, so every
  other record type - compaction, idle, synthetic, and the rest - is skipped
  by type. Agent names are never filtered, so a custom agent with a name like
  "summary" stays visible (`test/v2.test.ts` pins it).
- Context lookup races a one-second deadline; the abort signal passed beside it
  is dropped by the promise-API adapter (it accepts only the input object), so
  the deadline - not the signal - bounds the lookup, and the race timer is
  always cleared. Missing history degrades to fresh current time. Error objects
  are not logged (they may contain prompt text). All state is per invocation;
  no cross-session timestamp cache.
- Stored user/assistant `time.created/completed` and assistant tool
  `time.completed` are numeric epoch milliseconds through the promise API.
- Loading and types: the devDependency is type-only - the host serves the SDK
  at runtime and throws if a plugin loads its own copy - so keep the exact pin.
  2.3.0 added `SessionRequestMessage.metadata` (stripped before dispatch) and
  retyped `Message` as a role union; the pushed trailing user message satisfies
  it structurally, with no cast. 2.3.0 hot-reloads plugin source (watched
  import graph) and rejects duplicate plugin IDs at load; export-map edits
  still need `/reload`.
- Mutating the shared hook event is sanctioned: `PluginHooks.trigger` passes
  one event through callbacks in registration order, and built-in plan/goal
  plugins splice `event.messages` the same way - their reminders insert before
  a trailing user message, so the block stays last. Upstream PR #63498 changes
  the built-ins to append reminders into the trailing user message; re-verify
  block placement once a host ships it.
- Native baseline (verified 2.3.0 + dev, 2026-11-16): built-in instructions
  are `core/date` (host-zone calendar date only, frozen at session start;
  rollovers arrive as `InstructionsUpdated` system rows the model does see)
  and `core/environment`; no request path renders time-of-day or message
  timestamps; the `schedule_list` tool is UTC-only, pull-based, flag-gated.
  Nothing native overlaps this plugin.
- Cache interaction: 2.3.0 `cache-policy.ts` places the conversation
  breakpoint on the final request message - our block when injected. The cause
  is positional, not content: the cache entry ends in a request-only message
  that no later request repeats at that position, so history never
  prefix-matches and is cache-written (1.25x) every step instead of
  cache-read (0.1x); a byte-identical block would cost the same. Applies to
  every route the policy maps to auto breakpoints (Bedrock, Vertex, Moonshot,
  MiniMax, Z.ai, several gateways, OpenRouter anthropic/*, alibaba-chat Qwen,
  plus any model declaring `cacheFormat: "anthropic"`), not just
  anthropic-messages; implicit-cache routes (vLLM, e.g. glm-5.3) are
  unaffected. Not a 2.3.0 regression. Confirmed by measurement on a
  claude-sonnet-5-5 model over an anthropic-messages route (2026-11-16, 7-step
  session): with the block, every steady-state step reads only the pinned
  ~13.3K tools+system prefix and re-writes the whole conversation; without it,
  steps read the full ~15.3K prompt and write only ~0.1K per-step deltas. The
  per-step penalty scales with conversation size, so long sessions on those
  routes pay most. Plugin-side levers exist on 2.3.0 but are untested here: a
  manual `cache` hint on a text part is honored within the 4-breakpoint cap,
  and the `http.request` hook exposes a writable request - a manual hint on
  the last stable message is the experiment to run if an explicit-breakpoint
  model must come back into scope (needs an invariant-2 carve-out: the hint
  edits the request, though not `messages`). Adopted mitigation:
  `includeModels` allowlists the implicit-cache models so explicit-breakpoint
  models get no block at all; the durable fix is upstream:
  anomalyco/opencode#62554, with the fix in flight as PR #63498 - a
  `transient` flag on text parts that makes cache policy place breakpoints
  before request-local content (our report #64311 closed as its duplicate).
  Adoption conditions: the PR is unreviewed (API may change), the flag is not
  in 2.3.0 types (pin must bump first; setting it today fails typecheck), it
  is a no-op on hosts without the fix - retire the includeModels allowlist
  only on hosts that ship it, and re-measure when it lands.
- Step-limited agents (`steps` set): the block lands after core's
  `MAX_STEPS_PROMPT` assistant message, so the model's last input is the time
  block rather than the forced-summary instruction.
- The 2.3.0 `claude-agent` provider fingerprints consecutive user-message
  groups for session sync; a changing tail block makes saved group hashes
  never match again, so every follow-up stops and forks. Not configured
  today; if it ever is, add its models to `excludeModels` first.
- `test/v2.test.ts` verifies fresh tail-only injection, byte-stable prefix,
  deduplication, filters, failures/timeouts, session isolation, bounded record
  processing, privacy, and registration disposal. The SDK dependency is
  type-only; production has no third-party runtime imports.
- For smoke tests use the directory URL and `opencode run --standalone` with
  isolated XDG directories. Ask the real model to quote its final block,
  resume the session, check a tool continuation, test exclusion, and inspect
  stored message IDs to ensure the ephemeral row was not persisted. Verified on
  OpenCode 2.3.0 (2026-11-16): fresh-session quote test via `opencode run`
  passed; primary + subagent injection, tool continuations, and per-request
  freshness observed live; the smoke session's stored messages contain no
  `msg_time_context_ephemeral` row.
