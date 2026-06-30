import { describe, expect, it } from "vitest";
import { planTemplateBatches } from "./templateBatchPlanner";

const templates = [
  { id: "template-a", name: "甲模板", fileName: "甲报告.md", promptChars: 20 },
  { id: "template-b", name: "乙模板", fileName: "乙报告.md", promptChars: 25 },
  { id: "template-c", name: "丙模板", fileName: "丙报告.md", promptChars: 30 },
  { id: "template-d", name: "丁模板", fileName: "丁报告.md", promptChars: 35 }
] as const;

describe("template batch planner", () => {
  it("keeps one-template batches when configured max templates per call is one", () => {
    const batches = planTemplateBatches({
      templates,
      maxTemplatesPerCall: 1
    });

    expect(batches.map((batch) => batch.templates.map((template) => template.fileName))).toEqual([
      ["甲报告.md"],
      ["乙报告.md"],
      ["丙报告.md"],
      ["丁报告.md"]
    ]);
  });

  it("combines templates up to the configured max templates per call", () => {
    const batches = planTemplateBatches({
      templates,
      maxTemplatesPerCall: 4
    });

    expect(batches).toHaveLength(1);
    expect(batches[0].templates.map((template) => template.fileName)).toEqual([
      "甲报告.md",
      "乙报告.md",
      "丙报告.md",
      "丁报告.md"
    ]);
    expect(batches[0].splitReason).toBe("complete");
  });

  it("splits before the prompt budget is exceeded and records the budget reason", () => {
    const batches = planTemplateBatches({
      templates,
      maxTemplatesPerCall: 4,
      promptBudgetChars: 60
    });

    expect(batches.map((batch) => batch.templates.map((template) => template.fileName))).toEqual([
      ["甲报告.md", "乙报告.md"],
      ["丙报告.md"],
      ["丁报告.md"]
    ]);
    expect(batches.map((batch) => batch.splitReason)).toEqual(["budget", "budget", "complete"]);
  });
});
