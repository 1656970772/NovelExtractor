import type { TokenUsage } from "@novel-extractor/jobs";
import { describe, expect, it, vi } from "vitest";
import { runTemplateBatchPipelines, TemplateBatchPipelineAbortError } from "./templateBatchPipelineCoordinator";

function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

const emptyUsage: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0
};

const batches = [
  { batchId: "batch-0001", batchIndex: 0 },
  { batchId: "batch-0002", batchIndex: 1 }
] as const;

const windows = [{ windowId: "window-1" }, { windowId: "window-2" }] as const;

function processResult(completed: number, skipped: number, executed: number) {
  return {
    completedTemplateTargetCount: completed,
    skippedTemplateTargetCount: skipped,
    executedTemplateTargetCount: executed,
    usage: {
      ...emptyUsage,
      inputTokens: completed,
      outputTokens: skipped,
      totalTokens: completed + skipped
    }
  };
}

describe("template batch pipeline coordinator", () => {
  it("starts all batches together and lets an unblocked batch enter its next window first", async () => {
    const secondBatchWindowOne = createDeferred<void>();
    const startedWindows: string[] = [];
    const progressRecords: Array<{
      batchId: string;
      windowId: string;
      completed: number;
      skipped: number;
      executed: number;
      totalTokens: number;
    }> = [];
    const resultByAttempt = new Map([
      ["batch-0001:0", processResult(11, 12, 13)],
      ["batch-0001:1", processResult(21, 22, 23)],
      ["batch-0002:0", processResult(31, 32, 33)],
      ["batch-0002:1", processResult(41, 42, 43)]
    ]);

    const runPromise = runTemplateBatchPipelines({
      batches,
      windows,
      retryIntervalMs: 60000,
      sleep: vi.fn(async () => "elapsed" as const),
      async processWindow({ batch, windowIndex }) {
        const key = `${batch.batchId}:${windowIndex}`;
        startedWindows.push(key);
        if (key === "batch-0002:0") {
          await secondBatchWindowOne.promise;
        }
        const result = resultByAttempt.get(key);
        if (!result) {
          throw new Error(`unexpected attempt ${key}`);
        }
        return result;
      },
      onProgress({ batch, window, completedTemplateTargetCount, skippedTemplateTargetCount, executedTemplateTargetCount, usage }) {
        progressRecords.push({
          batchId: batch.batchId,
          windowId: window.windowId,
          completed: completedTemplateTargetCount,
          skipped: skippedTemplateTargetCount,
          executed: executedTemplateTargetCount,
          totalTokens: usage.totalTokens
        });
      },
      onBatchFailure: vi.fn()
    });

    await vi.waitFor(() => expect(startedWindows).toEqual(["batch-0001:0", "batch-0002:0", "batch-0001:1"]));

    secondBatchWindowOne.resolve();
    await runPromise;

    expect(startedWindows).toEqual(["batch-0001:0", "batch-0002:0", "batch-0001:1", "batch-0002:1"]);
    expect(progressRecords).toEqual([
      { batchId: "batch-0001", windowId: "window-1", completed: 11, skipped: 12, executed: 13, totalTokens: 23 },
      { batchId: "batch-0001", windowId: "window-2", completed: 21, skipped: 22, executed: 23, totalTokens: 43 },
      { batchId: "batch-0002", windowId: "window-1", completed: 31, skipped: 32, executed: 33, totalTokens: 63 },
      { batchId: "batch-0002", windowId: "window-2", completed: 41, skipped: 42, executed: 43, totalTokens: 83 }
    ]);
  });

  it("retries an ordinary provider failure for the same batch window only", async () => {
    const attempts: string[] = [];
    const progressRecords: Array<{ windowId: string; completed: number; skipped: number; executed: number }> = [];
    const sleep = vi.fn(async () => "elapsed" as const);
    const onBatchFailure = vi.fn();

    await runTemplateBatchPipelines({
      batches: [batches[0]],
      windows,
      retryIntervalMs: 60000,
      sleep,
      async processWindow({ batch, windowIndex }) {
        attempts.push(`${batch.batchId}:${windowIndex}`);
        if (attempts.length === 1) {
          throw new Error("temporary provider failure");
        }
        return windowIndex === 0 ? processResult(51, 52, 53) : processResult(61, 62, 63);
      },
      onProgress({ window, completedTemplateTargetCount, skippedTemplateTargetCount, executedTemplateTargetCount }) {
        progressRecords.push({
          windowId: window.windowId,
          completed: completedTemplateTargetCount,
          skipped: skippedTemplateTargetCount,
          executed: executedTemplateTargetCount
        });
      },
      onBatchFailure
    });

    expect(attempts).toEqual(["batch-0001:0", "batch-0001:0", "batch-0001:1"]);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(60000);
    expect(onBatchFailure).toHaveBeenCalledWith({
      batch: batches[0],
      window: windows[0],
      windowIndex: 0,
      error: expect.objectContaining({ message: "temporary provider failure" }),
      nextRetryDelayMs: 60000
    });
    expect(progressRecords).toEqual([
      { windowId: "window-1", completed: 51, skipped: 52, executed: 53 },
      { windowId: "window-2", completed: 61, skipped: 62, executed: 63 }
    ]);
  });

  it("does not retry a successful window when progress persistence fails", async () => {
    const progressError = new Error("progress save failed");
    const processWindow = vi.fn(async () => processResult(51, 52, 53));
    const onBatchFailure = vi.fn();
    const sleep = vi.fn(async () => "elapsed" as const);

    const runPromise = runTemplateBatchPipelines({
      batches: [batches[0]],
      windows: [windows[0]],
      retryIntervalMs: 60000,
      sleep,
      processWindow,
      onProgress() {
        throw progressError;
      },
      onBatchFailure
    });

    await expect(runPromise).rejects.toBe(progressError);
    expect(processWindow).toHaveBeenCalledTimes(1);
    expect(onBatchFailure).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops other batches at the next window boundary when progress persistence fails", async () => {
    const progressError = new Error("progress save failed");
    const secondBatchWindowOne = createDeferred<void>();
    const startedWindows: string[] = [];
    const onBatchFailure = vi.fn();

    const runPromise = runTemplateBatchPipelines({
      batches,
      windows,
      retryIntervalMs: 60000,
      sleep: vi.fn(async () => "elapsed" as const),
      async processWindow({ batch, windowIndex }) {
        const key = `${batch.batchId}:${windowIndex}`;
        startedWindows.push(key);
        if (key === "batch-0002:0") {
          await secondBatchWindowOne.promise;
        }
        return processResult(51, 52, 53);
      },
      onProgress({ batch, windowIndex }) {
        if (batch.batchId === "batch-0001" && windowIndex === 0) {
          throw progressError;
        }
      },
      onBatchFailure
    });

    await vi.waitFor(() => expect(startedWindows).toEqual(["batch-0001:0", "batch-0002:0"]));
    await Promise.resolve();

    expect(startedWindows).toEqual(["batch-0001:0", "batch-0002:0"]);

    secondBatchWindowOne.resolve();
    await expect(runPromise).rejects.toBe(progressError);

    expect(startedWindows).toEqual(["batch-0001:0", "batch-0002:0"]);
    expect(onBatchFailure).not.toHaveBeenCalled();
  });

  it("prefers a concurrent fatal progress persistence error over an earlier abort when settling", async () => {
    const secondBatchStarted = createDeferred<void>();
    const finishSecondBatchWindowOne = createDeferred<void>();
    const progressError = new Error("progress save failed");

    const runPromise = runTemplateBatchPipelines({
      batches,
      windows: [windows[0]],
      retryIntervalMs: 60000,
      sleep: vi.fn(async () => "elapsed" as const),
      async processWindow({ batch }) {
        if (batch.batchId === "batch-0001") {
          await secondBatchStarted.promise;
          throw new TemplateBatchPipelineAbortError("cancel requested", "cancelled");
        }
        secondBatchStarted.resolve();
        await finishSecondBatchWindowOne.promise;
        return processResult(51, 52, 53);
      },
      onProgress({ batch }) {
        if (batch.batchId === "batch-0002") {
          throw progressError;
        }
      },
      onBatchFailure: vi.fn()
    });

    await secondBatchStarted.promise;
    finishSecondBatchWindowOne.resolve();

    await expect(runPromise).rejects.toBe(progressError);
  });

  it("wakes retry sleep on fatal progress persistence failure and stops the sleeper before retrying", async () => {
    const sleepEntered = createDeferred<void>();
    const releaseSleep = createDeferred<"woken" | "elapsed">();
    const releaseProgress = createDeferred<void>();
    const progressFailed = createDeferred<void>();
    const progressError = new Error("progress save failed");
    const attempts: string[] = [];
    const sleep = vi.fn(() => {
      sleepEntered.resolve();
      return releaseSleep.promise;
    });
    const onFatalStop = vi.fn((error: unknown) => {
      releaseSleep.resolve("woken");
      expect(error).toBe(progressError);
    });

    const runPromise = runTemplateBatchPipelines({
      batches,
      windows,
      retryIntervalMs: 60000,
      sleep,
      onFatalStop,
      async processWindow({ batch, windowIndex }) {
        attempts.push(`${batch.batchId}:${windowIndex}`);
        if (batch.batchId === "batch-0001") {
          throw new Error("temporary provider failure");
        }
        if (windowIndex === 0) {
          await releaseProgress.promise;
          return processResult(61, 62, 63);
        }
        throw new Error(`unexpected next window ${batch.batchId}:${windowIndex}`);
      },
      onProgress({ batch }) {
        if (batch.batchId === "batch-0002") {
          progressFailed.resolve();
          throw progressError;
        }
      },
      onBatchFailure: vi.fn()
    });

    let assertionError: unknown;
    try {
      await sleepEntered.promise;
      releaseProgress.resolve();
      await progressFailed.promise;
      await vi.waitFor(() => expect(onFatalStop).toHaveBeenCalledTimes(1), { timeout: 100 });

      await expect(runPromise).rejects.toBe(progressError);
      expect(attempts).toEqual(["batch-0001:0", "batch-0002:0"]);
      expect(sleep).toHaveBeenCalledTimes(1);
    } catch (error) {
      assertionError = error;
    } finally {
      releaseSleep.resolve("elapsed");
      await runPromise.catch(() => undefined);
    }

    if (assertionError) {
      throw assertionError;
    }
  });

  it("waits at the pause gate when retry sleep is woken before retrying the same window", async () => {
    const sleepWake = createDeferred<"woken">();
    const resume = createDeferred<void>();
    const attempts: string[] = [];
    let permissionChecks = 0;
    const waitForRunPermission = vi.fn(() => {
      permissionChecks += 1;
      return permissionChecks === 1 ? Promise.resolve() : resume.promise;
    });

    const runPromise = runTemplateBatchPipelines({
      batches: [batches[0]],
      windows,
      retryIntervalMs: 60000,
      sleep: vi.fn(() => sleepWake.promise),
      waitForRunPermission,
      async processWindow({ batch, windowIndex }) {
        attempts.push(`${batch.batchId}:${windowIndex}`);
        if (attempts.length === 1) {
          throw new Error("temporary provider failure");
        }
        return windowIndex === 0 ? processResult(71, 72, 73) : processResult(81, 82, 83);
      },
      onProgress: vi.fn(),
      onBatchFailure: vi.fn()
    });

    await vi.waitFor(() => expect(attempts).toEqual(["batch-0001:0"]));

    sleepWake.resolve("woken");
    await vi.waitFor(() => expect(waitForRunPermission).toHaveBeenCalledTimes(2));
    await Promise.resolve();

    expect(attempts).toEqual(["batch-0001:0"]);

    resume.resolve();
    await runPromise;

    expect(attempts).toEqual(["batch-0001:0", "batch-0001:0", "batch-0001:1"]);
  });

  it("does not retry task-level abort errors or report them as batch failures", async () => {
    const sleep = vi.fn(async () => "elapsed" as const);
    const onBatchFailure = vi.fn();

    const runPromise = runTemplateBatchPipelines({
      batches: [batches[0]],
      windows,
      retryIntervalMs: 60000,
      sleep,
      async processWindow() {
        throw new TemplateBatchPipelineAbortError("cancel requested", "cancelled");
      },
      onProgress: vi.fn(),
      onBatchFailure
    });

    await expect(runPromise).rejects.toMatchObject({ code: "cancelled" });
    expect(onBatchFailure).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each(["fatal_config", "cancelled", "deleted"] as const)(
    "propagates %s abort across parallel batches and drains in-flight windows before settling",
    async (code) => {
      const secondBatchStarted = createDeferred<void>();
      const finishSecondBatchWindowOne = createDeferred<void>();
      const startedWindows: string[] = [];
      const drainMarkers: string[] = [];

      const runPromise = runTemplateBatchPipelines({
        batches,
        windows,
        retryIntervalMs: 60000,
        sleep: vi.fn(async () => "elapsed" as const),
        async processWindow({ batch, windowIndex }) {
          startedWindows.push(`${batch.batchId}:${windowIndex}`);
          if (batch.batchId === "batch-0001" && windowIndex === 0) {
            await secondBatchStarted.promise;
            throw new TemplateBatchPipelineAbortError("stop", code);
          }
          if (batch.batchId === "batch-0002" && windowIndex === 0) {
            secondBatchStarted.resolve();
            await finishSecondBatchWindowOne.promise;
            return processResult(91, 92, 93);
          }
          throw new Error(`unexpected window ${batch.batchId}:${windowIndex}`);
        },
        onProgress({ batch, windowIndex }) {
          if (batch.batchId === "batch-0002" && windowIndex === 0) {
            drainMarkers.push("batch-0002:abort-boundary");
          }
        },
        onBatchFailure: vi.fn()
      });
      let settled = false;
      runPromise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );

      await vi.waitFor(() => expect(startedWindows).toEqual(["batch-0001:0", "batch-0002:0"]));
      await Promise.resolve();

      expect(settled).toBe(false);

      finishSecondBatchWindowOne.resolve();
      await expect(runPromise).rejects.toMatchObject({ code });
      await Promise.resolve();

      expect(startedWindows).toEqual(["batch-0001:0", "batch-0002:0"]);
      expect(drainMarkers).toContain("batch-0002:abort-boundary");
    }
  );
});
