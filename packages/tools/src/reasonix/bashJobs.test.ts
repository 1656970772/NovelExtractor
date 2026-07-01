import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BashJobManager } from "./index";

interface JobEvent {
  kind: string;
  level: string;
  text: string;
}

type ManagerOptions = {
  eventSink?: { emit(event: JobEvent): void };
  stalledWarningMs?: number;
};

const scratchDirs: string[] = [];

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("Reasonix BashJobManager lifecycle parity", () => {
  it("emits stalled notes once and gates notices to the active session", async () => {
    const events: JobEvent[] = [];
    const manager = new BashJobManager({
      eventSink: { emit: (event: JobEvent) => events.push(event) },
      stalledWarningMs: 20
    } as ManagerOptions);

    manager.setActiveSession("session-a");
    const inactive = manager.startForSession("session-b", "bash", "inactive", () => "");
    await manager.waitForSession(undefined, "session-b", [inactive.id], 1);
    expect(events.some((event) => event.text.includes(inactive.id))).toBe(false);

    const fast = manager.startForSession("session-a", "bash", "fast", () => "");
    await manager.waitForSession(undefined, "session-a", [fast.id], 1);
    await sleep(50);
    expect(manager.drainCompletedNoteForSession("session-a")).toContain(`${fast.id} (fast) \u2014 done`);

    const quiet = manager.startForSession(
      "session-a",
      "bash",
      "quiet",
      ({ signal }) =>
        new Promise<string>((resolve) => {
          signal.addEventListener("abort", () => resolve(""), { once: true });
        })
    );
    await waitFor(() => events.some((event) => event.text.includes("may be stalled") && event.text.includes(quiet.id)));
    const stalled = manager.drainCompletedNoteForSession("session-a");
    expect(stalled).toContain(`${quiet.id} (quiet) may be stalled`);
    expect(stalled).toContain("still running after 0s");
    expect(stalled).toContain("Inspect it with wait or bash_output, or stop it with kill_shell.");
    expect(manager.drainCompletedNoteForSession("session-a")).toBe("");
    expect(manager.hasUnfinishedForSession("session-a")).toBe(true);

    manager.killForSession("session-a", quiet.id);
    await manager.waitForSession(undefined, "session-a", [quiet.id], 1);
    expect(manager.hasUnfinishedForSession("session-a")).toBe(false);
    await manager.close();
  });

  it("formats stalled durations like Go rounded duration strings", async () => {
    vi.useFakeTimers();
    const manager = new BashJobManager({ stalledWarningMs: 61_000 });
    try {
      const quiet = manager.startForSession(
        "session-a",
        "bash",
        "long-quiet",
        ({ signal }) =>
          new Promise<string>((resolve) => {
            signal.addEventListener("abort", () => resolve(""), { once: true });
          })
      );

      await vi.advanceTimersByTimeAsync(61_000);
      const stalled = manager.drainCompletedNoteForSession("session-a");
      expect(stalled).toContain(`${quiet.id} (long-quiet) may be stalled`);
      expect(stalled).toContain("still running after 1m1s");

      manager.killForSession("session-a", quiet.id);
      await manager.waitForSession(undefined, "session-a", [quiet.id], 1);
    } finally {
      await manager.close();
      vi.useRealTimers();
    }
  });

  it("clears wait timeout timer and abort listener when the job finishes first", async () => {
    vi.useFakeTimers();
    const manager = new BashJobManager();
    const controller = new AbortController();
    const signal = controller.signal;
    let listenerAdds = 0;
    let listenerRemoves = 0;
    const originalAdd = signal.addEventListener.bind(signal);
    const originalRemove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
      listenerAdds += 1;
      return originalAdd(...args);
    }) as AbortSignal["addEventListener"];
    signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
      listenerRemoves += 1;
      return originalRemove(...args);
    }) as AbortSignal["removeEventListener"];

    try {
      const job = manager.startForSession("session-a", "bash", "fast", () => "");
      await manager.waitForSession(signal, "session-a", [job.id], 3600);
      expect(vi.getTimerCount()).toBe(0);
      expect(listenerAdds).toBe(1);
      expect(listenerRemoves).toBe(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      await manager.close();
    }
  });

  it("waits for killed explicit jobs to finish cleanup before returning", async () => {
    const manager = new BashJobManager();
    const cleanupDelayMs = 75;
    try {
      const job = manager.startForSession("session-a", "bash", "cleanup", ({ signal, write }) =>
        new Promise<string>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              setTimeout(() => {
                write("cleanup-after-abort\n");
                resolve("");
              }, cleanupDelayMs);
            },
            { once: true }
          );
        })
      );

      expect(manager.killForSession("session-a", job.id)).toBe(true);
      const start = Date.now();
      const [result] = await manager.waitForSession(undefined, "session-a", [job.id], 1);

      expect(Date.now() - start).toBeGreaterThanOrEqual(cleanupDelayMs);
      expect(result?.status).toBe("killed");
      expect(result?.output).toContain("cleanup-after-abort\n");
    } finally {
      await manager.close();
    }
  });

  it("clears closeWithGrace timer when teardown finishes first", async () => {
    vi.useFakeTimers();
    const manager = new BashJobManager();
    try {
      manager.startForSession("session-a", "bash", "cooperative", ({ signal }) =>
        new Promise<string>((resolve) => {
          signal.addEventListener("abort", () => resolve(""), { once: true });
        })
      );
      await manager.closeWithGrace(3_600_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("reports still-unwinding killed jobs on repeated closeWithGrace calls", async () => {
    const manager = new BashJobManager();
    let release!: () => void;
    try {
      const job = manager.startForSession(
        "",
        "task",
        "cleanup",
        ({ signal }) =>
          new Promise<string>((resolve) => {
            release = () => resolve("");
            signal.addEventListener("abort", () => {
              // Stay pending until release() so repeated teardown can observe the same target.
            });
          })
      );

      await waitFor(() => manager.hasUnfinishedForSession(""));
      const first = await manager.closeWithGrace(25);
      const second = await manager.closeWithGrace(25);

      expect(first.timedOut).toHaveLength(1);
      expect(first.timedOut[0]).toMatchObject({ id: job.id, kind: "task", label: "cleanup" });
      expect(second.timedOut).toHaveLength(1);
      expect(second.timedOut[0]).toMatchObject({ id: job.id, kind: "task", label: "cleanup" });
    } finally {
      release();
      await sleep(10);
    }
  });

  it("marks jobs started after manager close as killed under root cancellation", async () => {
    const closeModes = [
      {
        name: "closeWithGrace",
        close: async (manager: BashJobManager) => {
          await manager.closeWithGrace(0);
        }
      },
      {
        name: "closeAsync",
        close: async (manager: BashJobManager) => {
          manager.closeAsync();
        }
      },
      {
        name: "close",
        close: async (manager: BashJobManager) => {
          await manager.close();
        }
      }
    ];

    for (const mode of closeModes) {
      const root = await scratchDir();
      const manager = new BashJobManager();
      manager.setActiveSessionPath("session-a", path.join(root, `${mode.name}.jsonl`));
      await mode.close(manager);

      let sawAbortedSignal = false;
      const job = manager.startForSession("session-a", "task", mode.name, ({ signal, write }) => {
        sawAbortedSignal = signal.aborted;
        write("ignored output");
        return "ignored result";
      });

      const [result] = await manager.waitForSession(undefined, "session-a", [job.id], 1);
      expect(sawAbortedSignal).toBe(true);
      expect(result?.status).toBe("killed");
    }
  });

  it("destroys sessions, suppresses destroyed completion notes, and bounds teardown waits", async () => {
    const manager = new BashJobManager();
    let release!: () => void;
    const job = manager.startForSession(
      "session-a",
      "task",
      "cleanup",
      ({ signal }) =>
        new Promise<string>((resolve) => {
          release = () => resolve("");
          signal.addEventListener("abort", () => {
            // Hold the promise open until release() so teardown can time out.
          });
        })
    );

    await waitFor(() => manager.hasUnfinishedForSession("session-a"));
    const handle = manager.beginDestroySession("session-a");
    expect(manager.isDestroying("session-a")).toBe(true);
    const timed = await manager.waitTeardown(undefined, handle, 25);
    expect(timed.timedOut).toHaveLength(1);
    expect(timed.timedOut[0]).toMatchObject({ id: job.id, kind: "task", label: "cleanup" });
    expect(timed.timedOut[0]?.waitedMs).toBeGreaterThan(0);
    expect(manager.drainCompletedNoteForSession("session-a")).toBe("");

    release();
    await Promise.allSettled(handle.donePromises());
    const results = await manager.waitForSession(undefined, "session-a", [job.id], 1);
    expect(results[0]?.status).toBe("killed");
    expect(manager.drainCompletedNoteForSession("session-a")).toBe("");
    manager.finishDestroySession("session-a");
    expect(manager.isDestroying("session-a")).toBe(false);
    expect(manager.outputForSession("session-a", job.id).found).toBe(false);
    await manager.close();
  });

  it("closeWithGrace returns timed-out jobs without hanging on non-cooperative cleanup", async () => {
    const events: JobEvent[] = [];
    const manager = new BashJobManager({
      eventSink: { emit: (event: JobEvent) => events.push(event) }
    } as ManagerOptions);
    let release!: () => void;
    const job = manager.startForSession(
      "",
      "task",
      "cleanup",
      ({ signal }) =>
        new Promise<string>((resolve) => {
          release = () => resolve("");
          signal.addEventListener("abort", () => {
            // stay pending until release
          });
        })
    );

    await waitFor(() => manager.hasUnfinishedForSession(""));
    const start = Date.now();
    const timed = await manager.closeWithGrace(25);
    expect(Date.now() - start).toBeLessThan(500);
    expect(timed.timedOut).toHaveLength(1);
    expect(timed.hasTimedOut()).toBe(true);
    expect(timed.timedOut[0]).toMatchObject({ id: job.id, kind: "task", label: "cleanup" });
    expect(events.some((event) => event.text.includes("background job teardown timed out") && event.text.includes("waited=0s"))).toBe(true);
    expect(manager.runningForSession("")).toEqual([]);

    release();
    const results = await manager.waitForSession(undefined, "", [job.id], 1);
    expect(results[0]?.status).toBe("killed");
  });

  it("returns unfinished destroy jobs without timeout notice when parent aborts teardown wait", async () => {
    const events: JobEvent[] = [];
    const manager = new BashJobManager({
      eventSink: { emit: (event: JobEvent) => events.push(event) }
    } as ManagerOptions);
    let release!: () => void;
    try {
      const job = manager.startForSession(
        "session-a",
        "task",
        "abort-cleanup",
        ({ signal }) =>
          new Promise<string>((resolve) => {
            release = () => resolve("");
            signal.addEventListener("abort", () => {
              // Stay pending until release() so parent cancellation can win the teardown wait.
            });
          })
      );

      await waitFor(() => manager.hasUnfinishedForSession("session-a"));
      const handle = manager.beginDestroySession("session-a");
      const controller = new AbortController();
      const waiting = manager.waitTeardown(controller.signal, handle, 60_000);
      controller.abort();
      const result = await waiting;

      expect(result.timedOut).toHaveLength(1);
      expect(result.timedOut[0]).toMatchObject({ id: job.id, kind: "task", label: "abort-cleanup" });
      expect(result.hasTimedOut()).toBe(false);
      expect(events.some((event) => event.text.includes("background job teardown timed out"))).toBe(false);
    } finally {
      release();
      await sleep(10);
      await manager.close();
    }
  });

  it("restores completed session artifacts, scopes them by session, and advances sequence ids", async () => {
    const root = await scratchDir();
    const pathA = path.join(root, "a.jsonl");
    const pathB = path.join(root, "b.jsonl");

    const first = new BashJobManager();
    first.setActiveSessionPath("session-a", pathA);
    const jobA = first.startForSession("session-a", "bash", "a", ({ write }) => {
      write("from-a");
      return "";
    });
    await first.waitForSession(undefined, "session-a", [jobA.id], 1);
    await first.close();

    const second = new BashJobManager();
    second.setActiveSessionPath("session-b", pathB);
    const jobB = second.startForSession("session-b", "bash", "b", ({ write }) => {
      write("from-b");
      return "";
    });
    await second.waitForSession(undefined, "session-b", [jobB.id], 1);
    await second.close();
    expect(jobA.id).toBe("bash-1");
    expect(jobB.id).toBe("bash-1");

    const restored = new BashJobManager();
    restored.setActiveSessionPath("session-a", pathA);
    restored.setActiveSessionPath("session-b", pathB);
    const restoredA = await restored.waitForSession(undefined, "session-a", ["bash-1"], 1);
    const restoredB = await restored.waitForSession(undefined, "session-b", ["bash-1"], 1);
    expect(restoredA[0]?.output).toBe("from-a");
    expect(restoredB[0]?.output).toBe("from-b");
    await expect(restored.waitForSession(undefined, "session-a", [], 1)).resolves.toEqual([]);

    const next = restored.startForSession("session-b", "bash", "next", () => "");
    expect(next.id).not.toBe("bash-1");
    await restored.close();
  });

  it("migrates running artifacts to the active session path after completion", async () => {
    const root = await scratchDir();
    const sessionPath = path.join(root, "session.jsonl");
    const manager = new BashJobManager();
    let release!: () => void;
    let jobId = "";
    const wroteBefore = new Promise<void>((resolve) => {
      const job = manager.startForSession("session-a", "bash", "migrate", ({ write }) => {
        write("before\n");
        resolve();
        return new Promise<string>((done) => {
          release = () => {
            write("after\n");
            done("");
          };
        });
      });
      jobId = job.id;
    });

    await wroteBefore;
    const before = storedJob(manager, jobId);
    const oldPath = before.artifactPath;
    manager.setActiveSessionPath("session-a", sessionPath);
    expect(storedJob(manager, jobId).artifactPath).toBe(oldPath);

    release();
    const result = await manager.waitForSession(undefined, "session-a", [jobId], 1);
    const donePath = storedJob(manager, jobId).artifactPath;
    expect(donePath.startsWith(`${artifactDir(sessionPath)}${path.sep}`)).toBe(true);
    expect(result[0]?.output).toContain("before\n");
    expect(result[0]?.output).toContain("after\n");
    await expect(readFile(donePath, "utf8")).resolves.toContain("after\n");
    await manager.close();
  });

  it("adopts unscoped temporary jobs and preserves successful output on migration failure", async () => {
    const root = await scratchDir();
    const sessionPath = path.join(root, "session.jsonl");
    await writeFile(artifactDir(sessionPath), "not a dir", "utf8");
    const events: JobEvent[] = [];
    const manager = new BashJobManager({
      eventSink: { emit: (event: JobEvent) => events.push(event) }
    } as ManagerOptions);

    const job = manager.startForSession("", "task", "temporary", () => "temporary answer");
    await manager.waitForSession(undefined, "", [job.id], 1);
    manager.setActiveSessionPath("session-a", sessionPath);

    const output = manager.outputForSession("session-a", job.id);
    expect(output.found).toBe(true);
    expect(output.status).toBe("done");
    expect(output.text).toContain("temporary answer");
    expect(output.text).toContain("job artifact incomplete: migration:");
    const waited = await manager.waitForSession(undefined, "session-a", [job.id], 1);
    expect(waited[0]?.status).toBe("done");
    expect(waited[0]?.output).toContain("job artifact incomplete: migration:");
    expect(manager.drainCompletedNoteForSession("session-a")).toContain(job.id);
    expect(events.some((event) => event.text.includes("job artifact migration failed"))).toBe(true);
    await manager.close();
  });

  it("keeps already-moved job output readable when artifact migration partially fails", async () => {
    const root = await scratchDir();
    const sessionPath = path.join(root, "session.jsonl");
    const newDir = artifactDir(sessionPath);
    const manager = new BashJobManager();
    try {
      const job = manager.startForSession("", "aaa", "partial-migration", ({ write }) => {
        write("payload-before-partial-failure");
        return "";
      });
      await manager.waitForSession(undefined, "", [job.id], 1);
      const stored = storedJob(manager, job.id);
      const oldDir = path.dirname(stored.artifactPath);
      await writeFile(path.join(oldDir, "zzz-block"), "force partial failure", "utf8");
      await mkdir(path.join(newDir, "zzz-block"), { recursive: true });

      manager.setActiveSessionPath("session-a", sessionPath);

      const waited = await manager.waitForSession(undefined, "session-a", [job.id], 1);
      expect(waited[0]?.output).toContain("payload-before-partial-failure");
    } finally {
      await manager.close();
    }
  });

  it("does not keep full streamed output in memory when artifact creation fails", async () => {
    const root = await scratchDir();
    const sessionPath = path.join(root, "session.jsonl");
    await writeFile(artifactDir(sessionPath), "not a dir", "utf8");
    const manager = new BashJobManager();
    manager.setActiveSessionPath("session-a", sessionPath);
    try {
      const payload = Buffer.concat([
        Buffer.from("HEAD-MARKER\nMIDDLE-SHOULD-NOT-LEAK\n", "utf8"),
        Buffer.alloc(70 * 1024, "x"),
        Buffer.from("\nTAIL-MARKER\n", "utf8")
      ]);
      const job = manager.startForSession("session-a", "bash", "artifact-open-fail", ({ write }) => {
        write(payload);
        return "";
      });

      const [waited] = await manager.waitForSession(undefined, "session-a", [job.id], 1);
      expect(waited?.output).toContain("TAIL-MARKER");
      expect(waited?.output).toContain("job artifact incomplete:");
      expect(waited?.output).not.toContain("HEAD-MARKER");
      expect(waited?.output).not.toContain("MIDDLE-SHOULD-NOT-LEAK");

      const output = manager.outputForSession("session-a", job.id);
      expect(output.text).toContain("job artifact incomplete:");
      expect(output.text).not.toContain("MIDDLE-SHOULD-NOT-LEAK");
    } finally {
      await manager.close();
    }
  });

  it("does not read a partial artifact into wait output after artifact write fails", async () => {
    vi.resetModules();
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const actualFsDefault = (actualFs as typeof actualFs & { default?: typeof actualFs }).default ?? actualFs;
    const callActualWriteSync = actualFs.writeSync as unknown as (...args: unknown[]) => number;
    const writeSync = vi.fn((...args: unknown[]) => {
      const [, data] = args;
      if (Buffer.isBuffer(data) && data.toString("utf8").includes("TAIL-MARKER")) {
        throw new Error("forced artifact write failure after create");
      }
      return callActualWriteSync(...args);
    });
    vi.doMock("node:fs", () => ({
      ...actualFs,
      writeSync,
      default: { ...actualFsDefault, writeSync }
    }));

    let manager: BashJobManager | undefined;
    try {
      const { BashJobManager: MockedBashJobManager } = await import("./bashJobs");
      manager = new MockedBashJobManager();
      const firstPayload = Buffer.concat([
        Buffer.from("HEAD-MARKER\nMIDDLE-SHOULD-NOT-LEAK\n", "utf8"),
        Buffer.alloc(70 * 1024, "x")
      ]);
      const job = manager.startForSession("session-a", "bash", "artifact-write-fail", ({ write }) => {
        write(firstPayload);
        write("TAIL-MARKER\n");
        return "";
      });

      const [waited] = await manager.waitForSession(undefined, "session-a", [job.id], 1);
      const output = waited?.output ?? "";
      expect({
        containsHead: output.includes("HEAD-MARKER"),
        containsMiddle: output.includes("MIDDLE-SHOULD-NOT-LEAK"),
        containsTail: output.includes("TAIL-MARKER"),
        containsWarning: output.includes("job artifact incomplete: forced artifact write failure after create")
      }).toEqual({
        containsHead: false,
        containsMiddle: false,
        containsTail: true,
        containsWarning: true
      });
    } finally {
      await manager?.close();
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("falls back to bounded tail when artifact reads fail", async () => {
    const manager = new BashJobManager();
    let release!: () => void;
    let jobId = "";
    try {
      const wrotePayload = new Promise<void>((resolve) => {
        const job = manager.startForSession("session-a", "bash", "artifact-read-fail", ({ write }) => {
          write(
            Buffer.concat([
              Buffer.from("HEAD-MARKER\nMIDDLE-SHOULD-NOT-LEAK\n", "utf8"),
              Buffer.alloc(70 * 1024, "x"),
              Buffer.from("\nTAIL-MARKER\n", "utf8")
            ])
          );
          resolve();
          return new Promise<string>((done) => {
            release = () => done("");
          });
        });
        jobId = job.id;
        void job;
      });

      await wrotePayload;
      const stored = mutableStoredJob(manager, jobId);
      stored.artifactPath = `${stored.artifactPath}.missing.log`;
      const output = manager.outputForSession("session-a", jobId).text;
      const summary = {
        hasHead: output.includes("HEAD-MARKER"),
        hasMiddle: output.includes("MIDDLE-SHOULD-NOT-LEAK"),
        hasTail: output.includes("TAIL-MARKER"),
        warning: output.includes("job artifact incomplete:")
      };
      expect(summary).toEqual({
        hasHead: false,
        hasMiddle: false,
        hasTail: true,
        warning: true
      });
    } finally {
      release?.();
      await manager.close();
    }
  });

  it("reads artifact output incrementally from the previous offset without whole-file reads", async () => {
    vi.resetModules();
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let artifactReadFileSyncCalls = 0;
    const actualFsDefault = (actualFs as typeof actualFs & { default?: typeof actualFs }).default ?? actualFs;
    const readFileSync = vi.fn((filePath: unknown, options?: unknown) => {
      if (typeof filePath === "string" && filePath.endsWith(".log")) {
        artifactReadFileSyncCalls += 1;
      }
      return (actualFs.readFileSync as (...args: unknown[]) => Buffer | string)(filePath, options);
    });
    vi.doMock("node:fs", () => ({
      ...actualFs,
      readFileSync,
      default: { ...actualFsDefault, readFileSync }
    }));

    let manager: BashJobManager | undefined;
    let release!: () => void;
    let released = false;
    try {
      const { BashJobManager: MockedBashJobManager } = await import("./bashJobs");
      manager = new MockedBashJobManager();
      const prefix = "prefix output\n";
      const suffix = "suffix output\n";
      const wrotePrefix = new Promise<void>((resolve) => {
        const job = manager!.startForSession("session-a", "bash", "offset", ({ write }) => {
          write(prefix);
          resolve();
          return new Promise<string>((done) => {
            release = () => {
              write(suffix);
              done("");
            };
          });
        });
        void job;
      });

      await wrotePrefix;
      const [stored] = storedJobs(manager);
      const first = manager.outputForSession("session-a", stored.id);
      expect(first.text).toBe(prefix);

      release();
      released = true;
      await stored.done;
      const second = manager.outputForSession("session-a", stored.id);

      expect(second.text).toBe(suffix);
      expect(artifactReadFileSyncCalls).toBe(0);
    } finally {
      if (!released) {
        release?.();
      }
      await manager?.close();
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
});

function storedJob(manager: BashJobManager, id: string): { artifactPath: string; artifactMetaPath: string } {
  const jobs = (manager as unknown as { jobs: Map<string, unknown> }).jobs;
  for (const value of jobs.values()) {
    const job = value as { id?: string; artifactPath?: string; artifactMetaPath?: string };
    if (job.id === id) {
      return { artifactPath: job.artifactPath ?? "", artifactMetaPath: job.artifactMetaPath ?? "" };
    }
  }
  throw new Error(`missing stored job ${id}`);
}

function mutableStoredJob(manager: BashJobManager, id: string): { artifactPath: string } {
  const jobs = (manager as unknown as { jobs: Map<string, unknown> }).jobs;
  for (const value of jobs.values()) {
    const job = value as { id?: string; artifactPath?: string };
    if (job.id === id && typeof job.artifactPath === "string") {
      return job as { artifactPath: string };
    }
  }
  throw new Error(`missing stored job ${id}`);
}

function storedJobs(manager: BashJobManager): Array<{ id: string; done: Promise<void> }> {
  const jobs = (manager as unknown as { jobs: Map<string, unknown> }).jobs;
  return [...jobs.values()].map((value) => {
    const job = value as { id?: string; done?: Promise<void> };
    if (typeof job.id !== "string" || !(job.done instanceof Promise)) {
      throw new Error("unexpected stored job shape");
    }
    return { id: job.id, done: job.done };
  });
}

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reasonix-jobs-"));
  scratchDirs.push(dir);
  return dir;
}

function artifactDir(sessionPath: string): string {
  return sessionPath.trim().replace(/\.jsonl$/u, "") + ".jobs";
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await sleep(5);
  }
  throw new Error("condition not met within deadline");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
