import { describe, expect, it } from "vitest";
import { getEnabledTools } from "./toolRegistry";

describe("P0 tool registry", () => {
  it("exposes the configured Reasonix tools in deterministic order", () => {
    expect(
      getEnabledTools([
        "read_file",
        "write_file",
        "edit_file",
        "multi_edit",
        "read_report_excerpt",
        "upsert_report_section",
        "grep",
        "glob",
        "ls",
        "bash",
        "bash_output",
        "wait",
        "kill_shell",
        "mark_no_update"
      ]).map((tool) => tool.name)
    ).toEqual([
      "read_file",
      "write_file",
      "edit_file",
      "multi_edit",
      "read_report_excerpt",
      "upsert_report_section",
      "grep",
      "glob",
      "ls",
      "bash",
      "bash_output",
      "wait",
      "kill_shell",
      "mark_no_update"
    ]);
  });

  it("filters enabled tools while preserving configured order", () => {
    expect(getEnabledTools(["multi_edit", "grep", "ls"]).map((tool) => tool.name)).toEqual(["multi_edit", "grep", "ls"]);
  });

  it("exposes Reasonix JSON Schema parameter definitions for tool calling", () => {
    const tools = getEnabledTools([
      "read_file",
      "edit_file",
      "multi_edit",
      "bash_output",
      "wait",
      "mark_no_update",
      "read_report_excerpt",
      "upsert_report_section"
    ]);

    expect(tools[0].parameters).toMatchObject({
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer" },
        limit: { type: "integer" }
      },
      required: ["path"]
    });
    expect(tools[1].parameters).toMatchObject({
      type: "object",
      properties: {
        old_string: { type: "string" },
        new_string: { type: "string" }
      },
      required: ["path", "old_string", "new_string"]
    });
    expect(JSON.stringify(tools[2].parameters)).toContain("replace_all");
    expect(tools[3].parameters).toMatchObject({
      type: "object",
      properties: {
        job_id: { type: "string" }
      },
      required: ["job_id"]
    });
    expect(JSON.stringify(tools[4].parameters)).toContain("timeout_seconds");
    expect(tools[5].parameters).toMatchObject({
      type: "object",
      properties: {
        path: { type: "string" },
        reason: { type: "string" }
      },
      required: ["path", "reason"],
      additionalProperties: false
    });
    expect(tools[6].parameters).toMatchObject({
      type: "object",
      properties: {
        outputFileName: { type: "string" },
        keywords: { type: "array", items: { type: "string" } },
        maxChars: { type: "integer" }
      },
      required: ["outputFileName", "keywords"],
      additionalProperties: false
    });
    expect(tools[7].parameters).toMatchObject({
      type: "object",
      properties: {
        outputFileName: { type: "string" },
        sectionId: { type: "string" },
        content: { type: "string" },
        writeMode: { enum: ["replace_section", "append_to_section", "append_to_end"] }
      },
      required: ["outputFileName", "content", "writeMode"],
      additionalProperties: false
    });
    expect(JSON.stringify(tools[7].parameters)).not.toContain("old_string");
  });

  it("describes read_report_excerpt as keyword-based report excerpt reading", () => {
    const [tool] = getEnabledTools(["read_report_excerpt"]);

    expect(tool.description).toContain("关键词");
    expect(tool.description).toContain("相关段落");
  });

  it("describes upsert_report_section as section-based report writing without old_string", () => {
    const [tool] = getEnabledTools(["upsert_report_section"]);

    expect(tool.description).toContain("section id");
    expect(tool.description).toContain("old_string");
    expect(tool.description).toContain("append_to_end");
  });

  it("describes mark_no_update as recording an outcome without writing a report", () => {
    const [markNoUpdateTool] = getEnabledTools(["mark_no_update"]);

    expect(markNoUpdateTool.description).toContain("Record that a selected report has no new information");
    expect(markNoUpdateTool.description).not.toContain("Create");
  });

  it("describes write_file with the Reasonix overwrite semantics", () => {
    const [writeFileTool] = getEnabledTools(["write_file"]);

    expect(writeFileTool.description).toContain("overwriting existing content");
  });

  it("surfaces the Reasonix report-inventory guidance in registry descriptions", () => {
    const tools = getEnabledTools(["glob", "ls", "bash", "read_file"]);

    expect(tools.find((tool) => tool.name === "glob")?.description).toContain("报告是否存在已由宿主清单提供");
    expect(tools.find((tool) => tool.name === "ls")?.description).toContain("不要用 glob/ls/bash 查找报告");
    expect(tools.find((tool) => tool.name === "bash")?.description).toContain("不要用 glob/ls/bash 查找报告");
    expect(tools.find((tool) => tool.name === "read_file")?.description).toContain(
      "需要读已有报告时后续任务会走关键词检索/相关段落"
    );
  });

  it("fails clearly for unknown tool names", () => {
    expect(() => getEnabledTools(["read_file", "unknown_tool"])).toThrow(/Unknown tool: unknown_tool/u);
  });
});
