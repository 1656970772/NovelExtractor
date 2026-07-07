import { describe, expect, it } from "vitest";
import { canTransitionJob, makeJobEvent, toTaskStatus } from "./job";
import type { JobStatus } from "./job";
import type { TaskStatus } from "@novel-extractor/config";

describe("job domain", () => {
  it("enforces P0 job transitions", () => {
    expect(canTransitionJob("created", "running")).toBe(true);
    expect(canTransitionJob("running", "pause_requested")).toBe(true);
    expect(canTransitionJob("completed", "running")).toBe(false);
  });

  it("emits typed job events with stable caller-provided timestamps", () => {
    const payload = { jobId: "job-1", windowIndex: 0 };

    const event = makeJobEvent("job.window.completed", payload, {
      createdAt: "2026-06-27T00:00:00.000Z"
    });

    expect(event).toEqual({
      type: "job.window.completed",
      payload,
      createdAt: "2026-06-27T00:00:00.000Z"
    });
    expect(event.payload).toBe(payload);
  });

  it("emits typed job events with default timestamps", () => {
    const before = Date.now();

    const event = makeJobEvent("job.created", { jobId: "job-1" });

    const createdAt = Date.parse(event.createdAt);
    expect(Number.isNaN(createdAt)).toBe(false);
    expect(createdAt).toBeGreaterThanOrEqual(before);
    expect(createdAt).toBeLessThanOrEqual(Date.now());
  });

  it("maps job statuses to task statuses for UI task config boundaries", () => {
    const mappings: Array<[JobStatus, TaskStatus | null]> = [
      ["created", "pending"],
      ["running", "running"],
      ["pause_requested", "pause_requested"],
      ["paused", "paused"],
      ["completed", "completed"],
      ["failed", "failed"],
      ["deleted", null]
    ];

    for (const [jobStatus, taskStatus] of mappings) {
      expect(toTaskStatus(jobStatus)).toBe(taskStatus);
    }
  });
});
