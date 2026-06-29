import { describe, expect, it, vi } from "vitest";
import { createJobRuntime, type JobRunInput, type JobRuntimeEvent } from "./jobRuntime";

function twoWindowJob(overrides: Partial<JobRunInput> = {}): JobRunInput {
  return {
    jobId: "job-1",
    bookId: "book-1",
    modelId: "model-fixture",
    templateIds: ["template-fixture"],
    windows: [
      { id: "window-1", chapterIds: ["chapter-1"], prompt: "第一窗" },
      { id: "window-2", chapterIds: ["chapter-2"], prompt: "第二窗" }
    ],
    ...overrides
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

describe("P0 job runtime", () => {
  it("runs a fixture job with two windows and emits ordered events", async () => {
    const runtime = createJobRuntime({
      maxConcurrentJobs: 1,
      llm: {
        completeWindow: vi.fn().mockResolvedValue({
          content: "window ok",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          fee: { amount: 0.01, currency: "USD" }
        })
      },
      tools: {
        execute: vi.fn().mockResolvedValue({ name: "write_file", result: "ok" })
      }
    });
    const events: JobRuntimeEvent[] = [];
    runtime.events.subscribe((event) => {
      events.push(event);
    });

    const result = await runtime.startJob(twoWindowJob());

    expect(result).toMatchObject({ ok: true });
    expect(events.map((event) => event.type)).toEqual([
      "job.started",
      "job.window.started",
      "job.window.completed",
      "job.window.started",
      "job.window.completed",
      "job.completed"
    ]);
  });

  it("guards P0 single job execution with a typed error", async () => {
    const firstWindow = createDeferred<{
      content: string;
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
      fee: { amount: number; currency: string };
    }>();
    const runtime = createJobRuntime({
      maxConcurrentJobs: 1,
      llm: {
        completeWindow: vi.fn().mockReturnValueOnce(firstWindow.promise)
      },
      tools: {
        execute: vi.fn()
      }
    });

    const firstRun = runtime.startJob(twoWindowJob({ windows: [{ id: "window-1", chapterIds: ["chapter-1"] }] }));
    const secondRun = await runtime.startJob(twoWindowJob({ jobId: "job-2" }));

    expect(secondRun).toEqual({ ok: false, error: { code: "job_already_running" } });
    firstWindow.resolve({
      content: "done",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      fee: { amount: 0.03, currency: "USD" }
    });
    await firstRun;
  });

  it("pauses only at a window boundary and resumes with the next window", async () => {
    const firstWindow = createDeferred<{
      content: string;
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
      fee: { amount: number; currency: string };
    }>();
    const runtime = createJobRuntime({
      maxConcurrentJobs: 1,
      llm: {
        completeWindow: vi
          .fn()
          .mockReturnValueOnce(firstWindow.promise)
          .mockResolvedValueOnce({
            content: "second done",
            usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11 },
            fee: { amount: 0.11, currency: "USD" }
          })
      },
      tools: {
        execute: vi.fn()
      }
    });
    const events: JobRuntimeEvent[] = [];
    runtime.events.subscribe((event) => {
      events.push(event);
    });

    const running = runtime.startJob(twoWindowJob());
    await vi.waitFor(() => expect(events.map((event) => event.type)).toContain("job.window.started"));

    await expect(runtime.pauseJob("job-1")).resolves.toEqual({ ok: true });
    expect(runtime.getJobState("job-1")?.status).toBe("pause_requested");
    firstWindow.resolve({
      content: "first done",
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      fee: { amount: 0.07, currency: "USD" }
    });
    await vi.waitFor(() => expect(runtime.getJobState("job-1")?.status).toBe("paused"));
    expect(events.map((event) => event.type)).toEqual([
      "job.started",
      "job.window.started",
      "job.pause.requested",
      "job.window.completed",
      "job.paused"
    ]);

    await expect(runtime.resumeJob("job-1")).resolves.toEqual({ ok: true });
    const result = await running;

    expect(result).toMatchObject({ ok: true });
    expect(events.map((event) => event.type)).toEqual([
      "job.started",
      "job.window.started",
      "job.pause.requested",
      "job.window.completed",
      "job.paused",
      "job.resume.requested",
      "job.window.started",
      "job.window.completed",
      "job.completed"
    ]);
  });

  it("emits job.failed and stops remaining windows", async () => {
    const runtime = createJobRuntime({
      maxConcurrentJobs: 1,
      llm: {
        completeWindow: vi.fn().mockRejectedValue(new Error("fixture model failure"))
      },
      tools: {
        execute: vi.fn()
      }
    });
    const events: JobRuntimeEvent[] = [];
    runtime.events.subscribe((event) => {
      events.push(event);
    });

    const result = await runtime.startJob(twoWindowJob());

    expect(result).toEqual({
      ok: false,
      error: { code: "job_failed", message: "fixture model failure" }
    });
    expect(events.map((event) => event.type)).toEqual(["job.started", "job.window.started", "job.failed"]);
    expect(runtime.getJobState("job-1")?.completedWindowCount).toBe(0);
  });

  it("returns a typed failure and releases the active lock when a start event subscriber fails", async () => {
    const runtime = createJobRuntime({
      maxConcurrentJobs: 1,
      llm: {
        completeWindow: vi.fn().mockResolvedValue({
          content: "done",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          fee: { amount: 0.02, currency: "USD" }
        })
      },
      tools: {
        execute: vi.fn()
      }
    });
    runtime.events.subscribe((event) => {
      if (event.type === "job.started" && event.payload.jobId === "job-1") {
        throw new Error("start subscriber failed");
      }
      if (event.type === "job.failed" && event.payload.jobId === "job-1") {
        throw new Error("failed subscriber failed");
      }
    });

    await expect(runtime.startJob(twoWindowJob({ windows: [{ id: "window-1", chapterIds: ["chapter-1"] }] }))).resolves.toEqual({
      ok: false,
      error: { code: "job_failed", message: "start subscriber failed" }
    });
    await expect(runtime.startJob(twoWindowJob({ jobId: "job-2", windows: [{ id: "window-1", chapterIds: ["chapter-1"] }] }))).resolves.toMatchObject({
      ok: true
    });
  });

  it("returns a typed failure and releases the active lock when initial state persistence fails", async () => {
    const runtime = createJobRuntime({
      maxConcurrentJobs: 1,
      llm: {
        completeWindow: vi.fn().mockResolvedValue({
          content: "done",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          fee: { amount: 0.02, currency: "USD" }
        })
      },
      tools: {
        execute: vi.fn()
      },
      repository: {
        saveState: vi.fn().mockRejectedValueOnce(new Error("state store failed")).mockResolvedValue(undefined)
      }
    });

    await expect(runtime.startJob(twoWindowJob({ windows: [{ id: "window-1", chapterIds: ["chapter-1"] }] }))).resolves.toEqual({
      ok: false,
      error: { code: "job_failed", message: "state store failed" }
    });
    await expect(runtime.startJob(twoWindowJob({ jobId: "job-2", windows: [{ id: "window-1", chapterIds: ["chapter-1"] }] }))).resolves.toMatchObject({
      ok: true
    });
  });

  it("deletes job state without deleting shared reports", async () => {
    const deleteReportsForJob = vi.fn();
    const runtime = createJobRuntime({
      maxConcurrentJobs: 1,
      llm: {
        completeWindow: vi.fn().mockResolvedValue({
          content: "done",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          fee: { amount: 0.02, currency: "USD" }
        })
      },
      tools: {
        execute: vi.fn()
      },
      reports: {
        deleteReportsForJob
      }
    });
    const events: JobRuntimeEvent[] = [];
    runtime.events.subscribe((event) => {
      events.push(event);
    });
    await runtime.startJob(twoWindowJob({ windows: [{ id: "window-1", chapterIds: ["chapter-1"] }] }));

    await expect(runtime.deleteJob("job-1")).resolves.toEqual({ ok: true });

    expect(runtime.getJobState("job-1")?.status).toBe("deleted");
    expect(deleteReportsForJob).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe("job.deleted");
  });

  it("deletes a paused job by resolving the blocked run without continuing windows", async () => {
    const firstWindow = createDeferred<{
      content: string;
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
      fee: { amount: number; currency: string };
    }>();
    const completeWindow = vi
      .fn()
      .mockReturnValueOnce(firstWindow.promise)
      .mockResolvedValueOnce({
        content: "second should not run",
        usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11 },
        fee: { amount: 0.11, currency: "USD" }
      });
    const runtime = createJobRuntime({
      maxConcurrentJobs: 1,
      llm: { completeWindow },
      tools: {
        execute: vi.fn()
      }
    });
    const events: JobRuntimeEvent[] = [];
    runtime.events.subscribe((event) => {
      events.push(event);
    });

    const running = runtime.startJob(twoWindowJob());
    await vi.waitFor(() => expect(events.map((event) => event.type)).toContain("job.window.started"));
    await expect(runtime.pauseJob("job-1")).resolves.toEqual({ ok: true });
    firstWindow.resolve({
      content: "first done",
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      fee: { amount: 0.07, currency: "USD" }
    });
    await vi.waitFor(() => expect(runtime.getJobState("job-1")?.status).toBe("paused"));

    await expect(runtime.deleteJob("job-1")).resolves.toEqual({ ok: true });
    const result = await Promise.race([
      running,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 25))
    ]);

    expect(result).toMatchObject({ ok: true, state: { status: "deleted" } });
    expect(runtime.getJobState("job-1")?.status).toBe("deleted");
    expect(completeWindow).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.type)).toEqual([
      "job.started",
      "job.window.started",
      "job.pause.requested",
      "job.window.completed",
      "job.paused",
      "job.deleted"
    ]);

    const nextRun = await runtime.startJob(twoWindowJob({ jobId: "job-2", windows: [{ id: "window-1", chapterIds: ["chapter-1"] }] }));
    expect(nextRun).toMatchObject({ ok: true });
  });

  it("cancels a paused job and releases the active job lock", async () => {
    const firstWindow = createDeferred<{
      content: string;
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
      fee: { amount: number; currency: string };
    }>();
    const runtime = createJobRuntime({
      maxConcurrentJobs: 1,
      llm: {
        completeWindow: vi.fn().mockReturnValueOnce(firstWindow.promise).mockResolvedValue({
          content: "next",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          fee: { amount: 0.02, currency: "USD" }
        })
      },
      tools: {
        execute: vi.fn()
      }
    });

    const running = runtime.startJob(twoWindowJob());
    await vi.waitFor(() => expect(runtime.getJobState("job-1")?.status).toBe("running"));
    await expect(runtime.pauseJob("job-1")).resolves.toEqual({ ok: true });
    firstWindow.resolve({
      content: "first done",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      fee: { amount: 0.03, currency: "USD" }
    });
    await vi.waitFor(() => expect(runtime.getJobState("job-1")?.status).toBe("paused"));

    await expect(runtime.cancelJob("job-1")).resolves.toEqual({ ok: true });
    await expect(running).resolves.toMatchObject({ ok: true, state: { status: "cancelled" } });

    const nextRun = await runtime.startJob(twoWindowJob({ jobId: "job-2", windows: [{ id: "window-1", chapterIds: ["chapter-1"] }] }));
    expect(nextRun).toMatchObject({ ok: true });
  });

  it("waits for pause state persistence before resolving the control call", async () => {
    const firstWindow = createDeferred<{
      content: string;
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
      fee: { amount: number; currency: string };
    }>();
    const pauseSave = createDeferred<void>();
    let saveCount = 0;
    const runtime = createJobRuntime({
      maxConcurrentJobs: 1,
      llm: {
        completeWindow: vi.fn().mockReturnValue(firstWindow.promise)
      },
      tools: {
        execute: vi.fn()
      },
      repository: {
        saveState: vi.fn(async () => {
          saveCount += 1;
          if (saveCount === 2) {
            await pauseSave.promise;
          }
        })
      }
    });
    const events: JobRuntimeEvent[] = [];
    runtime.events.subscribe((event) => {
      events.push(event);
    });
    const running = runtime.startJob(twoWindowJob({ windows: [{ id: "window-1", chapterIds: ["chapter-1"] }] }));
    await vi.waitFor(() => expect(events.map((event) => event.type)).toContain("job.window.started"));

    let pauseSettled = false;
    const pauseResult = Promise.resolve(runtime.pauseJob("job-1")).then((result) => {
      pauseSettled = true;
      return result;
    });

    try {
      await Promise.resolve();
      expect(pauseSettled).toBe(false);
    } finally {
      pauseSave.resolve();
    }

    await expect(pauseResult).resolves.toEqual({ ok: true });
    firstWindow.resolve({
      content: "done",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      fee: { amount: 0.03, currency: "USD" }
    });
    await vi.waitFor(() => expect(runtime.getJobState("job-1")?.status).toBe("paused"));
    await expect(runtime.resumeJob("job-1")).resolves.toEqual({ ok: true });
    await expect(running).resolves.toMatchObject({ ok: true });
  });

  it("rejects misleading P0 multi-job concurrency configuration", () => {
    expect(() =>
      createJobRuntime({
        maxConcurrentJobs: 2,
        llm: {
          completeWindow: vi.fn()
        },
        tools: {
          execute: vi.fn()
        }
      })
    ).toThrow("maxConcurrentJobs must be 1 in P0");
  });

  it("records usage and fee from LLM fixtures without pricing constants", async () => {
    const runtime = createJobRuntime({
      maxConcurrentJobs: 1,
      llm: {
        completeWindow: vi
          .fn()
          .mockResolvedValueOnce({
            content: "first",
            usage: { inputTokens: 11, outputTokens: 13, totalTokens: 24 },
            fee: { amount: 0.24, currency: "USD" }
          })
          .mockResolvedValueOnce({
            content: "second",
            usage: { inputTokens: 17, outputTokens: 19, totalTokens: 36 },
            fee: { amount: 0.36, currency: "USD" }
          })
      },
      tools: {
        execute: vi.fn()
      }
    });
    const events: JobRuntimeEvent[] = [];
    runtime.events.subscribe((event) => {
      events.push(event);
    });

    const result = await runtime.startJob(twoWindowJob());

    expect(result).toMatchObject({
      ok: true,
      state: {
        usage: { inputTokens: 28, outputTokens: 32, totalTokens: 60 },
        fee: { amount: 0.6, currency: "USD" }
      }
    });
    expect(events.at(-1)).toMatchObject({
      type: "job.completed",
      payload: {
        usage: { inputTokens: 28, outputTokens: 32, totalTokens: 60 },
        fee: { amount: 0.6, currency: "USD" }
      }
    });
  });

  it("marks the job failed when tool execution or fee aggregation fails", async () => {
    const toolFailureRuntime = createJobRuntime({
      maxConcurrentJobs: 1,
      llm: {
        completeWindow: vi.fn().mockResolvedValue({
          content: "tool please",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          fee: { amount: 0.02, currency: "USD" },
          toolCalls: [{ name: "write_file", arguments: { path: "out.md" } }]
        })
      },
      tools: {
        execute: vi.fn().mockRejectedValue(new Error("tool failure"))
      }
    });

    await expect(toolFailureRuntime.startJob(twoWindowJob({ windows: [{ id: "window-1", chapterIds: ["chapter-1"] }] }))).resolves.toEqual({
      ok: false,
      error: { code: "job_failed", message: "tool failure" }
    });

    const mixedCurrencyRuntime = createJobRuntime({
      maxConcurrentJobs: 1,
      llm: {
        completeWindow: vi
          .fn()
          .mockResolvedValueOnce({
            content: "first",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            fee: { amount: 0.02, currency: "USD" }
          })
          .mockResolvedValueOnce({
            content: "second",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            fee: { amount: 0.02, currency: "EUR" }
          })
      },
      tools: {
        execute: vi.fn()
      }
    });

    await expect(mixedCurrencyRuntime.startJob(twoWindowJob())).resolves.toEqual({
      ok: false,
      error: { code: "job_failed", message: "Mixed fee currencies are not supported: USD, EUR" }
    });
  });
});
