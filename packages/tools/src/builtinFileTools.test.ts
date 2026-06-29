import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { executeBuiltinFileTool, ToolExecutionError, type ToolWriteSummary } from "./builtinFileTools";

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
  it("lists, reads, and greps files under the project root", async () => {
    const context = makeContext();

    await expect(executeBuiltinFileTool("ls", { path: "chapters" }, context)).resolves.toMatchObject({
      path: "chapters",
      entries: [{ name: "第一章.txt", type: "file" }]
    });
    await expect(executeBuiltinFileTool("read_file", { path: "chapters/第一章.txt" }, context)).resolves.toMatchObject({
      path: "chapters/第一章.txt",
      content: "第一章\n凝气丹出现\n"
    });
    await expect(executeBuiltinFileTool("grep", { path: ".", pattern: "凝气丹" }, context)).resolves.toMatchObject({
      matches: [{ path: "chapters/第一章.txt", line: 2, text: "凝气丹出现" }]
    });
  });

  it("returns capturable errors for bad raw JSON arguments and missing files", async () => {
    const context = makeContext();

    await expect(executeBuiltinFileTool("read_file", { file: "chapters/第一章.txt" }, context)).rejects.toMatchObject({
      name: "ToolExecutionError",
      code: "INVALID_ARGUMENTS"
    });
    await expect(executeBuiltinFileTool("read_file", { path: "missing.txt" }, context)).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it.each(["ls", "read_file", "grep", "write_file", "edit_file"] as const)("rejects edits on %s when schema does not allow it", async (toolName) => {
    const context = makeContext();
    const baseArgs = {
      ls: { path: "chapters" },
      read_file: { path: "chapters/第一章.txt" },
      grep: { path: ".", pattern: "凝气丹" },
      write_file: { path: "参数.md", content: "x" },
      edit_file: { path: "丹药分析.md", oldText: "旧内容", newText: "新内容" }
    }[toolName];

    await expect(executeBuiltinFileTool(toolName, { ...baseArgs, edits: [] }, context)).rejects.toMatchObject({
      name: "ToolExecutionError",
      code: "INVALID_ARGUMENTS"
    });
  });

  it("allows edits only on multi_edit and rejects other extra fields", async () => {
    const context = makeContext();

    await expect(
      executeBuiltinFileTool(
        "multi_edit",
        { path: "丹药分析.md", edits: [{ oldText: "旧内容", newText: "新内容" }], extra: "x" },
        context
      )
    ).rejects.toMatchObject({
      name: "ToolExecutionError",
      code: "INVALID_ARGUMENTS"
    });
  });

  it("allows write_file, edit_file, and multi_edit only inside reports root with audit summaries", async () => {
    const context = makeContext();

    const writeSummary = (await executeBuiltinFileTool(
      "write_file",
      { path: "人物.md", content: "# 人物\n\n韩立\n" },
      context
    )) as ToolWriteSummary;
    expect(writeSummary).toMatchObject({
      path: "人物.md",
      operation: "write_file",
      changedBytes: Buffer.byteLength("# 人物\n\n韩立\n", "utf8"),
      preview: "# 人物\n\n韩立\n"
    });
    expect(fs.readFileSync(path.join(context.reportsRoot, "人物.md"), "utf8")).toBe("# 人物\n\n韩立\n");

    const editSummary = (await executeBuiltinFileTool(
      "edit_file",
      { path: "人物.md", oldText: "韩立", newText: "韩立：主角" },
      context
    )) as ToolWriteSummary;
    expect(editSummary).toMatchObject({
      path: "人物.md",
      operation: "edit_file"
    });
    expect(editSummary.changedBytes).toBeGreaterThan(0);

    const multiSummary = (await executeBuiltinFileTool(
      "multi_edit",
      {
        path: "人物.md",
        edits: [
          { oldText: "# 人物", newText: "# 人物小传" },
          { oldText: "韩立：主角", newText: "韩立：主角，谨慎" }
        ]
      },
      context
    )) as ToolWriteSummary;
    expect(multiSummary).toMatchObject({
      path: "人物.md",
      operation: "multi_edit"
    });
    expect(fs.readFileSync(path.join(context.reportsRoot, "人物.md"), "utf8")).toBe("# 人物小传\n\n韩立：主角，谨慎\n");
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

  it("rejects grep files larger than maxReadBytes", async () => {
    const context = makeContext();
    fs.writeFileSync(path.join(context.projectRoot, "chapters", "大文件.txt"), "0123456789", "utf8");

    await expect(executeBuiltinFileTool("grep", { path: "chapters/大文件.txt", pattern: "9" }, { ...context, maxReadBytes: 5 })).rejects.toMatchObject({
      name: "ToolExecutionError",
      code: "INVALID_ARGUMENTS"
    });
  });

  it("truncates grep match text to the configured preview limit", async () => {
    const context = makeContext();
    fs.writeFileSync(path.join(context.projectRoot, "chapters", "长行.txt"), `prefix-${"x".repeat(100)}-suffix\n`, "utf8");

    await expect(
      executeBuiltinFileTool("grep", { path: "chapters/长行.txt", pattern: "prefix" }, { ...context, maxPreviewChars: 12 })
    ).resolves.toMatchObject({
      matches: [{ path: "chapters/长行.txt", line: 1, text: "prefix-xxxxx" }]
    });
  });

  it("rejects recursive grep when the file count budget is exceeded", async () => {
    const context = makeContext();
    fs.writeFileSync(path.join(context.projectRoot, "chapters", "第二章.txt"), "凝气丹\n", "utf8");

    await expect(executeBuiltinFileTool("grep", { path: "chapters", pattern: "凝气丹" }, { ...context, maxGrepFiles: 1 })).rejects.toMatchObject({
      name: "ToolExecutionError",
      code: "INVALID_ARGUMENTS"
    });
  });

  it("rejects recursive grep when the total byte budget is exceeded", async () => {
    const context = makeContext();

    await expect(executeBuiltinFileTool("grep", { path: "chapters", pattern: "凝气丹" }, { ...context, maxGrepTotalBytes: 4 })).rejects.toMatchObject({
      name: "ToolExecutionError",
      code: "INVALID_ARGUMENTS"
    });
  });

  it("rejects grep when the match budget is exceeded", async () => {
    const context = makeContext();
    fs.writeFileSync(path.join(context.projectRoot, "chapters", "重复.txt"), "凝气丹\n凝气丹\n", "utf8");

    await expect(executeBuiltinFileTool("grep", { path: "chapters/重复.txt", pattern: "凝气丹" }, { ...context, maxGrepMatches: 1 })).rejects.toMatchObject({
      name: "ToolExecutionError",
      code: "INVALID_ARGUMENTS"
    });
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

    await expect(executeBuiltinFileTool("edit_file", { path: "丹药分析.md", oldText: "missing", newText: "x" }, context)).rejects.toSatisfy(
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
      executeBuiltinFileTool("edit_file", { path: "linked.md", oldText: "EXTERNAL_SECRET_BETA", newText: "x" }, context)
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
      executeBuiltinFileTool("multi_edit", { path: "丹药分析.md", edits: [{ oldText: "missing", newText: "x" }] }, context)
    ).rejects.toSatisfy((error: unknown) => {
      expectToolExecutionErrorCode(error, "INVALID_ARGUMENTS");
      return true;
    });
  });
});
