import { describe, expect, it, vi } from "vitest";
import { createJobRuntime, type JobRunInput } from "./jobRuntime";
import { createJobCommandService, type JobCommandRepository } from "./commands";

function createMemoryCommandRepository(): JobCommandRepository {
  const jobs = new Map<string, Awaited<ReturnType<JobCommandRepository["createJob"]>>>();

  return {
    async createJob(input) {
      const job = {
        ...input,
        id: "job-1",
        createdAt: "2026-06-27T00:00:00.000Z",
        updatedAt: "2026-06-27T00:00:00.000Z"
      };
      jobs.set(job.id, job);
      return job;
    },
    async findJobById(jobId) {
      return jobs.get(jobId) ?? null;
    },
    async updateJob(job) {
      jobs.set(job.id, job);
      return job;
    }
  };
}

function runInput(overrides: Partial<JobRunInput> = {}): JobRunInput {
  return {
    jobId: "job-1",
    bookId: "book-1",
    modelId: "model-fixture",
    templateIds: ["template-fixture"],
    windows: [{ id: "window-1", chapterIds: ["chapter-1"] }],
    ...overrides
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });

  return { promise, resolve };
}

function timeout<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe("job command service", () => {
  it("creates, starts, pauses, resumes, and deletes through typed command results", async () => {
    const repository = createMemoryCommandRepository();
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
            content: "after resume",
            usage: { inputTokens: 7, outputTokens: 11, totalTokens: 18 },
            fee: { amount: 0.18, currency: "USD" }
          })
      },
      tools: {
        execute: vi.fn()
      }
    });
    const service = createJobCommandService({
      repository,
      runtime,
      clock: { now: () => "2026-06-27T00:00:00.000Z" }
    });

    const created = await service.create({
      bookId: "book-1",
      templateIds: ["template-fixture"],
      providerConfigId: "provider-1",
      modelId: "model-fixture"
    });
    expect(created).toMatchObject({ ok: true, job: { status: "created" } });

    const startPromise = service.start("job-1", runInput({ windows: [{ id: "window-1", chapterIds: ["chapter-1"] }, { id: "window-2", chapterIds: ["chapter-2"] }] }));
    await expect(Promise.race([startPromise, timeout(25, "timeout")])).resolves.toMatchObject({
      ok: true,
      job: { status: "running" }
    });
    await vi.waitFor(async () => expect((await repository.findJobById("job-1"))?.status).toBe("running"));

    await expect(service.pause("job-1")).resolves.toEqual({ ok: true });
    firstWindow.resolve({
      content: "done",
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      fee: { amount: 0.05, currency: "USD" }
    });
    await vi.waitFor(async () => expect((await repository.findJobById("job-1"))?.status).toBe("paused"));

    await expect(service.resume("job-1")).resolves.toEqual({ ok: true });
    await expect(startPromise).resolves.toMatchObject({ ok: true, job: { status: "running" } });
    await vi.waitFor(async () => expect((await repository.findJobById("job-1"))?.status).toBe("completed"));

    await expect(service.delete("job-1")).resolves.toMatchObject({ ok: true, job: { status: "deleted" } });
  });

  it("returns typed command errors for invalid state transitions", async () => {
    const repository = createMemoryCommandRepository();
    const runtime = createJobRuntime({
      maxConcurrentJobs: 1,
      llm: {
        completeWindow: vi.fn()
      },
      tools: {
        execute: vi.fn()
      }
    });
    const service = createJobCommandService({
      repository,
      runtime,
      clock: { now: () => "2026-06-27T00:00:00.000Z" }
    });

    await service.create({
      bookId: "book-1",
      templateIds: ["template-fixture"],
      providerConfigId: "provider-1",
      modelId: "model-fixture"
    });

    await expect(service.resume("job-1")).resolves.toEqual({
      ok: false,
      error: { code: "invalid_job_state", currentStatus: "created", action: "resume" }
    });
  });
});
