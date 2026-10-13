import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Context as PluginContextV2 } from "@opencode/plugin/promise/plugin";

const root = "/tmp/opencode-wakelock";
const sessionsDirectory = `${root}/sessions`;
const files = new Map<string, string>();
const directories = new Set<string>();
const processes = new Map<number, { command: string; startedAt: string }>();
const livePids = new Set<number>();
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
let nextPid = 500_000;

// Keep every filesystem and process operation inside this fixture. Tests never
// touch live wake-lock files or start/stop real OS inhibitor processes.
mock.module("fs", () => ({
  existsSync: (path: string) => files.has(path) || directories.has(path),
  mkdirSync: (path: string) => { directories.add(path); },
  readdirSync: (path: string) => [...files.keys()]
    .filter((file) => file.startsWith(`${path}/`))
    .map((file) => file.slice(path.length + 1)),
  readFileSync: (path: string) => {
    if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
    return files.get(path)!;
  },
  writeFileSync: (path: string, value: string) => { files.set(path, value); },
  unlinkSync: (path: string) => {
    if (!files.delete(path)) throw new Error(`ENOENT: ${path}`);
  },
}));

const spawn = mock((command: string, _args: string[], _options: unknown) => {
  const pid = nextPid++;
  livePids.add(pid);
  processes.set(pid, { command, startedAt: `Mon Oct 13 12:00:${pid} 2026` });
  return Object.assign(new EventEmitter(), {
    pid,
    unref: () => {},
    kill: () => livePids.delete(pid),
  });
});

mock.module("child_process", () => ({
  spawn,
  spawnSync: (_command: string, args: string[]) => {
    const info = processes.get(Number(args[1]));
    return info && livePids.has(Number(args[1]))
      ? { status: 0, stdout: `${info.command} ${process.pid} ${info.startedAt}` }
      : { status: 1, stdout: "" };
  },
}));

const plugin = (await import("./index")).default;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

type TestEvent = { type: string; data?: Record<string, unknown> };

class EventFeed {
  private queue: { event: TestEvent; done: () => void }[] = [];
  private wake?: () => void;

  emit(event: TestEvent) {
    const processed = deferred<void>();
    this.queue.push({ event, done: () => processed.resolve() });
    this.wake?.();
    return processed.promise;
  }

  async *subscribe({ signal }: { signal: AbortSignal }) {
    const onAbort = () => this.wake?.();
    signal.addEventListener("abort", onAbort);
    try {
      while (!signal.aborted) {
        const next = this.queue.shift();
        if (!next) {
          await new Promise<void>((resolve) => { this.wake = resolve; });
          continue;
        }
        yield next.event;
        next.done();
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      for (const next of this.queue) next.done();
    }
  }
}

const cleanups: (() => Promise<void> | void)[] = [];
let kill: ReturnType<typeof mock>;

beforeEach(() => {
  files.clear();
  directories.clear();
  processes.clear();
  livePids.clear();
  livePids.add(process.pid);
  spawn.mockClear();
  kill = mock((pid: number, signal?: string | number) => {
    if (!livePids.has(pid)) throw new Error("ESRCH");
    if (signal !== 0) livePids.delete(pid);
    return true;
  });
  process.kill = kill as typeof process.kill;
});

const originalKill = process.kill;
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  process.kill = originalKill;
  Object.defineProperty(process, "platform", originalPlatform);
});

async function setupV2() {
  const feed = new EventFeed();
  const waits: { sessionID: string; deferred: ReturnType<typeof deferred<void>> }[] = [];
  let contextHook!: (request: { sessionID: string }) => void;
  const dispose = mock(async () => {});
  const context = {
    session: {
      hook: async (_name: string, callback: typeof contextHook) => {
        contextHook = callback;
        return { dispose };
      },
      wait: mock(({ sessionID }: { sessionID: string }) => {
        const pending = deferred<void>();
        waits.push({ sessionID, deferred: pending });
        return pending.promise;
      }),
    },
    event: { subscribe: (options: { signal: AbortSignal }) => feed.subscribe(options) },
  };
  const cleanup = await plugin.setup(context as unknown as PluginContextV2);
  if (!cleanup) throw new Error("Expected V2 cleanup");
  cleanups.push(cleanup);
  return {
    emit: (type: string, data?: Record<string, unknown>) => feed.emit({ type, data }),
    dispatch: (sessionID: string) => contextHook({ sessionID }),
    waits,
    wait: context.session.wait,
    dispose,
    cleanup,
  };
}

function entries() {
  return [...files.keys()]
    .filter((path) => path.startsWith(`${sessionsDirectory}/`))
    .map((path) => path.slice(sessionsDirectory.length + 1))
    .sort();
}

function inhibitorPids() {
  return [...processes.keys()].filter((pid) => livePids.has(pid));
}

async function flushWaits() {
  // Drain the wait catch/finally chain without depending on wall-clock timers.
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

for (const platform of ["darwin", "linux"] as const) {
  describe(`V2 on ${platform}`, () => {
    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: platform });
    });

    test("keeps a background shell protected after its session goes idle", async () => {
      const runtime = await setupV2();
      runtime.dispatch("ses_parent");
      await runtime.emit("shell.created", { info: { id: "sh_build", metadata: { sessionID: "ses_parent" } } });
      runtime.waits[0].deferred.resolve();
      await flushWaits();

      expect(entries()).toEqual(["shell-sh_build"]);
      expect(inhibitorPids()).toHaveLength(1);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn.mock.calls[0][0]).toBe(platform === "darwin" ? "caffeinate" : "systemd-inhibit");

      await runtime.emit("shell.exited", { id: "sh_build", status: "exited", exit: 0 });
      expect(entries()).toEqual([]);
      expect(inhibitorPids()).toEqual([]);
    });

    test("stops only after every shell exits, regardless of completion order", async () => {
      const runtime = await setupV2();
      for (const id of ["sh_first", "sh_second", "sh_third"]) {
        // shell.created has no top-level sessionID, and can have no session metadata.
        await runtime.emit("shell.created", { info: { id, metadata: {} } });
      }
      for (const id of ["sh_second", "sh_first"]) {
        await runtime.emit("shell.exited", { id, status: "exited", exit: 0 });
        expect(inhibitorPids()).toHaveLength(1);
      }
      expect(entries()).toEqual(["shell-sh_third"]);
      expect(spawn).toHaveBeenCalledTimes(1);
      await runtime.emit("shell.exited", { id: "sh_third", status: "exited", exit: 0 });
      expect(inhibitorPids()).toEqual([]);
    });

    for (const [status, exit] of [["exited", 7], ["timeout", undefined], ["killed", undefined]] as const) {
      test(`releases a shell on terminal status ${status} (exit=${exit})`, async () => {
        const runtime = await setupV2();
        await runtime.emit("shell.created", { info: { id: "sh_failed" } });
        await runtime.emit("shell.exited", { id: "sh_failed", status, exit });
        expect(entries()).toEqual([]);
        expect(inhibitorPids()).toEqual([]);
      });
    }

    test("shell deletion releases only that shell", async () => {
      const runtime = await setupV2();
      runtime.dispatch("ses_active");
      await runtime.emit("shell.created", { info: { id: "sh_removed" } });
      await runtime.emit("shell.deleted", { id: "sh_removed" });
      expect(entries()).toEqual(["ses_active"]);
      expect(inhibitorPids()).toHaveLength(1);
      runtime.waits[0].deferred.resolve();
      await flushWaits();
      expect(inhibitorPids()).toEqual([]);
    });

    for (const terminal of ["session.idle", "session.execution.failed", "session.execution.interrupted"]) {
      test(`${terminal} does not release background shells`, async () => {
        const runtime = await setupV2();
        runtime.dispatch("ses_parent");
        await runtime.emit("shell.created", { info: { id: "sh_background" } });
        await runtime.emit(terminal, { sessionID: "ses_parent" });
        expect(entries()).toEqual(["shell-sh_background"]);
        expect(inhibitorPids()).toHaveLength(1);
        runtime.waits[0].deferred.resolve();
        await flushWaits();
        expect(entries()).toEqual(["shell-sh_background"]);
        await runtime.emit("shell.exited", { id: "sh_background", status: "exited" });
        expect(inhibitorPids()).toEqual([]);
      });
    }

    test("deduplicates creates, terminal events, and session waits", async () => {
      const runtime = await setupV2();
      runtime.dispatch("ses_busy");
      runtime.dispatch("ses_busy");
      await runtime.emit("session.status", { sessionID: "ses_busy", status: { type: "busy" } });
      expect(runtime.wait).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 2; i++) await runtime.emit("shell.created", { info: { id: "sh_same" } });
      expect(spawn).toHaveBeenCalledTimes(1);
      await runtime.emit("shell.exited", { id: "sh_same", status: "exited" });
      await runtime.emit("shell.exited", { id: "sh_same", status: "exited" });
      await runtime.emit("shell.deleted", { id: "sh_same" });
      await runtime.emit("shell.exited", { id: "sh_unknown", status: "exited" });
      expect(entries()).toEqual(["ses_busy"]);
      expect(inhibitorPids()).toHaveLength(1);
      runtime.waits[0].deferred.resolve();
      await flushWaits();
      expect(inhibitorPids()).toEqual([]);
    });

    test("an old session wait cannot release a new execution's entry", async () => {
      const runtime = await setupV2();
      runtime.dispatch("ses_repeat");
      await runtime.emit("session.execution.interrupted", { sessionID: "ses_repeat" });
      runtime.dispatch("ses_repeat");
      runtime.waits[0].deferred.resolve();
      await flushWaits();
      expect(entries()).toEqual(["ses_repeat"]);
      expect(inhibitorPids()).toHaveLength(1);
      runtime.waits[1].deferred.resolve();
      await flushWaits();
      expect(inhibitorPids()).toEqual([]);
    });

    test("a rejected session wait releases the session but not its shells", async () => {
      const runtime = await setupV2();
      runtime.dispatch("ses_missing");
      await runtime.emit("shell.created", { info: { id: "sh_remaining" } });
      runtime.waits[0].deferred.reject(new Error("Session removed"));
      await flushWaits();
      expect(entries()).toEqual(["shell-sh_remaining"]);
      expect(inhibitorPids()).toHaveLength(1);
    });

    test("unloading one instance preserves shared and separately owned locks", async () => {
      const first = await setupV2();
      const second = await setupV2();
      for (const runtime of [first, second]) {
        runtime.dispatch("ses_shared");
        await runtime.emit("shell.created", { info: { id: "sh_shared" } });
      }
      second.dispatch("ses_second");
      await second.emit("shell.created", { info: { id: "sh_second" } });
      await first.cleanup();
      expect(entries()).toEqual(["ses_second", "ses_shared", "shell-sh_second", "shell-sh_shared"]);
      expect(inhibitorPids()).toHaveLength(1);
      expect(first.dispose).toHaveBeenCalledTimes(1);
      first.waits[0].deferred.resolve();
      first.dispatch("ses_after_unload");
      await flushWaits();
      expect(entries()).not.toContain("ses_after_unload");
      expect(entries()).toContain("ses_shared");
      await second.emit("shell.exited", { id: "sh_shared", status: "exited" });
      await second.emit("shell.deleted", { id: "sh_second" });
      for (const pending of second.waits) pending.deferred.resolve();
      await flushWaits();
      expect(entries()).toEqual([]);
      expect(inhibitorPids()).toEqual([]);
    });

    test("cleanup is idempotent and does not release another process's lock", async () => {
      const runtime = await setupV2();
      livePids.add(123_456);
      files.set(`${sessionsDirectory}/ses_other_process`, "123456");
      await runtime.emit("shell.created", { info: { id: "sh_owned" } });
      runtime.dispatch("ses_owned");
      await runtime.cleanup();
      await runtime.cleanup();
      expect(entries()).toEqual(["ses_other_process"]);
      expect(inhibitorPids()).toHaveLength(1);
      runtime.waits[0].deferred.resolve();
      await flushWaits();
      expect(entries()).toEqual(["ses_other_process"]);
    });

    test("removes stale shell entries at startup", async () => {
      files.set(`${sessionsDirectory}/shell-sh_stale`, "999999");
      await setupV2();
      expect(entries()).toEqual([]);
      expect(inhibitorPids()).toEqual([]);
    });

    test("starts a new inhibitor for a later shell after all work exits", async () => {
      const runtime = await setupV2();
      for (const id of ["sh_before", "sh_after"]) {
        await runtime.emit("shell.created", { info: { id } });
        expect(inhibitorPids()).toHaveLength(1);
        await runtime.emit("shell.exited", { id, status: "exited" });
        expect(inhibitorPids()).toEqual([]);
      }
      expect(spawn).toHaveBeenCalledTimes(2);
    });
  });
}

test("V2 stays inactive on unsupported platforms", async () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  expect(await plugin.setup({} as PluginContextV2)).toBeUndefined();
  expect(entries()).toEqual([]);
  expect(spawn).not.toHaveBeenCalled();
});

test("V1 retains session-only lifecycle behavior", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  const hooks = await plugin.server({
    client: { app: { log: async () => {} } },
  } as unknown as Parameters<typeof plugin.server>[0]);
  const emit = async (type: string, properties: Record<string, unknown>) => {
    await hooks.event!({ event: { type, properties } } as Parameters<NonNullable<typeof hooks.event>>[0]);
  };
  await emit("session.status", { sessionID: "ses_v1", status: { type: "busy" } });
  await emit("shell.created", { info: { id: "sh_ignored" } });
  expect(entries()).toEqual(["ses_v1"]);
  await emit("session.idle", { sessionID: "ses_v1" });
  expect(entries()).toEqual([]);
  expect(inhibitorPids()).toEqual([]);
  await emit("session.status", { sessionID: "ses_v1_error", status: { type: "busy" } });
  await emit("session.error", { sessionID: "ses_v1_error" });
  expect(entries()).toEqual([]);
  expect(inhibitorPids()).toEqual([]);
});
