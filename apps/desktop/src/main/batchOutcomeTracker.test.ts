import { describe, expect, it } from "vitest";
import { createBatchOutcomeTracker } from "./batchOutcomeTracker";

const targets = [
  { templateId: "template-a", templateName: "甲模板", outputFileName: "甲报告.md" },
  { templateId: "template-b", templateName: "乙模板", outputFileName: "乙报告.md" },
  { templateId: "template-c", templateName: "丙模板", outputFileName: "丙报告.md" },
  { templateId: "template-d", templateName: "丁模板", outputFileName: "丁报告.md" }
] as const;

describe("batch outcome tracker", () => {
  it("reports missing outcomes when only one selected output was written", () => {
    const tracker = createBatchOutcomeTracker(targets);

    tracker.recordWritten("甲报告.md");

    expect(tracker.isComplete()).toBe(false);
    expect(tracker.missingOutputFileNames()).toEqual(["乙报告.md", "丙报告.md", "丁报告.md"]);
    expect(tracker.outcomes()).toEqual([
      { outputFileName: "甲报告.md", status: "written" }
    ]);
  });

  it("marks all missing outputs as no_update only for explicit whole-batch NO_UPDATE", () => {
    const tracker = createBatchOutcomeTracker(targets);

    tracker.recordBatchNoUpdate("NO_UPDATE");

    expect(tracker.isComplete()).toBe(true);
    expect(tracker.missingOutputFileNames()).toEqual([]);
    expect(tracker.outcomes()).toHaveLength(4);
    expect(tracker.outcomes()).toEqual(
      expect.arrayContaining([
        { outputFileName: "甲报告.md", status: "no_update", reason: "NO_UPDATE" },
        { outputFileName: "乙报告.md", status: "no_update", reason: "NO_UPDATE" }
      ])
    );
  });

  it("rejects duplicate output file names before output-keyed tracking can fold them", () => {
    expect(() =>
      createBatchOutcomeTracker([
        { templateId: "template-a", templateName: "甲模板", outputFileName: "同名.md" },
        { templateId: "template-b", templateName: "乙模板", outputFileName: "同名.md" }
      ])
    ).toThrow(/Duplicate outputFileName/u);
  });

  it("rejects outcomes for files outside the selected template batch", () => {
    const tracker = createBatchOutcomeTracker(targets);

    expect(() => tracker.recordNoUpdate("未选中.md", "无更新")).toThrow(/not selected/u);
  });
});
