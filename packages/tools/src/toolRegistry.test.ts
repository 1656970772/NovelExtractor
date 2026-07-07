import { describe, expect, it } from "vitest";
import {
  getEnabledToolDefinitions,
  getEnabledTools,
  normalizeToolArgumentsForSchema,
  validateToolArguments
} from "./toolRegistry";

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
    const upsertTool = tools.find((tool) => tool.name === "upsert_report_section");
    expect(upsertTool?.parameters).toMatchObject({
      type: "object",
      properties: {
        outputFileName: { type: "string" },
        updates: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["cardName", "content"],
            additionalProperties: false,
            properties: {
              operation: { type: "string", enum: ["add_card", "add_field", "replace_field"] },
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
    const upsertParameters = upsertTool?.parameters as
      | {
          properties: {
            updates: {
              description?: string;
              items: {
                properties: {
                  content: { description?: string };
                };
              };
            };
          };
        }
      | undefined;
    const updatesSchema = upsertParameters?.properties.updates;
    const contentSchema = updatesSchema?.items.properties.content;
    expect(updatesSchema?.description).toContain("add_card");
    expect(updatesSchema?.description).toContain("add_field");
    expect(updatesSchema?.description).toContain("replace_field");
    expect(updatesSchema?.description).not.toContain("要替换的字段块数组");
    expect(contentSchema?.description).toMatch(/add_card|卡片/u);
    expect(contentSchema?.description).not.toContain("必须以 - 字段名");
    expect(JSON.stringify(upsertTool?.parameters)).not.toContain("old_string");
    expect(JSON.stringify(upsertTool?.parameters)).not.toContain("sectionId");
    expect(JSON.stringify(upsertTool?.parameters)).not.toContain("writeMode");
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

  it("normalizes JSON-stringified container fields according to schema", () => {
    const schema = {
      type: "object",
      properties: {
        updates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              cardName: { type: "string" },
              tags: { type: "array", items: { type: "string" } }
            }
          }
        },
        rawText: { type: "string" }
      }
    };

    expect(
      normalizeToolArgumentsForSchema(schema, {
        updates: JSON.stringify([{ cardName: "韩立", tags: JSON.stringify(["谨慎"]) }]),
        rawText: JSON.stringify(["保持字符串"])
      })
    ).toEqual({
      updates: [{ cardName: "韩立", tags: ["谨慎"] }],
      rawText: "[\"保持字符串\"]"
    });

    expect(normalizeToolArgumentsForSchema(schema, { updates: "韩立,核心性格" })).toEqual({
      updates: "韩立,核心性格"
    });
  });

  it("normalizes concatenated JSON object arguments by merging object chunks", () => {
    const schema = {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" }
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false
    };

    expect(
      normalizeToolArgumentsForSchema(
        schema,
        '{}{"path":"[报告]NPC性格与代表事件.md","old_string":"- 核心性格：旧内容。","new_string":"- 核心性格：谨慎行事。"}'
      )
    ).toEqual({
      path: "[报告]NPC性格与代表事件.md",
      old_string: "- 核心性格：旧内容。",
      new_string: "- 核心性格：谨慎行事。"
    });

    expect(
      normalizeToolArgumentsForSchema(
        schema,
        '{"path":"[报告]NPC性格与代表事件.md"}{"old_string":"旧","new_string":"新"}'
      )
    ).toEqual({
      path: "[报告]NPC性格与代表事件.md",
      old_string: "旧",
      new_string: "新"
    });
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

    expect(tool.description).toContain("add_card");
    expect(tool.description).toContain("add_field");
    expect(tool.description).toContain("replace_field");
    expect(tool.description).toContain("已存在");
    expect(tool.description).not.toContain("不隐式" + "创建新卡片或新字段");
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
      "读取已有报告时，优先根据 grep 命中行用 offset/limit 读取必要上下文"
    );
  });

  it("fails clearly for unknown tool names", () => {
    expect(() => getEnabledTools(["read_file", "unknown_tool"])).toThrow(/Unknown tool: unknown_tool/u);
  });
});
