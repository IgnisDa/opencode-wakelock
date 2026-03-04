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
      if (isProcessAlive(pid)) {
        active.push(sessionID);
      } else {
        unlinkSync(filePath);
      }
    } catch {}
  }
  return active;
}

function isCaffeinateRunning(): boolean {
  if (!existsSync(CAFFEINATE_PID_FILE)) return false;
  try {
    const pid = parseInt(readFileSync(CAFFEINATE_PID_FILE, "utf8").trim(), 10);
    if (isProcessAlive(pid)) return true;
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
  writeFileSync(CAFFEINATE_PID_FILE, String(proc.pid));
}

function stopCaffeinate() {
  if (!existsSync(CAFFEINATE_PID_FILE)) return;
  try {
    const pid = parseInt(readFileSync(CAFFEINATE_PID_FILE, "utf8").trim(), 10);
    process.kill(pid, "SIGTERM");
  } catch {}
  try {
    unlinkSync(CAFFEINATE_PID_FILE);
  } catch {}
}

function acquire(sessionID: string) {
  if (process.platform !== "darwin") return;
  ensureDirs();
  writeFileSync(`${SESSIONS_DIR}/${sessionID}`, String(process.pid));
  if (!isCaffeinateRunning()) {
    startCaffeinate();
  }
}

function release(sessionID: string) {
  if (process.platform !== "darwin") return;
  try {
    unlinkSync(`${SESSIONS_DIR}/${sessionID}`);
  } catch {}
  const remaining = getActiveSessions();
  if (remaining.length === 0) {
    stopCaffeinate();
  }
}

function startupCleanup() {
  if (process.platform !== "darwin") return;
  ensureDirs();
  const active = getActiveSessions();
  if (active.length === 0) {
    stopCaffeinate();
  }
}

export const WakelockPlugin: Plugin = async () => {
  startupCleanup();

  return {
    event: async ({ event }) => {
      if (event.type !== "session.status") return;

      const { sessionID, status } = (event as any).properties;

      if (status === "active") {
        acquire(sessionID);
      } else if (status === "idle" || status === "error") {
        release(sessionID);
      }
    },
  };
};

export default WakelockPlugin;
