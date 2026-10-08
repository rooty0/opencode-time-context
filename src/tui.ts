// TUI entry for the plugin: a no-op surface whose only purpose is to make
// opencode-time-context appear (as "active") in the TUI's Plugins window and
// to give the TUI plugin host a valid `tui` target. All behavior lives in the
// server half (index.ts). Toggling this entry in the Plugins window does NOT
// disable time-context injection — that is controlled by the server half's
// `enabled` option in opencode.json.

const tui = async () => {}

export default { id: "opencode-time-context", tui }
