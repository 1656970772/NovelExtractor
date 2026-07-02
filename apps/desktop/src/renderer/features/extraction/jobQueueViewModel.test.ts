import { describe, expect, it } from "vitest";

import type { ExtractionJob } from "./extractionViewModel";
import {
  filterJobs,
  formatDuration,
  getFilterCount,
  getRemainingTimeLabel,
  JOB_QUEUE_FILTERS
} from "./jobQueueViewModel";

const jobs: ExtractionJob[] = [
  { id: "running-1", status: "running", progressText: "运行中" },
  { id: "paused-1", status: "paused", progressText: "暂停中" },
  { id: "failed-1", status: "failed", progressText: "失败" },
  { id: "completed-1", status: "completed", progressText: "完成" },
  { id: "pending-1", status: "pending", progressText: "等待中" }
];

describe("jobQueueViewModel", () => {
  it("keeps the configured filter order and counts exact statuses", () => {
    expect(JOB_QUEUE_FILTERS.map((filter) => `${filter.label}:${getFilterCount(jobs, filter.key)}`)).toEqual([
      "全部:5",
      "进行中:1",
      "暂停:1",
      "失败:1",
      "已完成:1"
    ]);
  });

  it("filters pending jobs only into the all queue", () => {
    const allJobs = filterJobs(jobs, "all");

    expect(allJobs).toEqual(jobs);
    expect(allJobs).not.toBe(jobs);
    expect(filterJobs(jobs, "running").map((job) => job.id)).toEqual(["running-1"]);
    expect(filterJobs(jobs, "paused").map((job) => job.id)).toEqual(["paused-1"]);
    expect(filterJobs(jobs, "failed").map((job) => job.id)).toEqual(["failed-1"]);
    expect(filterJobs(jobs, "completed").map((job) => job.id)).toEqual(["completed-1"]);
  });

  it("formats missing, negative, minute, and hour durations", () => {
    expect(formatDuration()).toBe("--");
    expect(formatDuration(Number.NaN)).toBe("--");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("--");
    expect(formatDuration(-1500)).toBe("00:00");
    expect(formatDuration(59_999)).toBe("00:59");
    expect(formatDuration(60_000)).toBe("01:00");
    expect(formatDuration(3_723_000)).toBe("01:02:03");
  });

  it("labels frozen paused remaining time", () => {
    expect(
      getRemainingTimeLabel({
        id: "paused-frozen",
        status: "paused",
        timing: { estimateState: "frozen", estimatedRemainingMs: 420_000 }
      })
    ).toBe("已暂停 07:00");
  });

  it("labels calculating remaining time", () => {
    expect(
      getRemainingTimeLabel({
        id: "running-calculating",
        status: "running",
        timing: { estimateState: "calculating" }
      })
    ).toBe("计算中");
  });

  it("falls back when remaining time is unavailable", () => {
    expect(getRemainingTimeLabel({ id: "without-timing", status: "running" })).toBe("--");
    expect(
      getRemainingTimeLabel({
        id: "unknown",
        status: "running",
        timing: { estimateState: "unknown" }
      })
    ).toBe("--");
    expect(
      getRemainingTimeLabel({
        id: "failed-stale",
        status: "failed",
        timing: { estimateState: "unknown", estimatedRemainingMs: 420_000 }
      })
    ).toBe("--");
  });
});
