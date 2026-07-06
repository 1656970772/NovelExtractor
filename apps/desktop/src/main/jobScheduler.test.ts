import { describe, expect, it, vi } from "vitest";
import { createJobScheduler, type ScheduledJob } from "./jobScheduler";

function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function job(id: string, bookId: string): ScheduledJob {
  return { id, bookId, createdAt: `2026-07-05T00:00:0${id.at(-1) ?? "0"}.000Z` };
}

describe("desktop job scheduler", () => {
  it("runs at most two different-book jobs concurrently and queues the third", async () => {
    const first = createDeferred();
    const second = createDeferred();
    const third = createDeferred();
    const run = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const queued = vi.fn();
    const scheduler = createJobScheduler({
      maxConcurrentJobs: 2,
      maxConcurrentJobsPerBook: 1,
      run,
      onQueued: queued
    });

    await scheduler.enqueue(job("job-1", "book-1"));
    await scheduler.enqueue(job("job-2", "book-2"));
    await scheduler.enqueue(job("job-3", "book-3"));

    expect(run).toHaveBeenCalledTimes(2);
    expect(queued).toHaveBeenCalledWith(job("job-3", "book-3"), "global_limit");

    first.resolve();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    second.resolve();
    third.resolve();
  });

  it("keeps same-book jobs queued while allowing another book to use the free slot", async () => {
    const first = createDeferred();
    const second = createDeferred();
    const third = createDeferred();
    const started: string[] = [];
    const run = vi.fn(async (scheduledJob: ScheduledJob) => {
      started.push(scheduledJob.id);
      if (scheduledJob.id === "job-1") {
        await first.promise;
      } else if (scheduledJob.id === "job-2") {
        await second.promise;
      } else {
        await third.promise;
      }
    });
    const queued = vi.fn();
    const scheduler = createJobScheduler({
      maxConcurrentJobs: 2,
      maxConcurrentJobsPerBook: 1,
      run,
      onQueued: queued
    });

    await scheduler.enqueue(job("job-1", "book-1"));
    await scheduler.enqueue(job("job-2", "book-1"));
    await scheduler.enqueue(job("job-3", "book-2"));

    expect(started).toEqual(["job-1", "job-3"]);
    expect(queued).toHaveBeenCalledWith(job("job-2", "book-1"), "book_limit");

    first.resolve();
    await vi.waitFor(() => expect(started).toEqual(["job-1", "job-3", "job-2"]));
    second.resolve();
    third.resolve();
  });

  it("deduplicates repeated enqueue calls for the same job", async () => {
    const hold = createDeferred();
    const run = vi.fn(() => hold.promise);
    const scheduler = createJobScheduler({
      maxConcurrentJobs: 2,
      maxConcurrentJobsPerBook: 1,
      run
    });

    await scheduler.enqueue(job("job-1", "book-1"));
    await scheduler.enqueue(job("job-1", "book-1"));

    expect(run).toHaveBeenCalledTimes(1);
    hold.resolve();
  });

  it("waits for the initial started hook when the same running job is enqueued again", async () => {
    const runHold = createDeferred();
    const startedEntered = createDeferred();
    const startedHold = createDeferred();
    const run = vi.fn(() => runHold.promise);
    const scheduler = createJobScheduler({
      maxConcurrentJobs: 2,
      maxConcurrentJobsPerBook: 1,
      run,
      async onStarted() {
        startedEntered.resolve();
        await startedHold.promise;
      }
    });

    const firstEnqueue = scheduler.enqueue(job("job-1", "book-1"));
    await startedEntered.promise;

    let secondResolved = false;
    const secondEnqueue = scheduler.enqueue(job("job-1", "book-1")).then((result) => {
      secondResolved = true;
      return result;
    });
    await Promise.resolve();

    expect(secondResolved).toBe(false);

    startedHold.resolve();
    await expect(firstEnqueue).resolves.toEqual({ state: "running" });
    await expect(secondEnqueue).resolves.toEqual({ state: "running" });
    expect(run).toHaveBeenCalledTimes(1);
    runHold.resolve();
  });

  it("removes a queued job before it starts", async () => {
    const first = createDeferred();
    const run = vi.fn(async (scheduledJob: ScheduledJob) => {
      if (scheduledJob.id === "job-1") {
        await first.promise;
      }
    });
    const scheduler = createJobScheduler({
      maxConcurrentJobs: 1,
      maxConcurrentJobsPerBook: 1,
      run
    });

    await scheduler.enqueue(job("job-1", "book-1"));
    await scheduler.enqueue(job("job-2", "book-2"));
    expect(scheduler.remove("job-2")).toBe(true);
    first.resolve();
    await Promise.resolve();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("removes a queued entry when the queued hook fails", async () => {
    const first = createDeferred();
    const events: string[] = [];
    const scheduler = createJobScheduler({
      maxConcurrentJobs: 1,
      maxConcurrentJobsPerBook: 1,
      async run(scheduledJob) {
        events.push(`run:${scheduledJob.id}`);
        if (scheduledJob.id === "job-1") {
          await first.promise;
        }
      },
      async onQueued(scheduledJob, reason) {
        events.push(`queued:${scheduledJob.id}:${reason}`);
        throw new Error("persist queued failed");
      },
      async onStarted(scheduledJob) {
        events.push(`started:${scheduledJob.id}`);
      }
    });

    await expect(scheduler.enqueue(job("job-1", "book-1"))).resolves.toEqual({ state: "running" });
    await expect(scheduler.enqueue(job("job-2", "book-2"))).rejects.toThrow("persist queued failed");
    const queuedAfterError = scheduler.getQueuedJobIds();

    first.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect({
      events,
      queuedAfterDrain: scheduler.getQueuedJobIds(),
      queuedAfterError
    }).toEqual({
      events: ["started:job-1", "run:job-1", "queued:job-2:global_limit"],
      queuedAfterDrain: [],
      queuedAfterError: []
    });
  });

  it("does not start a queued entry before the queued hook completes", async () => {
    const first = createDeferred();
    const queuedHookEntered = createDeferred();
    const finishQueuedHook = createDeferred();
    const events: string[] = [];
    const scheduler = createJobScheduler({
      maxConcurrentJobs: 1,
      maxConcurrentJobsPerBook: 1,
      async run(scheduledJob) {
        events.push(`run:${scheduledJob.id}`);
        if (scheduledJob.id === "job-1") {
          await first.promise;
        }
      },
      async onQueued(scheduledJob, reason) {
        events.push(`queued:${scheduledJob.id}:${reason}`);
        queuedHookEntered.resolve();
        await finishQueuedHook.promise;
        throw new Error("persist queued failed");
      },
      async onStarted(scheduledJob) {
        events.push(`started:${scheduledJob.id}`);
      }
    });

    await expect(scheduler.enqueue(job("job-1", "book-1"))).resolves.toEqual({ state: "running" });
    const queuedEnqueue = scheduler.enqueue(job("job-2", "book-2"));
    await queuedHookEntered.promise;

    first.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(events).toEqual(["started:job-1", "run:job-1", "queued:job-2:global_limit"]);

    finishQueuedHook.resolve();
    await expect(queuedEnqueue).rejects.toThrow("persist queued failed");
    expect(scheduler.getQueuedJobIds()).toEqual([]);
  });

  it("rejects a queued enqueue that was removed while the queued hook was pending", async () => {
    const first = createDeferred();
    const queuedHookEntered = createDeferred();
    const finishQueuedHook = createDeferred();
    const events: string[] = [];
    const scheduler = createJobScheduler({
      maxConcurrentJobs: 1,
      maxConcurrentJobsPerBook: 1,
      async run(scheduledJob) {
        events.push(`run:${scheduledJob.id}`);
        if (scheduledJob.id === "job-1") {
          await first.promise;
        }
      },
      async onQueued(scheduledJob, reason) {
        events.push(`queued:${scheduledJob.id}:${reason}`);
        queuedHookEntered.resolve();
        await finishQueuedHook.promise;
      },
      async onStarted(scheduledJob) {
        events.push(`started:${scheduledJob.id}`);
      }
    });

    await expect(scheduler.enqueue(job("job-1", "book-1"))).resolves.toEqual({ state: "running" });
    const queuedEnqueue = scheduler.enqueue(job("job-2", "book-2"));
    await queuedHookEntered.promise;

    expect(scheduler.getQueuedJobIds()).toEqual(["job-2"]);
    expect(scheduler.remove("job-2")).toBe(true);
    expect(scheduler.getQueuedJobIds()).toEqual([]);

    finishQueuedHook.resolve();
    await expect(queuedEnqueue).rejects.toThrow(/removed while queued/u);

    first.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(events).toEqual(["started:job-1", "run:job-1", "queued:job-2:global_limit"]);
    expect(scheduler.getQueuedJobIds()).toEqual([]);
  });
});
