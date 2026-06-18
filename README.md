# opencode-wakelock

Prevents the system from sleeping while an OpenCode agent session is actively
running. Releases the wake lock the moment all sessions go idle or error.
Supports multiple parallel OpenCode instances.

Works on **macOS** (via `caffeinate`) and **Linux** (via `systemd-inhibit`,
including Fedora + KDE Plasma, Ubuntu, Arch, and any other systemd-based
distro). On other platforms the plugin loads but does nothing.

## How it works

Hooks into OpenCode session lifecycle events:

- `session.status` with `status.type: "busy"` → registers the session and starts
  the platform-specific inhibitor
- `session.idle` or `session.error` → deregisters the session; stops the
  inhibitor when no sessions remain active

Session state is tracked via files in `/tmp/opencode-wakelock/sessions/`. A
single inhibitor process is shared across all OpenCode instances. Stale session
files from crashed instances are automatically detected and removed.

### Platform-specific inhibitors

| Platform | Command                                                                 | Blocks                    |
| -------- | ----------------------------------------------------------------------- | ------------------------- |
| macOS    | `caffeinate -i`                                                         | System idle timer         |
| Linux    | `systemd-inhibit --what=sleep:idle ... sleep infinity`                  | System sleep + idle timer |

On Linux, `systemd-inhibit` is used because it ships with systemd (installed by
default on Fedora, Ubuntu, Arch, openSUSE, Debian, etc.) and works regardless
of desktop environment — KDE Plasma, GNOME, XFCE, sway, headless servers, and
remote SSH sessions all work the same way.

If `systemd-inhibit` is unavailable (e.g. non-systemd distros like Void or
Artix, or minimal containers), the plugin logs a warning and continues without
a wake lock — OpenCode itself is unaffected.

To verify the lock is active on Linux:

```sh
systemd-inhibit --list
# look for "opencode-wakelock" in the output
```

## Install

Add to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-wakelock"]
}
```

No additional dependencies are required. `caffeinate` ships with macOS and
`systemd-inhibit` ships with systemd on Linux.

## Features

- **Multi-platform**: macOS and Linux out of the box
- **Multi-instance safe**: Multiple OpenCode instances can run in parallel
  without conflicts
- **Automatic cleanup**: Stale session files from crashed instances are
  automatically detected and removed
- **Efficient**: Only one inhibitor process runs, shared across all instances
- **Zero overhead on unsupported platforms**: Plugin loads but does nothing on
  Windows / BSD
