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

  it("splits only by template count", () => {
    const batches = planTemplateBatches({
      templates,
      maxTemplatesPerCall: 2
    });

    expect(batches.map((batch) => batch.templates.map((template) => template.fileName))).toEqual([
      ["甲报告.md", "乙报告.md"],
      ["丙报告.md", "丁报告.md"]
    ]);
    expect(batches.map((batch) => batch.splitReason)).toEqual(["maxTemplatesPerCall", "complete"]);
  });

  it("balances template counts across the required number of batches", () => {
    const makeTemplates = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `template-${index + 1}`,
        name: `模板${index + 1}`,
        fileName: `报告${index + 1}.md`
      }));

    const getBatchSizes = (count: number) =>
      planTemplateBatches({
        templates: makeTemplates(count),
        maxTemplatesPerCall: 4
      }).map((batch) => batch.templates.length);

    expect(getBatchSizes(5)).toEqual([3, 2]);
    expect(getBatchSizes(6)).toEqual([3, 3]);
    expect(getBatchSizes(9)).toEqual([3, 3, 3]);
    expect(getBatchSizes(10)).toEqual([4, 3, 3]);
  });

  it("does not split large template bodies by prompt character budget", () => {
    const largeTemplates = templates.map((template) => ({
      ...template,
      body: "很长的模板正文。".repeat(2000),
      promptChars: 20000
    }));
    const legacyBudgetInput = {
      templates: largeTemplates,
      maxTemplatesPerCall: 4,
      promptBudgetChars: 60
    };
    const batches = planTemplateBatches(legacyBudgetInput);

    expect(batches).toHaveLength(1);
    expect(batches[0].templates.map((template) => template.fileName)).toEqual([
      "甲报告.md",
      "乙报告.md",
      "丙报告.md",
      "丁报告.md"
    ]);
    expect(batches[0].splitReason).toBe("complete");
  });
});
