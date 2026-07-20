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
const CAFFEINATE_PID_FILE = `${TMP_DIR}/caffeinate.pid`;

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
  if (!existsSync(CAFFEINATE_PID_FILE)) return;
  const contents = readFileSync(CAFFEINATE_PID_FILE, "utf8").trim();
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
  writeFileSync(CAFFEINATE_PID_FILE, JSON.stringify({
    pid: stored.pid,
    startedAt: info.startedAt,
  }));
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
      if (isProcessAlive(pid))
        active.push(sessionID);
       else
        unlinkSync(filePath);

    } catch {}
  }
  return active;
}

function isCaffeinateRunning(): boolean {
  try {
    const stored = readCaffeinateProcess();
    if (stored && isCaffeinateProcess(stored)) return true;
    unlinkSync(CAFFEINATE_PID_FILE);
    return false;
  } catch {
    return false;
  }
}

function startCaffeinate() {
  const proc = Bun.spawn(["caffeinate", "-i"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  const info = getProcessInfo(proc.pid);
  if (!info) {
    // Do not leave an inhibitor running when it cannot be tracked safely.
    proc.kill();
    return;
  }
  writeFileSync(CAFFEINATE_PID_FILE, JSON.stringify({
    pid: proc.pid,
    startedAt: info.startedAt,
  }));
}

function stopCaffeinate() {
  if (!existsSync(CAFFEINATE_PID_FILE)) return;
  try {
    const stored = readCaffeinateProcess();
    // A stale PID file may point to an unrelated process after PID reuse.
    if (stored && isCaffeinateProcess(stored))
      process.kill(stored.pid, "SIGTERM");
  } catch {}
  try {
    unlinkSync(CAFFEINATE_PID_FILE);
  } catch {}
}

function acquire(sessionID: string) {
  if (process.platform !== "darwin") return;
  ensureDirs();
  writeFileSync(`${SESSIONS_DIR}/${sessionID}`, String(process.pid));
  if (!isCaffeinateRunning())
    startCaffeinate();

}

function release(sessionID: string) {
  if (process.platform !== "darwin") return;
  try {
    unlinkSync(`${SESSIONS_DIR}/${sessionID}`);
  } catch {}
  const remaining = getActiveSessions();
  if (remaining.length === 0)
    stopCaffeinate();

}

function startupCleanup() {
  if (process.platform !== "darwin") return;
  ensureDirs();
  const active = getActiveSessions();
  if (active.length === 0)
    stopCaffeinate();

}

const wakelockPlugin: Plugin = async ({ client }) => {
  await client.app.log({
    body: {
      level: "info",
      service: "wakelock",
      message: "Plugin initializing",
      extra: { platform: process.platform, pid: process.pid },
    },
  });

  startupCleanup();

  await client.app.log({
    body: {
      level: "info",
      service: "wakelock",
      message: "Startup cleanup complete",
    },
  });

  return {
    event: async ({ event }) => {
      await client.app.log({
        body: {
          level: "debug",
          service: "wakelock",
          message: "Event received",
          extra: { type: event.type },
        },
      });

      // Handle session becoming busy (actively working)
      if (event.type === "session.status" && event.properties.status.type === "busy") {
        const { sessionID } = (event as any).properties;
        acquire(sessionID);
        await client.app.log({
          body: {
            level: "info",
            service: "wakelock",
            extra: { sessionID },
            message: "Acquired wakelock (session busy)",
          },
        });
      }

      // Handle session becoming idle (completed)
      if (event.type === "session.idle") {
        const { sessionID } = (event as any).properties;
        release(sessionID);
        await client.app.log({
          body: {
            level: "info",
            service: "wakelock",
            extra: { sessionID },
            message: "Released wakelock (session idle)",
          },
        });
      }

      // Handle session error
      if (event.type === "session.error") {
        const { sessionID } = (event as any).properties;
        if (sessionID) release(sessionID);
        await client.app.log({
          body: {
            level: "info",
            service: "wakelock",
            extra: { sessionID },
            message: "Released wakelock (session error)",
          },
        });
      }
    },
  };
};

export default { server: wakelockPlugin };
