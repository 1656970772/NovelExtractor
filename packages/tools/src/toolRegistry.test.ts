import { describe, expect, it } from "vitest";
import { getEnabledToolDefinitions, getEnabledTools, validateToolArguments } from "./toolRegistry";

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
        queries: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["cardName", "fields"],
            additionalProperties: false,
            properties: {
              cardName: { type: "string" },
              fields: { type: "array", minItems: 1, items: { type: "string" } }
            }
          }
        },
        maxChars: { type: "integer", minimum: 500, maximum: 20000 }
      },
      required: ["outputFileName", "queries"],
      additionalProperties: false
    });
    expect(tools[7].parameters).toMatchObject({
      type: "object",
      properties: {
        outputFileName: { type: "string" },
        updates: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["cardName", "fieldName", "content"],
            additionalProperties: false,
            properties: {
              cardName: { type: "string" },
              fieldName: { type: "string" },
              content: { type: "string" }
            }
          }
        }
      },
      required: ["outputFileName", "updates"],
      additionalProperties: false
    });
    expect(JSON.stringify(tools[7].parameters)).not.toContain("old_string");
    expect(JSON.stringify(tools[7].parameters)).not.toContain("sectionId");
    expect(JSON.stringify(tools[7].parameters)).not.toContain("writeMode");
  });

  it("describes read_report_excerpt as card field block reading", () => {
    const [tool] = getEnabledTools(["read_report_excerpt"]);

    expect(tool.description).toContain("卡片字段块");
    expect(tool.description).toContain("cardName");
    expect(tool.description).toContain("fields");
  });

  it("exposes canonical tool definition sources without OpenAI wrappers", () => {
    const [tool] = getEnabledToolDefinitions(["upsert_report_section"]);

    expect(tool).toMatchObject({
      name: "upsert_report_section",
      description: expect.stringContaining("字段块"),
      inputSchema: {
        type: "object",
        properties: {
          updates: {
            type: "array",
            items: { type: "object" }
          }
        }
      }
    });
    expect(JSON.stringify(tool)).not.toContain("\"function\"");
    expect(JSON.stringify(tool)).not.toContain("\"parameters\"");
    expect(getEnabledTools(["upsert_report_section"])[0].parameters).toEqual(tool.inputSchema);
  });

  it("reports nested array schema violations with stable paths", () => {
    const errors = validateToolArguments(
      {
        type: "object",
        properties: {
          updates: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                cardName: { type: "string" },
                fieldName: { type: "string" },
                content: { type: "string" }
              },
              required: ["cardName", "fieldName", "content"],
              additionalProperties: false
            }
          }
        },
        required: ["updates"],
        additionalProperties: false
      },
      { updates: "韩立,核心性格" }
    );

    expect(errors).toEqual([{ path: "$.updates", message: "必须是数组" }]);
  });

  it("reports missing required fields and extra object fields", () => {
    const errors = validateToolArguments(
      {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false
      },
      { extra: true }
    );

    expect(errors).toEqual([
      { path: "$.path", message: "缺少必填字段" },
      { path: "$.extra", message: "不允许额外字段" }
    ]);
  });

  it("reports numeric minimum and maximum violations used by current tool schemas", () => {
    const errors = validateToolArguments(
      {
        type: "object",
        properties: {
          offset: { type: "integer", minimum: 0 },
          maxChars: { type: "integer", minimum: 500, maximum: 20000 }
        }
      },
      { offset: -1, maxChars: 30000 }
    );

    expect(errors).toEqual([
      { path: "$.offset", message: "不能小于 0" },
      { path: "$.maxChars", message: "不能大于 20000" }
    ]);
  });

  it("describes upsert_report_section as field-block writing without old_string", () => {
    const [tool] = getEnabledTools(["upsert_report_section"]);

    expect(tool.description).toContain("字段块");
    expect(tool.description).toContain("fieldName");
    expect(tool.description).toContain("old_string");
    expect(tool.description).toContain("sectionId");
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
      "需要读已有报告时后续任务会走卡片字段块读取"
    );
  });

  it("fails clearly for unknown tool names", () => {
    expect(() => getEnabledTools(["read_file", "unknown_tool"])).toThrow(/Unknown tool: unknown_tool/u);
  });
});
