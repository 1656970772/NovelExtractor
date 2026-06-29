import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createReportWriter, ReportWriterError } from "./reportWriter";

function makeReportsRoot(): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novel-markdown-"));
  const reportsRoot = path.join(projectRoot, "reports");
  fs.mkdirSync(reportsRoot, { recursive: true });
  return reportsRoot;
}

function detectDirectoryLinkType(): "junction" | "dir" | null {
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novel-markdown-link-"));
  const target = path.join(probeRoot, "target");
  const link = path.join(probeRoot, "link");
  fs.mkdirSync(target);

  for (const type of ["junction", "dir"] as const) {
    try {
      fs.symlinkSync(target, link, type);
      fs.rmSync(probeRoot, { recursive: true, force: true });
      return type;
    } catch {
      fs.rmSync(link, { recursive: true, force: true });
    }
  }

  fs.rmSync(probeRoot, { recursive: true, force: true });
  return null;
}

const directoryLinkType = detectDirectoryLinkType();

function expectReportWriterErrorCode(action: () => unknown, code: ReportWriterError["code"]): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ReportWriterError);
    expect((error as ReportWriterError).code).toBe(code);
    return;
  }

  throw new Error(`Expected ReportWriterError with code ${code}`);
}

describe("Markdown report writer", () => {
  it("creates or overwrites reports with caller-provided title and content", () => {
    const reportsRoot = makeReportsRoot();
    const writer = createReportWriter({ reportsRoot });

    const result = writer.writeReport({
      path: "丹药分析.md",
      title: "丹药分析",
      content: "凝气丹：一阶"
    });

    expect(result).toMatchObject({
      relativePath: "丹药分析.md",
      content: "# 丹药分析\n\n凝气丹：一阶\n"
    });
    expect(fs.readFileSync(path.join(reportsRoot, "丹药分析.md"), "utf8")).toBe("# 丹药分析\n\n凝气丹：一阶\n");

    writer.writeReport({ path: "丹药分析.md", content: "覆盖内容" });
    expect(fs.readFileSync(path.join(reportsRoot, "丹药分析.md"), "utf8")).toBe("覆盖内容\n");
  });

  it("appends paragraphs without hard-coded sections or templates", () => {
    const reportsRoot = makeReportsRoot();
    const writer = createReportWriter({ reportsRoot });
    writer.writeReport({ path: "线索.md", title: "线索", content: "初始" });

    writer.appendParagraph({ path: "线索.md", paragraph: "第二段\n带换行" });

    expect(fs.readFileSync(path.join(reportsRoot, "线索.md"), "utf8")).toBe("# 线索\n\n初始\n\n第二段\n带换行\n");
  });

  it("applies safe replacements and multi-edit operations", () => {
    const reportsRoot = makeReportsRoot();
    const writer = createReportWriter({ reportsRoot });
    writer.writeReport({ path: "人物.md", content: "韩立\n墨大夫\n韩立\n" });

    const replaceResult = writer.replaceText({ path: "人物.md", oldText: "墨大夫", newText: "墨居仁" });
    expect(replaceResult.changedBytes).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(reportsRoot, "人物.md"), "utf8")).toBe("韩立\n墨居仁\n韩立\n");

    writer.applyMultiEdit({
      path: "人物.md",
      edits: [
        { oldText: "韩立", newText: "韩立：谨慎" },
        { oldText: "墨居仁", newText: "墨居仁：师父" }
      ]
    });
    expect(fs.readFileSync(path.join(reportsRoot, "人物.md"), "utf8")).toBe("韩立：谨慎\n墨居仁：师父\n韩立\n");
  });

  it("reports changedBytes greater than zero for same-length content replacements", () => {
    const reportsRoot = makeReportsRoot();
    const writer = createReportWriter({ reportsRoot });
    writer.writeReport({ path: "审计.md", content: "abc" });

    const result = writer.replaceText({ path: "审计.md", oldText: "abc", newText: "xyz" });

    expect(result.changedBytes).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(reportsRoot, "审计.md"), "utf8")).toBe("xyz\n");
  });

  it("rejects missing replacement text to make edit failures auditable", () => {
    const reportsRoot = makeReportsRoot();
    const writer = createReportWriter({ reportsRoot });
    writer.writeReport({ path: "人物.md", content: "韩立\n" });

    expect(() => writer.replaceText({ path: "人物.md", oldText: "不存在", newText: "x" })).toThrow(ReportWriterError);
  });

  it.each(["../outside.md", "nested/report.md", path.resolve("outside.md"), "", "."])("rejects unsafe report path %s", (candidate) => {
    const writer = createReportWriter({ reportsRoot: makeReportsRoot() });

    expect(() => writer.writeReport({ path: candidate, content: "x" })).toThrow(ReportWriterError);
  });

  it.skipIf(directoryLinkType === null)("rejects symlink or junction path escapes", () => {
    const reportsRoot = makeReportsRoot();
    const outsideRoot = path.join(path.dirname(reportsRoot), "outside");
    const linkPath = path.join(reportsRoot, "linked-out");
    fs.mkdirSync(outsideRoot);
    fs.symlinkSync(outsideRoot, linkPath, directoryLinkType ?? "dir");
    const writer = createReportWriter({ reportsRoot });

    expect(() => writer.writeReport({ path: "linked-out/逃逸.md", content: "x" })).toThrow(ReportWriterError);
  });

  it("rejects writes through an existing file symlink that targets outside reports root", () => {
    const reportsRoot = makeReportsRoot();
    const outsideFile = path.join(path.dirname(reportsRoot), "outside.md");
    const linkPath = path.join(reportsRoot, "linked.md");
    fs.writeFileSync(outsideFile, "outside", "utf8");
    fs.symlinkSync(outsideFile, linkPath, "file");
    const writer = createReportWriter({ reportsRoot });

    expect(() => writer.writeReport({ path: "linked.md", content: "inside" })).toThrow(ReportWriterError);
    expect(fs.readFileSync(outsideFile, "utf8")).toBe("outside");
  });

  it("rejects replaceText through an existing file symlink before external content can affect the result", () => {
    const reportsRoot = makeReportsRoot();
    const outsideFile = path.join(path.dirname(reportsRoot), "outside-secret.md");
    const linkPath = path.join(reportsRoot, "linked.md");
    fs.writeFileSync(outsideFile, "EXTERNAL_SECRET_BETA\n", "utf8");
    fs.symlinkSync(outsideFile, linkPath, "file");
    const writer = createReportWriter({ reportsRoot });

    for (const oldText of ["NOT_PRESENT", "EXTERNAL_SECRET_BETA"]) {
      expectReportWriterErrorCode(
        () => writer.replaceText({ path: "linked.md", oldText, newText: "replacement" }),
        "UNSAFE_PATH"
      );
      expect(fs.readFileSync(outsideFile, "utf8")).toBe("EXTERNAL_SECRET_BETA\n");
    }
  });

  it("rejects multi_edit through an existing file symlink before external content can affect the result", () => {
    const reportsRoot = makeReportsRoot();
    const outsideFile = path.join(path.dirname(reportsRoot), "outside-secret.md");
    const linkPath = path.join(reportsRoot, "linked.md");
    fs.writeFileSync(outsideFile, "EXTERNAL_SECRET_BETA\n", "utf8");
    fs.symlinkSync(outsideFile, linkPath, "file");
    const writer = createReportWriter({ reportsRoot });

    for (const oldText of ["NOT_PRESENT", "EXTERNAL_SECRET_BETA"]) {
      expectReportWriterErrorCode(
        () =>
          writer.applyMultiEdit({
            path: "linked.md",
            edits: [{ oldText, newText: "replacement" }]
          }),
        "UNSAFE_PATH"
      );
      expect(fs.readFileSync(outsideFile, "utf8")).toBe("EXTERNAL_SECRET_BETA\n");
    }
  });
});
