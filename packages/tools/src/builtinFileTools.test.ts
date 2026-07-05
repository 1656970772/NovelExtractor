import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeBuiltinFileTool,
  ToolExecutionError,
} from "./builtinFileTools";

const readFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  readFileMock.mockImplementation(actual.readFile);
  return {
    ...actual,
    default: { ...actual, readFile: readFileMock },
    readFile: readFileMock
  };
});

function makeContext() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novel-tools-"));
  const reportsRoot = path.join(projectRoot, "books", "book-1", "reports");
  fs.mkdirSync(reportsRoot, { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "chapters"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "chapters", "第一章.txt"), "第一章\n凝气丹出现\n", "utf8");
  fs.writeFileSync(path.join(reportsRoot, "丹药分析.md"), "# 丹药分析\n\n旧内容\n", "utf8");

  return { projectRoot, reportsRoot };
}

function detectDirectoryLinkType(): "junction" | "dir" | null {
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novel-tools-link-"));
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

function expectToolExecutionErrorCode(error: unknown, code: ToolExecutionError["code"]): void {
  expect(error).toBeInstanceOf(ToolExecutionError);
  expect((error as ToolExecutionError).code).toBe(code);
}

describe("builtin file tools", () => {
  beforeEach(() => {
    readFileMock.mockClear();
  });

  it("lists, reads, and greps files under the project root", async () => {
    const context = makeContext();

    await expect(executeBuiltinFileTool("ls", { path: "chapters" }, context)).resolves.toContain("第一章.txt");
    await expect(executeBuiltinFileTool("read_file", { path: "chapters/第一章.txt" }, context)).resolves.toContain("1→第一章");
    await expect(executeBuiltinFileTool("grep", { path: ".", pattern: "凝气丹" }, context)).resolves.toContain("凝气丹出现");
  });

  it("returns capturable Reasonix-style errors for bad arguments and missing files", async () => {
    const context = makeContext();

    await expect(executeBuiltinFileTool("read_file", false, context)).rejects.toMatchObject({
      name: "ToolExecutionError",
      code: "INVALID_ARGUMENTS"
    });
    await expect(executeBuiltinFileTool("read_file", { path: "missing.txt" }, context)).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it.each(["ls", "read_file", "grep", "write_file", "edit_file"] as const)("ignores unknown fields on %s like Go JSON unmarshalling", async (toolName) => {
    const context = makeContext();
    const baseArgs = {
      ls: { path: "chapters" },
      read_file: { path: "chapters/第一章.txt" },
      grep: { path: ".", pattern: "凝气丹" },
      write_file: { path: "参数.md", content: "x" },
      edit_file: { path: "丹药分析.md", old_string: "旧内容", new_string: "新内容" }
    }[toolName];

    await expect(executeBuiltinFileTool(toolName, { ...baseArgs, ignored_by_reasonix: true }, context)).resolves.toEqual(
      expect.any(String)
    );
  });

  it("allows write_file, edit_file, and multi_edit only inside reports root with Reasonix text results", async () => {
    const context = makeContext();

    const writeResult = await executeBuiltinFileTool(
      "write_file",
      { path: "人物.md", content: "# 人物\n\n韩立\n" },
      context
    );
    expect(writeResult).toContain("wrote ");
    expect(writeResult).toContain("人物.md");
    expect(fs.readFileSync(path.join(context.reportsRoot, "人物.md"), "utf8")).toBe("# 人物\n\n韩立\n");

    const editResult = await executeBuiltinFileTool(
      "edit_file",
      { path: "人物.md", old_string: "韩立", new_string: "韩立：主角" },
      context
    );
    expect(editResult).toContain("edited ");

    const multiResult = await executeBuiltinFileTool(
      "multi_edit",
      {
        path: "人物.md",
        edits: [
          { old_string: "# 人物", new_string: "# 人物小传" },
          { old_string: "韩立：主角", new_string: "韩立：主角，谨慎" }
        ]
      },
      context
    );
    expect(multiResult).toContain("multi_edit ");
    expect(fs.readFileSync(path.join(context.reportsRoot, "人物.md"), "utf8")).toBe("# 人物小传\n\n韩立：主角，谨慎\n");
  });

  it("records mark_no_update outcomes without creating or editing report files", async () => {
    const context = makeContext();
    const result = await executeBuiltinFileTool(
      "mark_no_update",
      { path: "人物.md", reason: "当前窗口没有新增人物信息。" },
      context
    );

    expect(result).toBe("marked no update for 人物.md: 当前窗口没有新增人物信息。");
    expect(fs.existsSync(path.join(context.reportsRoot, "人物.md"))).toBe(false);
  });

  it("preserves Reasonix bash partial output on foreground command failure", async () => {
    const context = makeContext();

    await expect(
      executeBuiltinFileTool("bash", { command: "node -e \"console.log('before'); process.exit(7)\"" }, context)
    ).rejects.toSatisfy((error: unknown) => {
      expectToolExecutionErrorCode(error, "IO_ERROR");
      expect((error as ToolExecutionError & { output?: string }).message).toContain("command exited");
      expect((error as ToolExecutionError & { output?: string }).output).toContain("before");
      return true;
    });
  });

  it("rejects write tools when reports root resolves outside project root", async () => {
    const context = makeContext();
    const outsideReportsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novel-tools-outside-reports-"));

    await expect(
      executeBuiltinFileTool("write_file", { path: "逃逸.md", content: "x" }, { ...context, reportsRoot: outsideReportsRoot })
    ).rejects.toMatchObject({
      name: "ToolExecutionError",
      code: "UNSAFE_PATH"
    });
    expect(fs.existsSync(path.join(outsideReportsRoot, "逃逸.md"))).toBe(false);
  });

  it("rejects read_report_excerpt when reports root resolves outside project root", async () => {
    const context = makeContext();
    const outsideReportsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novel-tools-outside-read-reports-"));
    fs.writeFileSync(path.join(outsideReportsRoot, "NPC性格与代表事件.md"), "### 韩立\n- 核心性格：外部内容\n", "utf8");

    await expect(
      executeBuiltinFileTool(
        "read_report_excerpt",
        { outputFileName: "NPC性格与代表事件.md", queries: [{ cardName: "韩立", fields: ["核心性格"] }] },
        { ...context, reportsRoot: outsideReportsRoot, allowedReportFileNames: ["NPC性格与代表事件.md"] }
      )
    ).rejects.toMatchObject({
      name: "ToolExecutionError",
      code: "UNSAFE_PATH"
    });
  });

  it("rejects grep files larger than maxReadBytes", async () => {
    const context = makeContext();
    fs.writeFileSync(path.join(context.projectRoot, "chapters", "大文件.txt"), "0123456789", "utf8");

    await expect(executeBuiltinFileTool("read_file", { path: "chapters/大文件.txt", limit: 1 }, { ...context, maxReadBytes: 5 })).rejects.toMatchObject({
      name: "ToolExecutionError",
      code: "INVALID_ARGUMENTS"
    });
  });

  it("keeps grep on Reasonix search semantics instead of legacy file count budgets", async () => {
    const context = makeContext();
    fs.writeFileSync(path.join(context.projectRoot, "chapters", "第二章.txt"), "凝气丹\n", "utf8");

    await expect(executeBuiltinFileTool("grep", { path: "chapters", pattern: "凝气丹" }, { ...context, maxGrepFiles: 1 })).resolves.toContain(
      "凝气丹"
    );
  });

  it("keeps grep on Reasonix search semantics instead of legacy total byte budgets", async () => {
    const context = makeContext();

    await expect(executeBuiltinFileTool("grep", { path: "chapters", pattern: "凝气丹" }, { ...context, maxGrepTotalBytes: 4 })).resolves.toContain(
      "凝气丹"
    );
  });

  it("keeps grep on Reasonix result cap semantics instead of legacy match budgets", async () => {
    const context = makeContext();
    fs.writeFileSync(path.join(context.projectRoot, "chapters", "重复.txt"), "凝气丹\n凝气丹\n", "utf8");

    await expect(executeBuiltinFileTool("grep", { path: "chapters/重复.txt", pattern: "凝气丹" }, { ...context, maxGrepMatches: 1 })).resolves.toContain(
      "重复.txt"
    );
  });

  it("read_report_excerpt returns selected card field blocks by structured coordinates", async () => {
    const context = makeContext();
    fs.writeFileSync(
      path.join(context.reportsRoot, "NPC性格与代表事件.md"),
      ["### 韩立", "- 角色定位：主角", "- 核心性格：谨慎", "  - 证据：先观察", "- 代表行为：缩到车厢边角"].join("\n"),
      "utf8"
    );

    const result = await executeBuiltinFileTool(
      "read_report_excerpt",
      { outputFileName: "NPC性格与代表事件.md", queries: [{ cardName: "韩立", fields: ["核心性格", "代表行为"] }] },
      { ...context, allowedReportFileNames: ["NPC性格与代表事件.md"] }
    );

    const parsed = JSON.parse(result);
    expect(parsed.cards[0].fields[0]).toMatchObject({ fieldName: "核心性格", found: true });
    expect(parsed.cards[0].fields[0].content).toContain("证据：先观察");
    expect(parsed.cards[0].fields[0].content).not.toContain("- 代表行为：");
  });

  it("read_report_excerpt returns found=false for missing reports and fields", async () => {
    const context = makeContext();

    const result = await executeBuiltinFileTool(
      "read_report_excerpt",
      { outputFileName: "NPC性格与代表事件.md", queries: [{ cardName: "韩立", fields: ["核心性格"] }] },
      { ...context, allowedReportFileNames: ["NPC性格与代表事件.md"] }
    );

    expect(JSON.parse(result).cards[0]).toMatchObject({ cardName: "韩立", found: false });
  });

  it("rejects read_report_excerpt for unselected or unsafe report names", async () => {
    const context = makeContext();

    await expect(
      executeBuiltinFileTool(
        "read_report_excerpt",
        { outputFileName: "其他.md", queries: [{ cardName: "韩立", fields: ["核心性格"] }] },
        { ...context, allowedReportFileNames: ["丹药分析.md"] }
      )
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });

    await expect(
      executeBuiltinFileTool(
        "read_report_excerpt",
        { outputFileName: "../丹药分析.md", queries: [{ cardName: "韩立", fields: ["核心性格"] }] },
        context
      )
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
  });

  it("rejects extra read_report_excerpt fields at runtime", async () => {
    const context = makeContext();

    await expect(
      executeBuiltinFileTool(
        "read_report_excerpt",
        {
          outputFileName: "丹药分析.md",
          queries: [{ cardName: "韩立", fields: ["核心性格"] }],
          path: "../outside.md"
        },
        context
      )
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
  });

  it("reads the report file at most once when read_report_excerpt returns field blocks", async () => {
    const context = makeContext();
    fs.writeFileSync(
      path.join(context.reportsRoot, "NPC性格与代表事件.md"),
      ["### 韩立", "- 核心性格：谨慎"].join("\n"),
      "utf8"
    );
    await executeBuiltinFileTool(
      "read_report_excerpt",
      { outputFileName: "NPC性格与代表事件.md", queries: [{ cardName: "韩立", fields: ["核心性格"] }] },
      { ...context, allowedReportFileNames: ["NPC性格与代表事件.md"] }
    );

    const reportReadCount = readFileMock.mock.calls.filter(([filePath]) => path.normalize(String(filePath)) === path.join(context.reportsRoot, "NPC性格与代表事件.md")).length;
    expect(reportReadCount).toBeLessThanOrEqual(1);
  });

  it("upsert_report_section replaces selected field blocks without old_string", async () => {
    const context = makeContext();
    fs.writeFileSync(path.join(context.reportsRoot, "NPC性格与代表事件.md"), "### 韩立\n- 核心性格：谨慎\n- 代表行为：旧行为\n", "utf8");

    const result = await executeBuiltinFileTool(
      "upsert_report_section",
      {
        outputFileName: "NPC性格与代表事件.md",
        updates: [
          {
            cardName: "韩立",
            fieldName: "核心性格",
            content: "- 核心性格：谨慎、隐忍\n  - 证据：当前窗口"
          }
        ]
      },
      { ...context, allowedReportFileNames: ["NPC性格与代表事件.md"] }
    );

    expect(result).toContain("updated report fields 韩立/核心性格 in NPC性格与代表事件.md");
    expect(fs.readFileSync(path.join(context.reportsRoot, "NPC性格与代表事件.md"), "utf8")).toBe(
      "### 韩立\n- 核心性格：谨慎、隐忍\n  - 证据：当前窗口\n- 代表行为：旧行为\n"
    );
  });

  it("includes field coordinate in FIELD_NOT_FOUND errors for upsert_report_section", async () => {
    const context = makeContext();

    await expect(
      executeBuiltinFileTool(
        "upsert_report_section",
        {
          outputFileName: "丹药分析.md",
          updates: [{ cardName: "韩立", fieldName: "核心性格", content: "- 核心性格：新内容" }]
        },
        { ...context, allowedReportFileNames: ["丹药分析.md"] }
      )
    ).rejects.toMatchObject({
      code: "CARD_NOT_FOUND",
      message: expect.stringContaining("韩立")
    });
  });

  it("does not create reportsRoot before verifying it is inside projectRoot", async () => {
    const context = makeContext();
    const outsideParent = fs.mkdtempSync(path.join(os.tmpdir(), "novel-tools-outside-parent-"));
    const outsideReportsRoot = path.join(outsideParent, "new-reports-root");

    await expect(
      executeBuiltinFileTool(
        "upsert_report_section",
        {
          outputFileName: "新报告.md",
          updates: [{ cardName: "韩立", fieldName: "核心性格", content: "- 核心性格：新" }]
        },
        { ...context, reportsRoot: outsideReportsRoot, allowedReportFileNames: ["新报告.md"] }
      )
    ).rejects.toMatchObject({
      name: "ToolExecutionError",
      code: "UNSAFE_PATH"
    });
    expect(fs.existsSync(outsideReportsRoot)).toBe(false);
  });

  it.skipIf(directoryLinkType === null)("rejects missing reportsRoot under a symlink parent before creating it", async () => {
    const context = makeContext();
    const outsideParent = fs.mkdtempSync(path.join(os.tmpdir(), "novel-tools-outside-symlink-parent-"));
    const linkPath = path.join(context.projectRoot, "linked-reports-parent");
    const linkedReportsRoot = path.join(linkPath, "reports");
    fs.symlinkSync(outsideParent, linkPath, directoryLinkType ?? "dir");

    await expect(
      executeBuiltinFileTool(
        "upsert_report_section",
        {
          outputFileName: "新报告.md",
          updates: [{ cardName: "韩立", fieldName: "核心性格", content: "- 核心性格：新" }]
        },
        { ...context, reportsRoot: linkedReportsRoot, allowedReportFileNames: ["新报告.md"] }
      )
    ).rejects.toMatchObject({
      name: "ToolExecutionError",
      code: "UNSAFE_PATH"
    });
    expect(fs.existsSync(path.join(outsideParent, "reports"))).toBe(false);
  });

  it("rejects upsert_report_section old_string, extra fields, and unselected reports", async () => {
    const context = makeContext();

    await expect(
      executeBuiltinFileTool(
        "upsert_report_section",
        {
          outputFileName: "丹药分析.md",
          updates: [{ cardName: "韩立", fieldName: "核心性格", content: "- 核心性格：新" }],
          old_string: "旧内容"
        },
        { ...context, allowedReportFileNames: ["丹药分析.md"] }
      )
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENTS",
      message: expect.stringContaining("字段级更新不接受 old_string/sectionId/writeMode")
    });

    await expect(
      executeBuiltinFileTool(
        "upsert_report_section",
        {
          outputFileName: "丹药分析.md",
          updates: [{ cardName: "韩立", fieldName: "核心性格", content: "- 核心性格：新" }],
          unsupported: true
        },
        { ...context, allowedReportFileNames: ["丹药分析.md"] }
      )
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });

    await expect(
      executeBuiltinFileTool(
        "upsert_report_section",
        {
          outputFileName: "其他.md",
          updates: [{ cardName: "韩立", fieldName: "核心性格", content: "- 核心性格：新" }]
        },
        { ...context, allowedReportFileNames: ["丹药分析.md"] }
      )
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
  });

  it("re-reads the latest report content for consecutive upsert_report_section calls", async () => {
    const context = makeContext();
    const reportPath = path.join(context.reportsRoot, "NPC性格与代表事件.md");
    fs.writeFileSync(reportPath, "### 韩立\n- 核心性格：旧性格\n- 代表行为：旧行为\n", "utf8");

    await executeBuiltinFileTool(
      "upsert_report_section",
      {
        outputFileName: "NPC性格与代表事件.md",
        updates: [{ cardName: "韩立", fieldName: "核心性格", content: "- 核心性格：批次 A 内容" }]
      },
      { ...context, allowedReportFileNames: ["NPC性格与代表事件.md"] }
    );
    await executeBuiltinFileTool(
      "upsert_report_section",
      {
        outputFileName: "NPC性格与代表事件.md",
        updates: [{ cardName: "韩立", fieldName: "代表行为", content: "- 代表行为：批次 B 内容" }]
      },
      { ...context, allowedReportFileNames: ["NPC性格与代表事件.md"] }
    );

    const finalReport = fs.readFileSync(reportPath, "utf8");
    const reportReadCount = readFileMock.mock.calls.filter(([filePath]) => path.normalize(String(filePath)) === reportPath).length;
    expect(reportReadCount).toBe(2);
    expect(finalReport).toContain("批次 A 内容");
    expect(finalReport).toContain("批次 B 内容");
  });

  it.each(["../outside.md", "nested/report.md", path.resolve("outside.md")])("rejects unsafe report path %s", async (candidate) => {
    const context = makeContext();

    await expect(executeBuiltinFileTool("write_file", { path: candidate, content: "x" }, context)).rejects.toMatchObject({
      code: "UNSAFE_PATH"
    });
  });

  it.skipIf(directoryLinkType === null)("rejects writes through symlink or junction escapes", async () => {
    const context = makeContext();
    const outsideRoot = path.join(context.projectRoot, "outside");
    const linkPath = path.join(context.reportsRoot, "linked-out");
    fs.mkdirSync(outsideRoot);
    fs.symlinkSync(outsideRoot, linkPath, directoryLinkType ?? "dir");

    await expect(executeBuiltinFileTool("write_file", { path: "linked-out/逃逸.md", content: "x" }, context)).rejects.toMatchObject({
      code: "UNSAFE_PATH"
    });
  });

  it("maps edit_file replacement misses from ReportWriterError to ToolExecutionError", async () => {
    const context = makeContext();

    await expect(executeBuiltinFileTool("edit_file", { path: "丹药分析.md", old_string: "missing", new_string: "x" }, context)).rejects.toSatisfy(
      (error: unknown) => {
        expectToolExecutionErrorCode(error, "INVALID_ARGUMENTS");
        return true;
      }
    );
  });

  it("maps edit_file symlink escapes from ReportWriterError to ToolExecutionError", async () => {
    const context = makeContext();
    const outsideFile = path.join(context.projectRoot, "outside-secret.md");
    const linkPath = path.join(context.reportsRoot, "linked.md");
    fs.writeFileSync(outsideFile, "EXTERNAL_SECRET_BETA\n", "utf8");
    fs.symlinkSync(outsideFile, linkPath, "file");

    await expect(
      executeBuiltinFileTool("edit_file", { path: "linked.md", old_string: "EXTERNAL_SECRET_BETA", new_string: "x" }, context)
    ).rejects.toSatisfy(
      (error: unknown) => {
        expectToolExecutionErrorCode(error, "UNSAFE_PATH");
        return true;
      }
    );
  });

  it("maps multi_edit replacement misses from ReportWriterError to ToolExecutionError", async () => {
    const context = makeContext();

    await expect(
      executeBuiltinFileTool("multi_edit", { path: "丹药分析.md", edits: [{ old_string: "missing", new_string: "x" }] }, context)
    ).rejects.toSatisfy((error: unknown) => {
      expectToolExecutionErrorCode(error, "INVALID_ARGUMENTS");
      return true;
    });
  });
});
