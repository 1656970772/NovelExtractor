export type QueueBlockReason = "global_limit" | "book_limit";

export interface ScheduledJob {
  id: string;
  bookId: string;
  createdAt: string;
}

export interface EnqueueResult {
  state: "running" | "queued";
  reason?: QueueBlockReason;
}

export interface JobSchedulerOptions<TJob extends ScheduledJob> {
  maxConcurrentJobs: number;
  maxConcurrentJobsPerBook: number;
  run(job: TJob): Promise<unknown>;
  onQueued?(job: TJob, reason: QueueBlockReason): Promise<void> | void;
  onStarted?(job: TJob): Promise<void> | void;
  onSettled?(job: TJob): Promise<void> | void;
}

interface QueueEntry<TJob extends ScheduledJob> {
  job: TJob;
  sequence: number;
  reason?: QueueBlockReason;
  queueHookPending?: boolean;
}

interface RunningEntry<TJob extends ScheduledJob> {
  job: TJob;
  promise: Promise<void>;
  started: Promise<void>;
}

export interface JobScheduler<TJob extends ScheduledJob> {
  enqueue(job: TJob): Promise<EnqueueResult>;
  remove(jobId: string): boolean;
  isRunning(jobId: string): boolean;
  isQueued(jobId: string): boolean;
  getRunningJobIds(): string[];
  getQueuedJobIds(): string[];
}

function assertSchedulerLimit(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

export function createJobScheduler<TJob extends ScheduledJob>(
  options: JobSchedulerOptions<TJob>
): JobScheduler<TJob> {
  assertSchedulerLimit(options.maxConcurrentJobs, "maxConcurrentJobs");
  assertSchedulerLimit(options.maxConcurrentJobsPerBook, "maxConcurrentJobsPerBook");

  const queued = new Map<string, QueueEntry<TJob>>();
  const running = new Map<string, RunningEntry<TJob>>();
  const runningCountByBookId = new Map<string, number>();
  let nextSequence = 0;
  let draining = false;

  function getRunningBookCount(bookId: string): number {
    return runningCountByBookId.get(bookId) ?? 0;
  }

  function getBlockReason(job: TJob): QueueBlockReason | undefined {
    if (getRunningBookCount(job.bookId) >= options.maxConcurrentJobsPerBook) {
      return "book_limit";
    }
    if (running.size >= options.maxConcurrentJobs) {
      return "global_limit";
    }
    return undefined;
  }

  function addRunning(entry: RunningEntry<TJob>): void {
    running.set(entry.job.id, entry);
    runningCountByBookId.set(entry.job.bookId, getRunningBookCount(entry.job.bookId) + 1);
  }

  function removeRunning(job: TJob): void {
    running.delete(job.id);
    const nextCount = Math.max(0, getRunningBookCount(job.bookId) - 1);
    if (nextCount === 0) {
      runningCountByBookId.delete(job.bookId);
    } else {
      runningCountByBookId.set(job.bookId, nextCount);
    }
  }

  function sortedQueuedEntries(): Array<QueueEntry<TJob>> {
    return [...queued.values()].sort((left, right) => left.sequence - right.sequence);
  }

  function startEntry(entry: QueueEntry<TJob>): RunningEntry<TJob> {
    queued.delete(entry.job.id);
    let resolveStarted!: () => void;
    let rejectStarted!: (error: unknown) => void;
    let didSettleStarted = false;
    const started = new Promise<void>((resolve, reject) => {
      resolveStarted = () => {
        didSettleStarted = true;
        resolve();
      };
      rejectStarted = (error) => {
        didSettleStarted = true;
        reject(error);
      };
    });
    const promise = (async () => {
      try {
        await options.onStarted?.(entry.job);
        resolveStarted();
        await options.run(entry.job);
      } catch (error) {
        if (!didSettleStarted) {
          rejectStarted(error);
        }
        throw error;
      } finally {
        removeRunning(entry.job);
        await options.onSettled?.(entry.job);
        void drain();
      }
    })();

    const runningEntry = { job: entry.job, promise, started };
    addRunning(runningEntry);
    void promise.catch(() => undefined);
    return runningEntry;
  }

  async function drain(): Promise<void> {
    if (draining) {
      return;
    }
    draining = true;
    try {
      let started = true;
      while (started && running.size < options.maxConcurrentJobs) {
        started = false;
        for (const entry of sortedQueuedEntries()) {
          if (entry.queueHookPending) {
            continue;
          }
          const reason = getBlockReason(entry.job);
          if (reason) {
            entry.reason = reason;
            continue;
          }
          startEntry(entry);
          started = true;
          break;
        }
      }
    } finally {
      draining = false;
    }
  }

  return {
    async enqueue(job) {
      const existingRunning = running.get(job.id);
      if (existingRunning) {
        await existingRunning.started;
        return { state: "running" };
      }

      const existingQueued = queued.get(job.id);
      if (existingQueued) {
        return { state: "queued", reason: existingQueued.reason ?? getBlockReason(job) ?? "global_limit" };
      }

      const entry: QueueEntry<TJob> = { job, sequence: nextSequence += 1 };
      queued.set(job.id, entry);
      await drain();

      if (running.has(job.id)) {
        await running.get(job.id)?.started;
        return { state: "running" };
      }

      entry.reason = getBlockReason(job) ?? "global_limit";
      entry.queueHookPending = true;
      try {
        await options.onQueued?.(job, entry.reason);
      } catch (error) {
        if (queued.get(job.id) === entry) {
          queued.delete(job.id);
        }
        throw error;
      }
      if (queued.get(job.id) !== entry) {
        throw new Error(`Job removed while queued: ${job.id}`);
      }
      entry.queueHookPending = false;
      await drain();

      if (running.has(job.id)) {
        await running.get(job.id)?.started;
        return { state: "running" };
      }

      return { state: "queued", reason: entry.reason };
    },
    remove(jobId) {
      return queued.delete(jobId);
    },
    isRunning(jobId) {
      return running.has(jobId);
    },
    isQueued(jobId) {
      return queued.has(jobId);
    },
    getRunningJobIds() {
      return [...running.keys()];
    },
    getQueuedJobIds() {
      return sortedQueuedEntries().map((entry) => entry.job.id);
    }
  };
}
