# opencode-wakelock

Prevents macOS from sleeping while an OpenCode agent session is actively running.
Releases the wake lock the moment all sessions go idle or error. Supports multiple
parallel OpenCode instances.

## How it works

Hooks into OpenCode session lifecycle events:

- `session.status` with `status.type: "busy"` → registers the session and ensures `caffeinate -i` is running
- `session.idle` or `session.error` → deregisters the session; stops caffeinate when no sessions remain active

Session state is tracked via files in `/tmp/opencode-wakelock/sessions/`.
A single `caffeinate` process is shared across all OpenCode instances.
Stale session files from crashed instances are automatically detected and removed.

macOS only. On other platforms the plugin loads but does nothing.

## Install

Add to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-wakelock"]
}
```

## Features

- **Multi-instance safe**: Multiple OpenCode instances can run in parallel without conflicts
- **Automatic cleanup**: Stale session files from crashed instances are automatically detected and removed
- **Efficient**: Only one `caffeinate` process runs, shared across all instances
- **Zero overhead on non-macOS**: Plugin loads but does nothing on other platforms
