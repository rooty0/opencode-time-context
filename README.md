# opencode-time-context

An OpenCode plugin that injects one fresh, compact **time-context block** into the
tail of the model-visible messages of every primary agent model request, so models stop
guessing relative time ("yesterday" for something that happened 5 minutes ago).

Model-agnostic by default: with no configuration it applies to every model
(Kimi, Claude, GPT, local vLLM models, ...). Optional exact-match include/exclude
model filtering is available.

Supports **OpenCode v1 and v2**. Type-checked against `@opencode-ai/plugin`
1.18.27 and `@opencode/plugin` 2.0.25; live-tested on OpenCode 1.18.30 and 2.0.25.

## What the model sees

An extra **trailing user message** per request (values are computed per request;
this is an example, not a template). The block rides at the tail of the message
list, after all history, so everything before it stays byte-stable for
provider-side KV prefix caching:

```text
[OpenCode time context]
Now: 2026-10-07 20:31:00 -07:00 (Wednesday, America/Los_Angeles)
UTC now: 2026-10-08T03:31:00.000Z
Latest user message: 2026-10-07 20:30:45 -07:00 (15 sec ago)
Previous user message: 2026-10-07 20:25:30 -07:00 (5 min 15 sec before latest)
Latest assistant completion: 2026-10-07 20:29:02 -07:00 (1 min 58 sec ago)
Recent timeline (recorded message/event times):
- 20:24:10 -07:00 - user message
- 20:25:30 -07:00 - user message
- 20:28:47 -07:00 - tool "bash" finished
Timing rule: use the timestamps above when you refer to how long ago something happened; conversation order alone does not tell you when events occurred. A message timestamp marks when that message was created, admitted, or completed, not when some external action finished. If timing is unknown, say "earlier" or "previously" rather than guessing "yesterday" or "last week".
[/OpenCode time context]
```

The weekday label on `Now` is intentional: models botch date→weekday arithmetic
surprisingly often, and the label makes it free. The timeline deliberately omits
the two facts that already have headline lines (latest user message, latest
assistant completion) so the block stays lean. Same-day anchors show time only;
older anchors keep their full local date.

Typical size: ~700–1500 characters (≈180–380 tokens), hard-capped by
`maxBlockChars` (default 1500 chars).

**Why the tail and not the system prompt:** provider prefix caches are positional
- any change near the front invalidates everything after it. A per-second `Now`
block in the system layer recomputed the entire history of long sessions every
turn (observed as full-history prefill storms and prefix-cache hit rates pinned
at ~17%). At the tail, cache hits cover the whole history and only the genuinely
new turn tokens are recomputed. The synthetic message is request-only: it is
never written into the stored transcript, so nothing on disk ever goes stale.

### Where each timestamp comes from

| Block field | Source (all epoch-ms from OpenCode's store) | Semantics |
|---|---|---|
| `Now` / `UTC now` | `Date.now()` at request time | when this model request was built. Never cached. |
| `Latest/Previous user message` | `UserMessage.time.created` | when that user message was admitted into the session |
| `Latest assistant completion` | `AssistantMessage.time.completed` | when the last primary-agent reply finished |
| timeline `user message` | `UserMessage.time.created` | same as above |
| timeline `assistant message completed` | `AssistantMessage.time.completed` | same as above |
| timeline `tool "..." finished/failed` | v1 `ToolPart.state.time.end`; v2 tool `time.completed` | when a tool call settled |

No message text, tool arguments/outputs, file contents, or conversation bodies are
ever included - only roles, coarse event kinds, tool names, and times.

V1 derives timestamps from each request's message payload. V2 strips timestamps
from model messages, so the adapter reads `ctx.session.context()` once per
eligible request, inspects its last 64 records, and uses only records whose IDs
are in the outgoing request. This API returns the whole active context (it has
no limit parameter), not the full session transcript. No history bodies are
cached or logged. The lookup has a one-second deadline; if it fails, the block
still contains fresh current time and omits unknown history times.

## Install (global)

Clone this repository anywhere. No build or runtime dependency installation is
needed: all SDK imports are type-only.

### OpenCode v2

Use the **checkout directory**, not `src/index.ts`, in
`~/.config/opencode/opencode.jsonc`:

```json
"plugin": ["file:///ABS/PATH/opencode-time-context"]
```

For the optional no-op TUI presence, add the same directory to the `plugins`
array in `~/.config/opencode/cli.json`:

```json
"plugins": ["file:///ABS/PATH/opencode-time-context"]
```

V2 resolves the root `server.ts` and `tui.ts` independently. Run
`opencode reload` after changing configuration; restart the server after source
changes if the old module remains cached. Restart the TUI to reload its half.

### OpenCode v1

Keep the original entry in `~/.config/opencode/opencode.jsonc`:

```json
"plugin": ["file:///ABS/PATH/opencode-time-context/src/index.ts"]
```

The same entry can be added to `plugin` in `~/.config/opencode/tui.json`.
`src/package.json` dispatches to the original server function and no-op TUI
adapter. Restart OpenCode after changing source, configuration, or options.

The TUI half only makes the plugin visible in the Plugins window. Its toggle
does not disable server injection; use the server's `enabled` option below.

## Configuration

Turn the string entry into a tuple to set options (only in the **one** config file
where the plugin is declared - see "Declare it exactly once" below). This
example is for v2; for v1 append `/src/index.ts` to the URL:

```jsonc
"plugin": [
  ["file:///ABS/PATH/opencode-time-context", {
    "enabled": true,
    "includeModels": [],
    "excludeModels": [],
    "timezone": "America/Los_Angeles",
    "historyAnchorsLimit": 6,
    "maxBlockChars": 1500,
    "debug": false
  }]
]
```

| Option | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | `false` disables injection entirely. |
| `includeModels` | string[] | `[]` | Empty = all models eligible. Nonempty = only matches are eligible. |
| `excludeModels` | string[] | `[]` | Blocks matches; **exclusion wins** when both lists match. |
| `timezone` | string (IANA) | host local timezone | Timezone for the `Now:`/local timestamps. Validated at startup; invalid values fall back to the host timezone with a warning. Note: this is the timezone of the machine running the OpenCode process - if you run OpenCode on a remote host, that's the remote host's timezone. |
| `historyAnchorsLimit` | integer 0–12 | `6` | Max number of timeline anchors. `0` omits the timeline. |
| `maxBlockChars` | integer 300–4000 | `1500` | Hard cap; oldest anchors are shed first, then headline history. Very small caps use a shorter timing rule. |
| `debug` | boolean | `false` | Logs each injected block (timestamps only, never prompt contents) to OpenCode's log. |

### Model matching rules

Matching is exact and case-sensitive (no substrings, no regex). Each entry is
compared against per-request model identity:

- `"local-vllm/moonshotai/Kimi-K3"` - matches provider `local-vllm` + model
  `moonshotai/Kimi-K3` only. This is the canonical form; prefer it.
- `"moonshotai/Kimi-K3"` (exactly the model ID) - matches that model on **any**
  provider. Convenience form; model IDs may contain `/`, so both forms are tried.

The filter is evaluated on **every outgoing model request** (not at startup), so
mid-session model switches and independent subagents each get the right decision.
If a request's model identity is unavailable: with empty include/exclude lists
injection proceeds; with any filters configured it is skipped. V1 logs a diagnostic; v2 logs the skip when `debug` is enabled.

### Declare it exactly once

Declare the plugin in exactly one config file. In OpenCode 1.18.35 the same file
declared in two places (e.g. global config *and* a project `opencode.json`, or
also dropped into the auto-scanned `~/.config/opencode/plugin/`) can register
**twice** with competing options. Stick to the single global entry above.
(Technical background lives in AGENTS.md.)

## Request scope

Both adapters append one ephemeral user message to each eligible primary agent
request, including tool continuations and subagent turns. Subagents use only
their own session history. Existing history and system messages stay unchanged;
the plugin never writes to the stored transcript or edits admitted user text.
Reprocessing a payload replaces the previous plugin-owned row.

V2 registers only `ctx.session.hook("context")`; title, compaction, and generate
requests have separate hooks and receive no injection. V1 uses
`experimental.chat.messages.transform` plus an event mirror to suppress pending
auxiliary agents. Its legacy title/compaction paths may occasionally carry a
block when auxiliary events arrive late. Requests without user messages and
filtered-out models are skipped in both versions.

## Diagnostics and failure behavior

With `debug: true`, both adapters log injected time blocks and filter decisions.
V1 uses `client.app.log`; v2 uses the plugin host's console logging. V2's filter
diagnostics are per request. No conversation bodies or upstream error objects
are logged by the v2 adapter.

Hooks fail open: unavailable history produces current-time-only context;
unexpected errors skip injection without breaking the request. Missing,
invalid, or implausibly future history timestamps are omitted.

## Disable / uninstall

- Temporarily: set `"enabled": false` in the tuple options (restart OpenCode).
- Fully: delete the plugin entry from the `plugin` array in
  `~/.config/opencode/opencode.jsonc` (restart OpenCode). Also remove the optional TUI entry from `cli.json` (v2) or `tui.json` (v1).
  The checkout can remain on disk.

## Verify it works

Ask the model to quote the block - a reply containing it proves the injection
reached the model-visible request (silent when excluded):

```bash
# in any scratch dir:
opencode run -m local-vllm/moonshotai/Kimi-K3 \
  'Without calling any tool: if your instructions contain a block starting
   with "[OpenCode time context]", quote that whole block verbatim; otherwise
   reply exactly NO_BLOCK'
```

## Prior art / ecosystem

- [afriemann/opencode-timed](https://github.com/afriemann/opencode-timed) - the
  only other transient, non-persistent request-layer time injector. Differences:
  it prefixes every user message with bare ISO stamps (spread across the whole
  history), vs. this plugin's single tail-placed block with elapsed times and an
  event timeline. Actively maintained, npm-unpublished.
- `opencode-time-refresh` (npm) injects time by mutating persisted user messages
  - an anti-pattern this plugin avoids entirely (nothing here is stored).
- Upstream demand is tracked in anomalyco/opencode issues #47251/#48639/#45570;
  a native core solution may supersede this plugin someday.

## Contributing

```bash
npm install && npm test && npm run typecheck
```

Architecture, the verified OpenCode runtime contract, design invariants, and
deeper smoke recipes live in [AGENTS.md](AGENTS.md).
