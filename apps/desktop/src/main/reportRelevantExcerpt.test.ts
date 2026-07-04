import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { findRelevantReportExcerpt, type GrepReportFile, type ReadReportRange } from "./reportRelevantExcerpt";

describe("report relevant excerpt", () => {
  it("returns the markdown section containing a matched keyword", async () => {
    const grepReportFile: GrepReportFile = vi.fn(async () => ({
      matches: [{ lineNumber: 5, line: "青竹蜂云剑首次作为法器线索出现。" }]
    }));
    const readReportRange: ReadReportRange = vi.fn(async () =>
      [
        "# 材料分析",
        "",
        "## 丹药",
        "凝气丹旧内容。",
        "## 法器",
        "青竹蜂云剑首次作为法器线索出现。",
        "后续补充。",
        "## 灵草",
        "无关内容。"
      ].join("\n")
    );

    await expect(
      findRelevantReportExcerpt({
        outputFileName: "材料分析.md",
        reportPath: "E:/project/reports/材料分析.md",
        keywords: ["青竹蜂云剑"],
        grepReportFile,
        readReportRange
      })
    ).resolves.toMatchObject({
      outputFileName: "材料分析.md",
      found: true,
      recommendedWriteMode: "append_to_section",
      excerptMarkdown: expect.stringContaining("## 法器")
    });
  });

  it("returns the stable sectionId for a matched duplicate heading section", async () => {
    const reportsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novel-excerpt-section-id-"));
    const reportPath = path.join(reportsRoot, "材料分析.md");
    fs.writeFileSync(
      reportPath,
      ["# 材料分析", "", "## 法器", "青竹蜂云剑 A", "", "## 法器", "青竹蜂云剑 B"].join("\n"),
      "utf8"
    );

    const result = await findRelevantReportExcerpt({
      outputFileName: "材料分析.md",
      reportPath,
      keywords: ["青竹蜂云剑 B"]
    });

    expect(result).toMatchObject({
      found: true,
      recommendedWriteMode: "append_to_section",
      sectionId: "材料分析/法器#2",
      excerptMarkdown: expect.stringContaining("青竹蜂云剑 B")
    });
    expect(result.excerptMarkdown).not.toContain("青竹蜂云剑 A");
  });

  it("does not call any range reader when grep finds no keyword", async () => {
    const grepReportFile: GrepReportFile = vi.fn(async () => ({ matches: [] }));
    const readReportRange: ReadReportRange = vi.fn(async () => "SHOULD_NOT_READ");

    await expect(
      findRelevantReportExcerpt({
        outputFileName: "材料分析.md",
        reportPath: "E:/project/reports/材料分析.md",
        keywords: ["青竹蜂云剑"],
        grepReportFile,
        readReportRange
      })
    ).resolves.toMatchObject({
      found: false,
      recommendedWriteMode: "append_to_end"
    });
    expect(readReportRange).not.toHaveBeenCalled();
  });

  it("returns a bounded range around the matching line when headings are absent", async () => {
    const grepReportFile: GrepReportFile = vi.fn(async () => ({
      matches: [{ lineNumber: 30, line: "青竹蜂云剑出现在无标题旧报告中。" }]
    }));
    const readReportRange: ReadReportRange = vi.fn(async () =>
      ["上文", "青竹蜂云剑出现在无标题旧报告中。", "下文"].join("\n")
    );

    const result = await findRelevantReportExcerpt({
      outputFileName: "材料分析.md",
      reportPath: "E:/project/reports/材料分析.md",
      keywords: ["青竹蜂云剑"],
      grepReportFile,
      readReportRange
    });

    expect(result).toMatchObject({
      found: true,
      recommendedWriteMode: "append_to_section",
      excerptMarkdown: expect.stringContaining("青竹蜂云剑")
    });
    expect(readReportRange).toHaveBeenCalledWith(
      expect.objectContaining({
        reportPath: "E:/project/reports/材料分析.md",
        startLine: expect.any(Number),
        endLine: expect.any(Number)
      })
    );
  });

  it("expands upward to include a long markdown section heading and stops before the next peer section", async () => {
    const reportLines = new Map<number, string>([
      [1, "# 材料分析"],
      [2, ""],
      [3, "## 法器"],
      [74, "青竹蜂云剑在长小节末尾出现。"],
      [75, "后续相关行"],
      [76, "## 丹药"],
      [77, "无关丹药内容"]
    ]);
    for (let lineNumber = 4; lineNumber <= 73; lineNumber += 1) {
      reportLines.set(lineNumber, `小节内铺垫行 ${lineNumber}`);
    }
    const grepReportFile: GrepReportFile = vi.fn(async () => ({
      matches: [{ lineNumber: 74, line: "青竹蜂云剑在长小节末尾出现。" }]
    }));
    const readReportRange: ReadReportRange = vi.fn(async ({ startLine, endLine }) => {
      const lines: string[] = [];
      for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
        const line = reportLines.get(lineNumber);
        if (line !== undefined) {
          lines.push(line);
        }
      }
      return lines.join("\n");
    });

    const result = await findRelevantReportExcerpt({
      outputFileName: "材料分析.md",
      reportPath: "E:/project/reports/材料分析.md",
      keywords: ["青竹蜂云剑"],
      grepReportFile,
      readReportRange
    });

    expect(result.excerptMarkdown).toContain("## 法器");
    expect(result.excerptMarkdown).toContain("青竹蜂云剑");
    expect(result.excerptMarkdown).not.toContain("## 丹药");
    expect(readReportRange).toHaveBeenCalledWith(
      expect.objectContaining({
        startLine: 34,
        endLine: 154
      })
    );
  });

  it("caps returned excerpt text and marks truncation explicitly", async () => {
    const grepReportFile: GrepReportFile = vi.fn(async () => ({
      matches: [{ lineNumber: 2, line: "青竹蜂云剑" }]
    }));
    const readReportRange: ReadReportRange = vi.fn(async () => `# 材料分析\n\n${"青竹蜂云剑相关内容。".repeat(80)}`);

    await expect(
      findRelevantReportExcerpt({
        outputFileName: "材料分析.md",
        reportPath: "E:/project/reports/材料分析.md",
        keywords: ["青竹蜂云剑"],
        maxChars: 120,
        grepReportFile,
        readReportRange
      })
    ).resolves.toMatchObject({
      found: true,
      truncated: true,
      excerptMarkdown: expect.stringContaining("内容已截断")
    });
  });
});
