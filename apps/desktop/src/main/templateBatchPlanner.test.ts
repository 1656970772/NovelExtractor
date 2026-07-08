import { describe, expect, it } from "vitest";
import { planTemplateBatches } from "./templateBatchPlanner";

const templates = [
  { id: "template-a", name: "甲模板", fileName: "甲报告.md", promptChars: 20 },
  { id: "template-b", name: "乙模板", fileName: "乙报告.md", promptChars: 25 },
  { id: "template-c", name: "丙模板", fileName: "丙报告.md", promptChars: 30 },
  { id: "template-d", name: "丁模板", fileName: "丁报告.md", promptChars: 35 }
] as const;

describe("template batch planner", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0])(
    "falls back to one-template batches for invalid max templates per call: %s",
    (maxTemplatesPerCall) => {
      const batches = planTemplateBatches({
        templates,
        maxTemplatesPerCall
      });

      expect(batches.map((batch) => batch.templates.map((template) => template.fileName))).toEqual([
        ["甲报告.md"],
        ["乙报告.md"],
        ["丙报告.md"],
        ["丁报告.md"]
      ]);
      expect(batches.every((batch) => batch.templates.length > 0)).toBe(true);
      expect(batches.map((batch) => batch.splitReason)).toEqual([
        "maxTemplatesPerCall",
        "maxTemplatesPerCall",
        "maxTemplatesPerCall",
        "complete"
      ]);
    }
  );

  it("floors decimal max templates per call values", () => {
    const batches = planTemplateBatches({
      templates,
      maxTemplatesPerCall: 2.8
    });

    expect(batches.map((batch) => batch.templates.map((template) => template.fileName))).toEqual([
      ["甲报告.md", "乙报告.md"],
      ["丙报告.md", "丁报告.md"]
    ]);
  });

  it("returns no batches for an empty template list", () => {
    const batches = planTemplateBatches({
      templates: [],
      maxTemplatesPerCall: 2
    });

    expect(batches).toEqual([]);
  });

  it("keeps one-template batches when configured max templates per call is one", () => {
    const batches = planTemplateBatches({
      templates,
      maxTemplatesPerCall: 1
    });

    expect(batches.map((batch) => ({ batchId: batch.batchId, batchIndex: batch.batchIndex }))).toEqual([
      { batchId: "batch-0001", batchIndex: 0 },
      { batchId: "batch-0002", batchIndex: 1 },
      { batchId: "batch-0003", batchIndex: 2 },
      { batchId: "batch-0004", batchIndex: 3 }
    ]);
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
    expect(batches[0]).toMatchObject({ batchId: "batch-0001", batchIndex: 0 });
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
    expect(batches.map((batch) => ({ batchId: batch.batchId, batchIndex: batch.batchIndex }))).toEqual([
      { batchId: "batch-0001", batchIndex: 0 },
      { batchId: "batch-0002", batchIndex: 1 }
    ]);
    expect(batches.map((batch) => batch.splitReason)).toEqual(["maxTemplatesPerCall", "complete"]);
  });

  it("chunks templates in stable sequential fixed-size batches", () => {
    const templates = Array.from({ length: 37 }, (_, index) => ({
      id: `template-${index + 1}`,
      name: `模板 ${index + 1}`,
      fileName: `模板-${index + 1}.md`
    }));

    const batches = planTemplateBatches({ templates, maxTemplatesPerCall: 2 });

    expect(batches).toHaveLength(19);
    expect(batches.map((batch) => batch.templates.map((template) => template.id)).flat()).toEqual(
      templates.map((template) => template.id)
    );
    expect(batches.slice(0, -1).map((batch) => batch.templates.length)).toEqual(Array.from({ length: 18 }, () => 2));
    expect(batches[0]).toMatchObject({
      batchId: "batch-0001",
      batchIndex: 0,
      templates: [{ id: "template-1" }, { id: "template-2" }]
    });
    expect(batches.at(-1)).toMatchObject({
      batchId: "batch-0019",
      batchIndex: 18,
      templates: [{ id: "template-37" }]
    });
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
    expect(batches[0]).toMatchObject({ batchId: "batch-0001", batchIndex: 0 });
    expect(batches[0].templates.map((template) => template.fileName)).toEqual([
      "甲报告.md",
      "乙报告.md",
      "丙报告.md",
      "丁报告.md"
    ]);
    expect(batches[0].splitReason).toBe("complete");
  });
});
