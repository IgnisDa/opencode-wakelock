import type { Plugin } from "@opencode-ai/plugin";
import type {
  Context as PluginContextV2,
  Plugin as PluginV2,
} from "@opencode/plugin/promise/plugin";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "fs";
import { spawn, spawnSync } from "child_process";

const TMP_DIR = "/tmp/opencode-wakelock";
const SESSIONS_DIR = `${TMP_DIR}/sessions`;
const LOCK_PID_FILE = `${TMP_DIR}/lock.pid`;
const LEGACY_CAFFEINATE_PID_FILE = `${TMP_DIR}/caffeinate.pid`;

type SupportedPlatform = "darwin" | "linux";

type LogFn = (
  level: "info" | "warn" | "debug",
  message: string,
  extra?: Record<string, unknown>,
) => Promise<void>;

// Extracts the sessionID a user-input event belongs to. v1 delivers the payload
// under `properties`, v2 under `data`, and `form.created` nests it under `form`.
function sessionIDOf(
  event: { properties?: unknown; data?: unknown },
): string | undefined {
  const payload = event.properties ?? event.data;
  const p = payload as { sessionID?: string; form?: { sessionID?: string } };
  return p?.sessionID ?? p?.form?.sessionID;
}

function detectPlatform(): SupportedPlatform | null {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "linux") return "linux";
  return null;
}

interface InhibitorCommand {
  command: string;
  args: string[];
}

function getInhibitorCommand(platform: SupportedPlatform): InhibitorCommand {
  // The inhibitor is shared across servers. Watch all entry owners, not
  // just the server that spawned it, so a crash cannot orphan the lock or
  // release another server's active sessions/background shells.
  const watchdog = [
    "sh",
    "-c",
    `while :; do
  active=false
  for entry in "$1"/*; do
    pid=$(cat "$entry" 2>/dev/null) || continue
    case "$pid" in ''|*[!0-9]*|0*) continue ;; esac
    if kill -0 "$pid" 2>/dev/null; then
      active=true
      break
    fi
  done
  "$active" || exit 0
  sleep 1
done`,
    "opencode-wakelock",
    SESSIONS_DIR,
  ];
  if (platform === "darwin") {
    return { command: "caffeinate", args: ["-i", ...watchdog] };
  }
  return {
    command: "systemd-inhibit",
    args: [
      "--what=sleep:idle",
      "--who=opencode-wakelock",
      "--why=OpenCode session is active",
      ...watchdog,
    ],
  };
}

type CaffeinateProcess = {
  pid: number;
  // Absent only in PID files written by releases through 0.1.5.
  startedAt?: string;
  // caffeinate execs the supervised shell at the PID returned by spawn.
  watchdog?: true;
};

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getProcessInfo(pid: number) {
  // macOS can reuse a live PID, so start time is required for process identity.
  const result = spawnSync(
    "ps",
    ["-p", String(pid), "-o", "comm=", "-o", "ppid=", "-o", "lstart="],
    { encoding: "utf8" },
  );
  const match = result.stdout.trim().match(/^(\S+)\s+(\d+)\s+(.+)$/);
  if (result.status !== 0 || !match) return;
  return { command: match[1], parentPid: Number(match[2]), startedAt: match[3] };
}

function readCaffeinateProcess(): CaffeinateProcess | undefined {
  const pidFile = existsSync(LOCK_PID_FILE)
    ? LOCK_PID_FILE
    : LEGACY_CAFFEINATE_PID_FILE;
  if (!existsSync(pidFile)) return;
  const contents = readFileSync(pidFile, "utf8").trim();
  try {
    // Accept the PID-only format long enough to migrate existing installations.
    const stored = JSON.parse(contents) as CaffeinateProcess | number;
    if (typeof stored === "number")
      return Number.isInteger(stored) && stored > 0 ? { pid: stored } : undefined;
    if (stored && Number.isInteger(stored.pid) && stored.pid > 0) return stored;
  } catch {
    const pid = Number(contents);
    if (Number.isInteger(pid) && pid > 0) return { pid };
  }
}

function isCaffeinateProcess(stored: CaffeinateProcess): boolean {
  const info = getProcessInfo(stored.pid);
  if (!info) return false;
  if (stored.watchdog) {
    // The command may still be caffeinate while it is starting the shell.
    return (info.command === "sh" || info.command === "caffeinate")
      && !!stored.startedAt && stored.startedAt === info.startedAt;
  }
  if (info.command !== "caffeinate") return false;
  if (stored.startedAt) return stored.startedAt === info.startedAt;

  // Migrate legacy PID-only files only when caffeinate is owned by OpenCode.
  if (getProcessInfo(info.parentPid)?.command !== "opencode") return false;
  writeFileSync(LOCK_PID_FILE, JSON.stringify({
    pid: stored.pid,
    startedAt: info.startedAt,
  }));
  try {
    unlinkSync(LEGACY_CAFFEINATE_PID_FILE);
  } catch {}
  return true;
}

function ensureDirs() {
  mkdirSync(SESSIONS_DIR, { recursive: true });
}

function getActiveSessions(): string[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  const files = readdirSync(SESSIONS_DIR);
  const active: string[] = [];
  for (const sessionID of files) {
    const filePath = `${SESSIONS_DIR}/${sessionID}`;
    try {
      const pid = parseInt(readFileSync(filePath, "utf8").trim(), 10);
      if (isProcessAlive(pid)) active.push(sessionID);
      else unlinkSync(filePath);
    } catch {}
  }
  return active;
}

function isLockRunning(platform: SupportedPlatform): boolean {
  if (platform === "darwin") {
    try {
      const stored = readCaffeinateProcess();
      if (stored && isCaffeinateProcess(stored)) return true;
      unlinkSync(LOCK_PID_FILE);
    } catch {}
    try {
      unlinkSync(LEGACY_CAFFEINATE_PID_FILE);
    } catch {}
    return false;
  }

  if (!existsSync(LOCK_PID_FILE)) return false;
  try {
    const pid = parseInt(readFileSync(LOCK_PID_FILE, "utf8").trim(), 10);
    if (isProcessAlive(pid)) return true;
    unlinkSync(LOCK_PID_FILE);
    return false;
  } catch {
    return false;
  }
}

function startLock(platform: SupportedPlatform, log: LogFn): boolean {
  const cmd = getInhibitorCommand(platform);
  const reportFailure = (e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    void log("warn", `Failed to start ${cmd.command}`, {
      platform,
      command: cmd.command,
      error: message,
    }).catch(() => {});
  };

  try {
    const proc = spawn(cmd.command, cmd.args, { stdio: "ignore" });
    proc.once("error", (e) => {
      try {
        const storedPid = platform === "darwin"
          ? readCaffeinateProcess()?.pid
          : Number(readFileSync(LOCK_PID_FILE, "utf8").trim());
        if (proc.pid !== undefined && storedPid === proc.pid) {
          unlinkSync(LOCK_PID_FILE);
        }
      } catch {}
      reportFailure(e);
    });

    if (proc.pid === undefined) return false;
    try {
      if (platform === "darwin") {
        const info = getProcessInfo(proc.pid);
        if (!info) {
          // Do not leave an inhibitor running when it cannot be tracked safely.
          proc.kill();
          return false;
        }
        writeFileSync(LOCK_PID_FILE, JSON.stringify({
          pid: proc.pid,
          startedAt: info.startedAt,
          watchdog: true,
        }));
      } else {
        writeFileSync(LOCK_PID_FILE, String(proc.pid));
      }
      proc.unref();
      return true;
    } catch (e) {
      proc.kill();
      reportFailure(e);
      return false;
    }
  } catch (e) {
    reportFailure(e);
    return false;
  }
}

function stopLock(platform: SupportedPlatform) {
  if (platform === "darwin") {
    try {
      const stored = readCaffeinateProcess();
      // A stale PID file may point to an unrelated process after PID reuse.
      if (stored && isCaffeinateProcess(stored))
        process.kill(stored.pid, "SIGTERM");
    } catch {}
    try {
      unlinkSync(LOCK_PID_FILE);
    } catch {}
    try {
      unlinkSync(LEGACY_CAFFEINATE_PID_FILE);
    } catch {}
    return;
  }

  if (!existsSync(LOCK_PID_FILE)) return;
  try {
    const pid = parseInt(readFileSync(LOCK_PID_FILE, "utf8").trim(), 10);
    process.kill(pid, "SIGTERM");
  } catch {}
  try {
    unlinkSync(LOCK_PID_FILE);
  } catch {}
}

function acquire(sessionID: string, platform: SupportedPlatform, log: LogFn): boolean {
  ensureDirs();
  writeFileSync(`${SESSIONS_DIR}/${sessionID}`, String(process.pid));
  if (isLockRunning(platform)) return true;
  return startLock(platform, log);
}

function release(sessionID: string, platform: SupportedPlatform) {
  try {
    unlinkSync(`${SESSIONS_DIR}/${sessionID}`);
  } catch {}
  const remaining = getActiveSessions();
  if (remaining.length === 0) stopLock(platform);
}

function startupCleanup(platform: SupportedPlatform) {
  ensureDirs();
  const active = getActiveSessions();
  if (active.length === 0) stopLock(platform);
}

const wakelockPlugin: Plugin = async ({ client }) => {
  const platform = detectPlatform();

  const log: LogFn = async (level, message, extra) => {
    await client.app.log({
      body: { level, service: "wakelock", message, extra },
    });
  };

  await log("info", "Plugin initializing", {
    platform: process.platform,
    pid: process.pid,
  });

  if (platform === null) {
    await log("info", "Plugin inactive (unsupported platform)");
    return {};
  }

  startupCleanup(platform);

  await log("info", "Startup cleanup complete", { platform });

  // Sessions blocked on human input (a permission prompt, the question tool, or a
  // form). Their session entry is held back so the system may sleep while every
  // session is waiting for the user.
  const waitingForInput = new Set<string>();
  const activeSessions = new Set<string>();

  // Event types that mean OpenCode is now blocked waiting for the user.
  const WAIT_EVENTS = new Set([
    "permission.asked",
    "form.created",
    "question.asked",
  ]);
  // Event types that mean the user has answered or cancelled.
  const RESUME_EVENTS = new Set([
    "permission.replied",
    "form.replied",
    "form.cancelled",
    "question.replied",
    "question.cancelled",
  ]);

  // Hold back a session's lock entry so the system may sleep while the user is
  // away. When the wait event carries no sessionID (e.g. the question tool),
  // fall back to holding back every active session, since the question blocks
  // the running turn regardless of which session emitted it.
  const suspendForInput = (sessionID: string | undefined) => {
    if (sessionID) {
      if (waitingForInput.has(sessionID)) return;
      waitingForInput.add(sessionID);
      release(sessionID, platform);
      return;
    }
    for (const id of activeSessions) {
      if (waitingForInput.has(id)) continue;
      waitingForInput.add(id);
      release(id, platform);
    }
  };

  // The user has answered (or cancelled). Re-acquire the session's entry only if
  // the session is still active, so a late reply does not resurrect a stale lock.
  const resumeFromInput = (sessionID: string | undefined) => {
    const ids = sessionID
      ? [sessionID]
      : [...waitingForInput];
    for (const id of ids) {
      waitingForInput.delete(id);
      if (activeSessions.has(id)) {
        const acquired = acquire(id, platform, log);
        if (acquired) {
          void log("info", "Re-acquired wakelock (user replied)", { sessionID: id });
        }
      }
    }
  };

  return {
    event: async ({ event }) => {
      await log("debug", "Event received", { type: event.type });

      if (event.type === "session.status" && event.properties.status.type === "busy") {
        const { sessionID } = (event as any).properties;
        activeSessions.add(sessionID);
        waitingForInput.delete(sessionID);
        if (acquire(sessionID, platform, log)) {
          await log("info", "Acquired wakelock (session busy)", { sessionID });
        }
      }

      if (event.type === "session.idle") {
        const { sessionID } = (event as any).properties;
        waitingForInput.delete(sessionID);
        activeSessions.delete(sessionID);
        release(sessionID, platform);
        await log("info", "Released wakelock (session idle)", { sessionID });
      }

      if (event.type === "session.error") {
        const { sessionID } = (event as any).properties;
        if (sessionID) {
          waitingForInput.delete(sessionID);
          activeSessions.delete(sessionID);
          release(sessionID, platform);
          await log("info", "Released wakelock (session error)", { sessionID });
        }
      }

      // OpenCode is blocked waiting for the user to answer (a permission prompt,
      // the question tool, or a form). Release the session's lock entry so the
      // system may sleep while the user is away.
      const type = event.type as string;
      if (WAIT_EVENTS.has(type)) {
        suspendForInput(sessionIDOf(event));
      }

      // The user has answered or cancelled. Re-acquire the session's entry.
      if (RESUME_EVENTS.has(type)) {
        resumeFromInput(sessionIDOf(event));
      }
    },
  };
};

// V2's event stream is server-wide. Several location-scoped plugin instances
// can own the same entry; unloading one must not release the others' locks.
const v2LockOwners = new Map<string, number>();

const wakelockPluginV2: PluginV2 = {
  id: "opencode-wakelock",
  async setup(ctx: PluginContextV2) {
    const platform = detectPlatform();
    if (platform === null) return;

    startupCleanup(platform);

    const log: LogFn = async (level, message, extra) => {
      const details = extra ? ` ${JSON.stringify(extra)}` : "";
      const line = `[opencode-wakelock] ${message}${details}`;
      if (level === "warn") console.warn(line);
      else if (level === "debug") console.debug(line);
      else console.info(line);
    };
    const ownedLocks = new Set<string>();
    const waitingSessions = new Map<string, object>();
    // Sessions blocked on human input (a permission prompt or a form such as the
    // question tool). Their session entry is held back so the system may sleep
    // while every session is waiting for the user.
    const waitingForInput = new Set<string>();
    // Sessions this instance still considers active. Guards re-acquisition after a
    // session has gone terminal, so a late reply does not resurrect a stale lock.
    const activeSessions = new Set<string>();
    let stopped = false;

    const acquireOwned = (key: string) => {
      if (stopped) return;
      if (!key.startsWith("shell-")) activeSessions.add(key);
      if (!ownedLocks.has(key)) {
        ownedLocks.add(key);
        v2LockOwners.set(key, (v2LockOwners.get(key) ?? 0) + 1);
      }
      acquire(key, platform, log);
    };

    const releaseOwned = (key: string) => {
      if (!ownedLocks.delete(key)) return;
      const remaining = (v2LockOwners.get(key) ?? 1) - 1;
      if (remaining > 0) {
        v2LockOwners.set(key, remaining);
        return;
      }
      v2LockOwners.delete(key);
      release(key, platform);
    };

    // OpenCode is blocked waiting for the user to answer (a permission prompt, the
    // question tool, or a form). Hold back the session's lock entry so the system
    // may sleep while the user is away.
    const suspendForInput = (sessionID: string | undefined) => {
      if (stopped) return;
      if (sessionID) {
        if (waitingForInput.has(sessionID)) return;
        waitingForInput.add(sessionID);
        releaseOwned(sessionID);
        return;
      }
      for (const id of activeSessions) {
        if (waitingForInput.has(id)) continue;
        waitingForInput.add(id);
        releaseOwned(id);
      }
    };

    // The user has answered (or cancelled). Re-acquire the session's entry only if
    // the session is still active.
    const resumeFromInput = (sessionID: string | undefined) => {
      if (stopped) return;
      const ids = sessionID ? [sessionID] : [...waitingForInput];
      for (const id of ids) {
        waitingForInput.delete(id);
        if (activeSessions.has(id)) acquireOwned(id);
      }
    };

    const watchUntilIdle = (sessionID: string) => {
      if (waitingSessions.has(sessionID)) return;
      const token = {};
      waitingSessions.set(sessionID, token);
      void ctx.session.wait({ sessionID })
        .catch(() => undefined)
        .finally(() => {
          // An older wait must not release a new execution's entry, or an
          // entry now owned by a replacement plugin instance after cleanup.
          if (waitingSessions.get(sessionID) !== token) return;
          waitingSessions.delete(sessionID);
          releaseOwned(sessionID);
        });
    };

    // The context hook is the reliable point at which a v2 model dispatch is
    // active. session.wait() follows it through every terminal path, including
    // cases where the public lifecycle stream does not emit an idle event.
    const contextHook = await ctx.session.hook("context", (request) => {
      if (stopped) return;
      acquireOwned(request.sessionID);
      watchUntilIdle(request.sessionID);
    });

    const controller = new AbortController();
    const watcher = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (stopped) break;
          switch (event.type) {
            // Shell entries are independent of sessions. A tool can return
            // early (or be moved to the background) while its shell runs on.
            case "shell.created":
              acquireOwned(`shell-${event.data.info.id}`);
              break;
            case "shell.exited":
            case "shell.deleted":
              releaseOwned(`shell-${event.data.id}`);
              break;
            case "session.status":
              if (event.data.status.type === "busy") {
                acquireOwned(event.data.sessionID);
                watchUntilIdle(event.data.sessionID);
              }
              break;
            case "session.idle":
            case "session.execution.failed":
            case "session.execution.interrupted":
              waitingSessions.delete(event.data.sessionID);
              waitingForInput.delete(event.data.sessionID);
              activeSessions.delete(event.data.sessionID);
              releaseOwned(event.data.sessionID);
              break;
            // OpenCode is blocked waiting for the user to answer (a permission
            // prompt or a form). Release the session's lock entry so the system
            // may sleep while the user is away.
            case "permission.asked":
            case "form.created": {
              const sessionID = (event.data as { sessionID?: string; form?: { sessionID?: string } }).sessionID
                ?? (event.data as { form?: { sessionID?: string } }).form?.sessionID;
              suspendForInput(sessionID);
              break;
            }
            // The user has answered or cancelled. Re-acquire the session's entry.
            case "permission.replied":
            case "form.replied":
            case "form.cancelled":
              resumeFromInput((event.data as { sessionID?: string; form?: { sessionID?: string } }).sessionID
                ?? (event.data as { form?: { sessionID?: string } }).form?.sessionID);
              break;
          }

          // The question tool emits question.* events that are not in this SDK's
          // event union yet, but block the turn the same way as a permission
          // prompt or form. Handle them via a string cast, as the v1 path does.
          const questionType = event.type as string;
          if (questionType === "question.asked") {
            const sessionID = (event.data as { sessionID?: string; form?: { sessionID?: string } }).sessionID
              ?? (event.data as { form?: { sessionID?: string } }).form?.sessionID;
            suspendForInput(sessionID);
          }
          if (questionType === "question.replied" || questionType === "question.cancelled") {
            resumeFromInput((event.data as { sessionID?: string; form?: { sessionID?: string } }).sessionID
              ?? (event.data as { form?: { sessionID?: string } }).form?.sessionID);
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          await log("warn", "Event subscription stopped", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();

    return async () => {
      if (stopped) return;
      stopped = true;
      waitingSessions.clear();
      waitingForInput.clear();
      activeSessions.clear();
      controller.abort();
      await watcher;
      try {
        await contextHook.dispose();
      } finally {
        for (const key of ownedLocks) releaseOwned(key);
      }
    };
  },
};

export default { ...wakelockPluginV2, server: wakelockPlugin };
