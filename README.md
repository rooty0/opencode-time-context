# opencode-time-context

An OpenCode plugin that injects one fresh, compact **time-context block** into the
model-visible system layer of every primary agent model request, so models stop
guessing relative time ("yesterday" for something that happened 5 minutes ago).

Model-agnostic by default: with no configuration it applies to every model
(Kimi, Claude, GPT, local vLLM models, ...). Optional exact-match include/exclude
model filtering is available.

Verified against **OpenCode 1.18.35** (`@opencode-ai/plugin` 1.18.27 type surface).

## What the model sees

An extra **trailing user message** per request (values are computed per request;
this is an example, not a template). The block rides at the tail of the message
list, after all history, so everything before it stays byte-stable for
provider-side KV prefix caching:

```text
[OpenCode time context]
Now: 2026-10-07 20:31:00 -07:00 (America/Los_Angeles)
UTC now: 2026-10-08T03:31:00.000Z
Latest user message: 2026-10-07 20:30:45 -07:00 (15 sec ago)
Previous user message: 2026-10-07 20:25:30 -07:00 (5 min 15 sec before latest)
Latest assistant completion: 2026-10-07 20:29:02 -07:00 (1 min 58 sec ago)
Recent timeline (recorded message/event times):
- 20:24:10 -07:00 — user message
- 20:25:30 -07:00 — user message
- 20:29:02 -07:00 — assistant message completed
- 20:30:45 -07:00 — user message
Timing rule: use the timestamps above when you refer to how long ago something happened; conversation order alone does not tell you when events occurred. A message timestamp marks when that message was created, admitted, or completed, not when some external action finished. If timing is unknown, say "earlier" or "previously" rather than guessing "yesterday" or "last week".
[/OpenCode time context]
```

Typical size: ~700–1500 characters (≈180–380 tokens), hard-capped by
`maxBlockChars` (default 1500 chars).

**Why the tail and not the system prompt:** provider prefix caches are positional
— any change near the front invalidates everything after it. A per-second `Now`
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
| timeline `tool "..." finished/failed` | `ToolPart.state.time.end` | when a tool call settled |

No message text, tool arguments/outputs, file contents, or conversation bodies are
ever included — only roles, coarse event kinds, tool names, and times.

Timestamps are gathered from the in-process event stream (`message.updated` /
`message.part.updated`) and the `chat.message` admission hook; on the first request
for a session this plugin hasn't seen yet (e.g. after an OpenCode restart), it does
one bounded read (`session.messages`, `limit: 64`) to seed reliable history from the
persisted store. Records with missing or implausible times are omitted, never
fabricated.

## Install (global)

The user's global config (`~/.config/opencode/opencode.jsonc`) already contains:

```json
"plugin": [
  "file:///ABS/PATH/opencode-time-context/src/index.ts"
]
```

That single entry enables the plugin for all projects with default options.

To install somewhere else / for a fresh setup: point the `plugin` array at the
absolute `file://` URL of `src/index.ts` in a checkout of this repo (or copy the
repo anywhere and use that path). No build step; OpenCode loads TypeScript
directly.

**Restart required:** OpenCode loads config and plugins at process start. Quit and
restart OpenCode (or run a new `opencode run`/`opencode` process) after changing
this file, the plugin source, or options. Running sessions keep the old code.

### Seeing it in the TUI "Plugins" window

The Plugins window lists plugins that have a TUI half registered in `tui.json`
(the server `plugin` array in `opencode.jsonc` is not read by that window).
`src/tui.ts` provides a minimal no-op TUI surface for exactly that; the user's
`~/.config/opencode/tui.json` already contains:

```json
"plugin": [
  "@prevalentware/opencode-goal-plugin",
  "file:///ABS/PATH/opencode-time-context/src/index.ts"
]
```

so the plugin appears as `opencode-time-context … active` under External. The
window's active/inactive toggle controls only that no-op TUI surface — it does
**not** disable injection. To disable the plugin use `"enabled": false` in the
server options below, or uninstall.

## Configuration

Turn the string entry into a tuple to set options (only in the **one** config file
where the plugin is declared — see "Double-declaration pitfall" below):

```jsonc
"plugin": [
  ["file:///…/opencode-time-context/src/index.ts", {
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
| `timezone` | string (IANA) | host local timezone | Timezone for the `Now:`/local timestamps. Validated at startup; invalid values fall back to the host timezone with a warning. Note: this is the timezone of the machine running the OpenCode process — if you run OpenCode on a remote host, that's the remote host's timezone. |
| `historyAnchorsLimit` | integer 0–12 | `6` | Max number of timeline anchors. `0` omits the timeline. |
| `maxBlockChars` | integer 300–4000 | `1500` | Hard cap on the injected block; oldest anchors are shed first. |
| `debug` | boolean | `false` | Logs each injected block (timestamps only, never prompt contents) to OpenCode's log. |

### Model matching rules

Matching is exact and case-sensitive (no substrings, no regex). Each entry is
compared against per-request model identity:

- `"local-vllm/moonshotai/Kimi-K3"` — matches provider `local-vllm` + model
  `moonshotai/Kimi-K3` only. This is the canonical form; prefer it.
- `"moonshotai/Kimi-K3"` (exactly the model ID) — matches that model on **any**
  provider. Convenience form; model IDs may contain `/`, so both forms are tried.

The filter is evaluated on **every outgoing model request** (not at startup), so
mid-session model switches and independent subagents each get the right decision.
If a request's model identity is unavailable: with empty include/exclude lists
injection proceeds; with any filters configured it is skipped and a one-line
diagnostic is logged (never silently claiming an unverified match).

### Declare it exactly once

Declare the plugin in exactly one config file. In OpenCode 1.18.35 the same file
declared in two places (e.g. global config *and* a project `opencode.json`, or
also dropped into the auto-scanned `~/.config/opencode/plugin/`) can register
**twice** with competing options. Stick to the single global entry above.
(Technical background lives in AGENTS.md.)

## Request scope

- Injected: every primary agent model call that flows through
  `experimental.chat.messages.transform` — the initial call of a turn, each
  tool-continuation step, and retries; plus subagent sessions (a child session
  gets its **own** timeline — parent history is never mixed in). All historical
  values are derived per request from the payload itself, so restarts/resumes
  and mid-session model switches need no warm-up.
- Skipped: requests with no user message in the payload, sessions whose
  in-flight work is only auxiliary agents (compaction/title/summary pending
  messages via the event stream), and filtered-out models per the lists below.
- Known leaks, both harmless (~250 tokens in prompts that recompute anyway):
  title generation runs inline and can carry the block; compaction calls can
  carry it when their in-flight message event has not landed yet. Neither
  touches stored transcripts.

The block is ephemeral: exactly one plugin-owned row per request, replaced if
the same payload is re-transformed, never persisted, and never injected into
the canonical user message text.

## Diagnostics and failure behavior

Logs go to OpenCode's own log (`client.app.log`, service `time-context`):
startup line with the effective config, one-time-per-change filter skip reasons,
injection payloads when `debug: true`, and warnings on failures. Prompt or
conversation content is never logged.

Everything fails open: storage/API errors, bad options, invalid timestamps, or
unexpected shapes disable only the affected feature of the block (or skip
injection for that request) — OpenCode keeps working normally.

## Disable / uninstall

- Temporarily: set `"enabled": false` in the tuple options (restart OpenCode).
- Fully: delete the plugin entry from the `plugin` array in
  `~/.config/opencode/opencode.jsonc` (restart OpenCode). This repo can remain on
  disk; nothing else references it.

## Verify it works

Ask the model to quote the block — a reply containing it proves the injection
reached the model-visible request (silent when excluded):

```bash
# in any scratch dir:
opencode run -m local-vllm/moonshotai/Kimi-K3 \
  'Without calling any tool: if your instructions contain a block starting
   with "[OpenCode time context]", quote that whole block verbatim; otherwise
   reply exactly NO_BLOCK'
```

## Contributing

```bash
npm install && npm test && npm run typecheck
```

Architecture, the verified OpenCode runtime contract, design invariants, and
deeper smoke recipes live in [AGENTS.md](AGENTS.md).
