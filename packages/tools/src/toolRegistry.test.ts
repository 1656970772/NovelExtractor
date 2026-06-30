import { describe, expect, it } from "vitest";
import { getEnabledTools } from "./toolRegistry";

describe("P0 tool registry", () => {
  it("exposes the configured file tools in deterministic order", () => {
    expect(getEnabledTools(["ls", "read_file", "grep", "write_file", "edit_file", "multi_edit"]).map((tool) => tool.name)).toEqual([
      "ls",
      "read_file",
      "grep",
      "write_file",
      "edit_file",
      "multi_edit"
    ]);
  });

  it("filters enabled tools while preserving registry order", () => {
    expect(getEnabledTools(["multi_edit", "grep", "ls"]).map((tool) => tool.name)).toEqual(["ls", "grep", "multi_edit"]);
  });

  it("exposes JSON Schema parameter definitions for tool calling", () => {
    const tools = getEnabledTools(["read_file", "write_file"]);

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
