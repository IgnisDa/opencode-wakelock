import type { Plugin } from "@opencode-ai/plugin";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "fs";
import { spawn } from "child_process";

const TMP_DIR = "/tmp/opencode-wakelock";
const SESSIONS_DIR = `${TMP_DIR}/sessions`;
const LOCK_PID_FILE = `${TMP_DIR}/lock.pid`;

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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

function isLockRunning(): boolean {
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
        if (
          proc.pid !== undefined &&
          existsSync(LOCK_PID_FILE) &&
          readFileSync(LOCK_PID_FILE, "utf8").trim() === String(proc.pid)
        ) {
          unlinkSync(LOCK_PID_FILE);
        }
      } catch {}
      reportFailure(e);
    });

    if (proc.pid === undefined) return false;
    try {
      writeFileSync(LOCK_PID_FILE, String(proc.pid));
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

function stopLock() {
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
  if (isLockRunning()) return true;
  return startLock(platform, log);
}

function release(sessionID: string) {
  try {
    unlinkSync(`${SESSIONS_DIR}/${sessionID}`);
  } catch {}
  const remaining = getActiveSessions();
  if (remaining.length === 0) stopLock();
}

function startupCleanup() {
  ensureDirs();
  const active = getActiveSessions();
  if (active.length === 0) stopLock();
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

  startupCleanup();

  await log("info", "Startup cleanup complete", { platform });

  return {
    event: async ({ event }) => {
      await log("debug", "Event received", { type: event.type });

      if (event.type === "session.status" && event.properties.status.type === "busy") {
        const { sessionID } = (event as any).properties;
        if (acquire(sessionID, platform, log)) {
          await log("info", "Acquired wakelock (session busy)", { sessionID });
        }
      }

      if (event.type === "session.idle") {
        const { sessionID } = (event as any).properties;
        release(sessionID);
        await log("info", "Released wakelock (session idle)", { sessionID });
      }

      if (event.type === "session.error") {
        const { sessionID } = (event as any).properties;
        if (sessionID) release(sessionID);
        await log("info", "Released wakelock (session error)", { sessionID });
      }
    },
  };
};

export default { id: "opencode-wakelock", server: wakelockPlugin };
