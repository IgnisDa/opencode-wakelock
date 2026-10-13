# opencode-wakelock

Prevents the system from sleeping while any OpenCode agent session runs. In
OpenCode v2, the wake lock also remains active for OpenCode-managed background
shell commands until they exit. OpenCode v1 remains session-only: its wake lock
is released when all sessions go idle or error.

Works on **macOS** (via `caffeinate`) and **Linux** (via `systemd-inhibit`,
including Fedora + KDE Plasma, Ubuntu, Arch, and any other systemd-based
distro). On other platforms the plugin loads but does nothing.

## How it works

The plugin uses shared lock entries in `/tmp/opencode-wakelock/sessions/` and
runs one platform-specific inhibitor while any entry remains. Session and shell
entries share this directory; shell entries use the `shell-` prefix. The
inhibitor stops only when no session or shell entries remain.

### OpenCode v1

- A busy `session.status` acquires a lock for that session.
- `session.idle` or `session.error` releases that session's lock.
- V1 tracks sessions only; background shell commands do not keep the wake lock
  active.

### OpenCode v2

- The context hook acquires a lock for each session, and `session.wait` releases
  it.
- `shell.created` acquires an independent lock for that shell ID. `shell.exited`
  (including nonzero exit, timeout, or kill) or `shell.deleted` releases it.
- Only OpenCode-managed shells are tracked. Detached descendants that continue
  after the shell wrapper exits are not covered.
- Shells already running when the plugin reloads are not rediscovered because
  the V2 plugin context has no shell inventory API.

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

The package supports both OpenCode v1 and v2. Use the configuration key for
the OpenCode version you run.

OpenCode v2:

```json
{
  "plugins": ["opencode-wakelock"]
}
```

OpenCode v1:

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

## Development

```sh
bun install --frozen-lockfile
bun test
bun run build
```

Tests use isolated mock OS state and do not start real inhibitors.

## Releases

To release a new version, bump the `package.json` version and push to `main`.
The workflow tests the package, publishes it to npm, then creates a GitHub release
tagged `v<version>` with generated notes and a link to the npm package. The tag
targets the published package's npm `gitHead`, not a later commit on `main`.
The workflow waits for npm registry propagation before creating the GitHub release.

The workflow uses the built-in `GITHUB_TOKEN`; no extra release token is needed.
If the npm version or GitHub release already exists, that step is skipped, so
rerunning the workflow can create a missing GitHub release without republishing
the package. You can also run the workflow manually.

If workflow files changed after the published commit, GitHub can reject creating
its historical tag with `GITHUB_TOKEN`. In that case, a maintainer must first push
`v<version>` at the npm `gitHead`, then rerun the workflow. Existing tags are
checked against the published commit and are never moved.
