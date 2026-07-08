import { describe, expect, it } from "vitest";
import {
  toTemplateBatchCoverageRelativePath,
  toTemplateBatchLogSegments,
  toTemplateBatchTaskInfo
} from "./templateBatchArtifacts";

describe("template batch artifacts", () => {
  it("builds job and batch scoped coverage and log paths", () => {
    expect(toTemplateBatchCoverageRelativePath("job-7", "batch-0003")).toBe(
      "metadata/coverage/jobs/job-7/batch-0003/coverage-index.json"
    );
    expect(toTemplateBatchLogSegments("job-7", "batch-0003")).toEqual([
      "runs",
      "job-7",
      "logs",
      "batches",
      "batch-0003"
    ]);
    expect(toTemplateBatchTaskInfo("job-7", "batch-0003")).toBe("任务 job-7，批次 batch-0003");
  });
});
