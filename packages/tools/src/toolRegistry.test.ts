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
    const tools = getEnabledTools(["read_file", "edit_file", "multi_edit", "bash_output", "wait", "mark_no_update"]);

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

  it("fails clearly for unknown tool names", () => {
    expect(() => getEnabledTools(["read_file", "unknown_tool"])).toThrow(/Unknown tool: unknown_tool/u);
  });
});
