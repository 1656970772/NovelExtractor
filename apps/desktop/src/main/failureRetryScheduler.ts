export interface FailureRetryScheduler {
  onJobFailed(input: { jobId: string; autoRetryOnFailure: boolean }): void;
  cancel(jobId: string): void;
  hasScheduledRetry(jobId: string): boolean;
}

export interface FailureRetrySchedulerOptions {
  intervalMs: number;
  enqueue(jobId: string): Promise<"accepted" | "failed">;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

export function createFailureRetryScheduler(
  options: FailureRetrySchedulerOptions
): FailureRetryScheduler {
  const setTimer = options.setTimeout ?? globalThis.setTimeout;
  const clearTimer = options.clearTimeout ?? globalThis.clearTimeout;
  const timers = new Map<string, TimerHandle>();
  const enabledJobs = new Set<string>();

  function cancel(jobId: string): void {
    enabledJobs.delete(jobId);
    const timer = timers.get(jobId);
    if (timer !== undefined) {
      clearTimer(timer);
      timers.delete(jobId);
    }
  }

  function schedule(jobId: string): void {
    if (timers.has(jobId)) {
      return;
    }

    const timer = setTimer(() => {
      timers.delete(jobId);
      void retry(jobId);
    }, options.intervalMs);
    timers.set(jobId, timer);
  }

  async function retry(jobId: string): Promise<void> {
    if (!enabledJobs.has(jobId)) {
      return;
    }

    try {
      const result = await options.enqueue(jobId);
      if (result === "accepted") {
        enabledJobs.delete(jobId);
        return;
      }
    } catch {
      // Keep the retry loop alive; the next attempt will re-check current job state.
    }

    if (enabledJobs.has(jobId)) {
      schedule(jobId);
    }
  }

  return {
    onJobFailed({ jobId, autoRetryOnFailure }) {
      if (!autoRetryOnFailure) {
        cancel(jobId);
        return;
      }

      enabledJobs.add(jobId);
      schedule(jobId);
    },
    cancel,
    hasScheduledRetry(jobId) {
      return timers.has(jobId);
    }
  };
}
