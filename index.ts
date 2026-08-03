import type { Plugin } from "@opencode-ai/plugin";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "fs";

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
  if (platform === "darwin") {
    return { command: "caffeinate", args: ["-i"] };
  }
  return {
    command: "systemd-inhibit",
    args: [
      "--what=sleep:idle",
      "--who=opencode-wakelock",
      "--why=OpenCode session is active",
      "sleep",
      "infinity",
    ],
  };
}

type CaffeinateProcess = {
  pid: number;
  // Absent only in PID files written by releases through 0.1.5.
  startedAt?: string;
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
  const result = Bun.spawnSync([
    "ps", "-p", String(pid), "-o", "comm=", "-o", "ppid=", "-o", "lstart=",
  ]);
  const match = result.stdout.toString().trim().match(/^(\S+)\s+(\d+)\s+(.+)$/);
  if (result.exitCode !== 0 || !match) return;
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
  if (!info || info.command !== "caffeinate") return false;
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
  try {
    const proc = Bun.spawn([cmd.command, ...cmd.args], {
      stdio: ["ignore", "ignore", "ignore"],
    });
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
      }));
    } else {
      writeFileSync(LOCK_PID_FILE, String(proc.pid));
    }
    return true;
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    log("warn", `Failed to start ${cmd.command}`, {
      platform,
      command: cmd.command,
      error: message,
    });
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

function acquire(sessionID: string, platform: SupportedPlatform, log: LogFn) {
  ensureDirs();
  writeFileSync(`${SESSIONS_DIR}/${sessionID}`, String(process.pid));
  if (!isLockRunning(platform)) startLock(platform, log);
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

  return {
    event: async ({ event }) => {
      await log("debug", "Event received", { type: event.type });

      if (event.type === "session.status" && event.properties.status.type === "busy") {
        const { sessionID } = (event as any).properties;
        acquire(sessionID, platform, log);
        await log("info", "Acquired wakelock (session busy)", { sessionID });
      }

      if (event.type === "session.idle") {
        const { sessionID } = (event as any).properties;
        release(sessionID, platform);
        await log("info", "Released wakelock (session idle)", { sessionID });
      }

      if (event.type === "session.error") {
        const { sessionID } = (event as any).properties;
        if (sessionID) release(sessionID, platform);
        await log("info", "Released wakelock (session error)", { sessionID });
      }
    },
  };
};

export default { id: "opencode-wakelock", server: wakelockPlugin };
