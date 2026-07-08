import { afterEach, describe, expect, it, vi } from "vitest";
import { createFailureRetryScheduler } from "./failureRetryScheduler";

describe("createFailureRetryScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules one retry per failed job and cancels after a successful enqueue", async () => {
    vi.useFakeTimers();
    const enqueue = vi.fn().mockResolvedValue("accepted");
    const scheduler = createFailureRetryScheduler({
      enqueue,
      intervalMs: 300000
    });

    scheduler.onJobFailed({ jobId: "job-1", autoRetryOnFailure: true });
    scheduler.onJobFailed({ jobId: "job-1", autoRetryOnFailure: true });

    expect(scheduler.hasScheduledRetry("job-1")).toBe(true);
    await vi.advanceTimersByTimeAsync(300000);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith("job-1");
    expect(scheduler.hasScheduledRetry("job-1")).toBe(false);
  });

  it("keeps scheduling when enqueue fails or rejects", async () => {
    vi.useFakeTimers();
    const enqueue = vi
      .fn()
      .mockResolvedValueOnce("failed")
      .mockRejectedValueOnce(new Error("scheduler enqueue failed"))
      .mockResolvedValueOnce("accepted");
    const scheduler = createFailureRetryScheduler({
      enqueue,
      intervalMs: 300000
    });

    scheduler.onJobFailed({ jobId: "job-1", autoRetryOnFailure: true });

    await vi.advanceTimersByTimeAsync(300000);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(scheduler.hasScheduledRetry("job-1")).toBe(true);

    await vi.advanceTimersByTimeAsync(300000);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(scheduler.hasScheduledRetry("job-1")).toBe(true);

    await vi.advanceTimersByTimeAsync(300000);
    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(scheduler.hasScheduledRetry("job-1")).toBe(false);
  });

  it("does not reschedule when retry is cancelled while enqueue is pending", async () => {
    vi.useFakeTimers();
    let resolveEnqueue: (value: "failed") => void = () => undefined;
    const enqueue = vi.fn(
      () =>
        new Promise<"failed">((resolve) => {
          resolveEnqueue = resolve;
        })
    );
    const scheduler = createFailureRetryScheduler({
      enqueue,
      intervalMs: 300000
    });

    scheduler.onJobFailed({ jobId: "job-1", autoRetryOnFailure: true });
    await vi.advanceTimersByTimeAsync(300000);
    scheduler.cancel("job-1");
    resolveEnqueue("failed");
    await vi.runAllTimersAsync();

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(scheduler.hasScheduledRetry("job-1")).toBe(false);
  });
});
