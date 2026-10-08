# opencode-time-context

An OpenCode plugin that injects one fresh, compact **time-context block** into the
model-visible system layer of every primary agent model request, so models stop
guessing relative time ("yesterday" for something that happened 5 minutes ago).

Model-agnostic by default: with no configuration it applies to every model
(Kimi, Claude, GPT, local vLLM models, ...). Optional exact-match include/exclude
model filtering is available.

Verified against **OpenCode 1.18.35** (`@opencode-ai/plugin` 1.18.27 type surface).

## What the model sees

An extra system-role entry per request (values are computed per request; this is
an example, not a template):

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

### Double-declaration pitfall

OpenCode 1.18.35's config merge **concatenates `plugin` arrays across layers and
at least one code path loads the same file both specified-in-config and
dir-scanned**. Declaring this plugin in more than one place (e.g. global config
*and* a project `opencode.json`, or also dropping it into a scanned
`~/.config/opencode/plugin/` directory) can register it **twice**; the request is
then governed by whichever registration ran. Declare it exactly once — normally
just the global array entry above.

Relatedly: `src/index.ts` must export only the plugin function. OpenCode's legacy
module adapter registers *every* function-valued export as a plugin. That's why
the hook wiring lives in `src/hooks.ts` (imported by tests) and the entry module
has a single default export.

## Request scope

- Injected: every primary agent model call — the initial call of a turn, each
  tool-continuation step, and retries; plus subagent sessions (a child session
  gets its **own** timeline — parent history is never mixed in).
- Skipped: compaction-summary calls (detected via the in-flight compaction
  assistant message), requests without a session (e.g. `opencode agent create`),
  and synthetic sessions that leave no trace in the session store (e.g.
  project-name generation).
- Known leak: **title generation** runs concurrently with the primary stream and
  is indistinguishable from it through this version's hook inputs, so it carries
  the block for one request at session start. Harmless (~150 tokens); documented
  here because the scope claim would otherwise be wrong.

The block is ephemeral: it is computed per request and only appended to the
outgoing system array. It is never written into user messages or persisted
transcripts, and exactly one plugin-owned block exists per request (a stale block
on a reused array is replaced in place).

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

## Development

```bash
npm install
npm test         # node --test, native TS (Node >= 23.6), fake clock + fake session data
npm run typecheck
```

Model-visible verification recipe (what the smoke tests did):

```bash
# in any scratch dir with a configured provider/model:
opencode run -m local-vllm/moonshotai/Kimi-K3 \
  'Without calling any tool: if your instructions contain a block starting
   with "[OpenCode time context]", quote that whole block verbatim; otherwise
   reply exactly NO_BLOCK'
```

The model quoting the block proves the injection reached the provider-visible
request (debug logging alone would not).
