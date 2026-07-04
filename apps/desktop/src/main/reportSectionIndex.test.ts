import { describe, expect, it } from "vitest";
import {
  buildReportSectionIndex,
  upsertReportSection
} from "./reportSectionIndex";

describe("report section index", () => {
  it("builds stable section ids from Markdown heading paths", () => {
    const index = buildReportSectionIndex("# 材料分析\n\n## 灵草\n正文\n\n## 法器\n正文");

    expect(
      index.sections.map((section) => ({
        id: section.id,
        level: section.level,
        title: section.title,
        snippet: section.snippet
      }))
    ).toEqual([
      { id: "材料分析", level: 1, title: "材料分析", snippet: "## 灵草\n正文\n\n## 法器\n正文" },
      { id: "材料分析/灵草", level: 2, title: "灵草", snippet: "正文" },
      { id: "材料分析/法器", level: 2, title: "法器", snippet: "正文" }
    ]);
    expect(index.sections[0].range.start).toBe(0);
    expect(index.sections[0].range.end).toBe("# 材料分析\n\n## 灵草\n正文\n\n## 法器\n正文".length);
  });

  it("disambiguates repeated sibling headings with stable suffixes", () => {
    const index = buildReportSectionIndex("# 材料分析\n\n## 法器\nA\n\n## 法器\nB");

    expect(index.sections.map((section) => section.id)).toEqual([
      "材料分析",
      "材料分析/法器",
      "材料分析/法器#2"
    ]);
  });

  it("replaces a section body while preserving the heading and later sections", () => {
    const result = upsertReportSection({
      content: "# 材料分析\n\n## 法器\n旧内容\n\n## 丹药\n丹药内容",
      sectionId: "材料分析/法器",
      writeMode: "replace_section",
      nextContent: "新内容"
    });

    expect(result).toMatchObject({ ok: true });
    expect(result.ok ? result.content : "").toContain("## 法器\n新内容\n\n## 丹药\n丹药内容");
  });

  it("builds nested section ids without duplicating ancestor paths", () => {
    const content = "# 材料分析\n\n## 法器\n法器总述\n\n### 细节\n旧细节\n\n## 丹药\n丹药内容";

    expect(buildReportSectionIndex(content).sections.map((section) => section.id)).toEqual([
      "材料分析",
      "材料分析/法器",
      "材料分析/法器/细节",
      "材料分析/丹药"
    ]);
    expect(
      upsertReportSection({
        content,
        sectionId: "材料分析/法器/细节",
        writeMode: "replace_section",
        nextContent: "新细节"
      })
    ).toMatchObject({ ok: true });
  });

  it("keeps ATX closing markers only when separated by whitespace and ignores empty headings", () => {
    expect(buildReportSectionIndex("# C#\n正文").sections[0]).toMatchObject({ id: "C#", title: "C#" });
    expect(buildReportSectionIndex("# A\n\n##    \n空标题正文").sections.map((section) => section.id)).toEqual(["A"]);
  });

  it("preserves CRLF line endings when replacing and appending report sections", () => {
    const source = "# 材料分析\r\n\r\n## 法器\r\n旧内容\r\n\r\n## 丹药\r\n丹药内容\r\n";
    const replaced = upsertReportSection({
      content: source,
      sectionId: "材料分析/法器",
      writeMode: "replace_section",
      nextContent: "新内容"
    });
    const appended = upsertReportSection({
      content: source,
      sectionId: "材料分析/法器",
      writeMode: "append_to_section",
      nextContent: "追加内容"
    });
    const endAppended = upsertReportSection({
      content: source,
      writeMode: "append_to_end",
      nextContent: "末尾内容"
    });

    for (const result of [replaced, appended, endAppended]) {
      expect(result).toMatchObject({ ok: true });
      expect(result.ok ? result.content : "").not.toMatch(/(?<!\r)\n/u);
    }
    expect(replaced.ok ? replaced.content : "").toContain("## 法器\r\n新内容\r\n\r\n## 丹药");
    expect(appended.ok ? appended.content : "").toContain("旧内容\r\n\r\n追加内容\r\n\r\n## 丹药");
    expect(endAppended.ok ? endAppended.content : "").toMatch(/丹药内容\r\n\r\n末尾内容\r\n$/u);
  });

  it("supports replace_section, append_to_section, and append_to_end write modes", () => {
    const source = "# 材料分析\n\n## 法器\n旧内容\n\n## 丹药\n丹药内容";
    const appended = upsertReportSection({
      content: source,
      sectionId: "材料分析/法器",
      writeMode: "append_to_section",
      nextContent: "追加内容"
    });
    const endAppended = upsertReportSection({
      content: appended.ok ? appended.content : source,
      writeMode: "append_to_end",
      nextContent: "报告末尾内容"
    });

    expect(appended.ok ? appended.content : "").toContain("## 法器\n旧内容\n\n追加内容\n\n## 丹药");
    expect(endAppended.ok ? endAppended.content : "").toMatch(/丹药内容\n\n报告末尾内容\n$/u);
  });

  it("returns recoverable SECTION_NOT_FOUND for missing section writes", () => {
    const result = upsertReportSection({
      content: "# 材料分析\n\n## 法器\n旧内容",
      sectionId: "材料分析/灵草",
      writeMode: "replace_section",
      nextContent: "新内容"
    });

    expect(result).toMatchObject({
      ok: false,
      code: "SECTION_NOT_FOUND"
    });
    expect(result.ok ? "" : result.message).toContain("Task 7 关键词未命中新内容改用 append_to_end");
    expect(result.ok ? "" : result.message).toContain("create_section");
  });

  it("creates a missing report by appending to the end of empty content", () => {
    const result = upsertReportSection({
      content: "",
      writeMode: "append_to_end",
      nextContent: "# 材料分析\n\n新增内容"
    });

    expect(result).toEqual({
      ok: true,
      content: "# 材料分析\n\n新增内容\n"
    });
  });
});
