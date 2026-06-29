import { describe, expect, it } from "vitest";
import { getBuiltInTemplates, resolveReportFileName } from "./templates";

describe("templates", () => {
  it("resolves report names from template config", () => {
    expect(resolveReportFileName({ name: "丹药分析模板" })).toBe("丹药分析.md");
    expect(resolveReportFileName({ name: "势力设定", outputFileName: "势力谱系.md" })).toBe("势力谱系.md");
  });

  it("rejects unknown template names instead of deriving an implicit report name", () => {
    let thrown: unknown;

    try {
      resolveReportFileName({ name: "未知模板" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("UnknownTemplateError");
  });

  it("keeps built-in template names configurable", () => {
    expect(getBuiltInTemplates().map((template) => template.name)).toContain("丹药分析模板");
  });
});
