import { describe, expect, it } from "vitest";
import { getEnabledTools } from "./toolRegistry";

describe("P0 tool registry", () => {
  it("exposes the configured file tools in deterministic order", () => {
    expect(
      getEnabledTools(["ls", "read_file", "grep", "write_file", "edit_file", "multi_edit", "mark_no_update"]).map(
        (tool) => tool.name
      )
    ).toEqual(["ls", "read_file", "grep", "write_file", "edit_file", "multi_edit", "mark_no_update"]);
  });

  it("filters enabled tools while preserving registry order", () => {
    expect(getEnabledTools(["multi_edit", "grep", "ls"]).map((tool) => tool.name)).toEqual(["ls", "grep", "multi_edit"]);
  });

  it("exposes JSON Schema parameter definitions for tool calling", () => {
    const tools = getEnabledTools(["read_file", "write_file", "mark_no_update"]);

    expect(tools[0].parameters).toMatchObject({
      type: "object",
      properties: {
        path: { type: "string" }
      },
      required: ["path"],
      additionalProperties: false
    });
    expect(tools[1].parameters).toMatchObject({
      type: "object",
      required: ["path", "content"],
      additionalProperties: false
    });
    expect(tools[2].parameters).toMatchObject({
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

  it("describes write_file as creating new reports instead of overwriting existing reports", () => {
    const [writeFileTool] = getEnabledTools(["write_file"]);

    expect(writeFileTool.description).toContain("Create a new Markdown report file");
    expect(writeFileTool.description).not.toContain("overwrite");
  });

  it("fails clearly for unknown tool names", () => {
    expect(() => getEnabledTools(["read_file", "unknown_tool"])).toThrow(/Unknown tool: unknown_tool/u);
  });
});
