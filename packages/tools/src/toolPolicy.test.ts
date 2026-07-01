import { describe, expect, it } from "vitest";
import { classifyToolEffects, isReadTool, isWriteTool } from "./toolPolicy";

describe("tool policy", () => {
  it("classifies reads and writes for ordered execution", () => {
    expect(classifyToolEffects("read_file")).toBe("read");
    expect(classifyToolEffects("grep")).toBe("read");
    expect(classifyToolEffects("glob")).toBe("read");
    expect(classifyToolEffects("ls")).toBe("read");
    expect(classifyToolEffects("bash_output")).toBe("read");
    expect(classifyToolEffects("wait")).toBe("read");
    expect(classifyToolEffects("write_file")).toBe("write");
    expect(classifyToolEffects("edit_file")).toBe("write");
    expect(classifyToolEffects("multi_edit")).toBe("write");
    expect(classifyToolEffects("bash")).toBe("write");
    expect(classifyToolEffects("kill_shell")).toBe("write");
    expect(classifyToolEffects("mark_no_update")).toBe("state");
  });

  it("offers helpers for runtime scheduling", () => {
    expect(isReadTool("grep")).toBe(true);
    expect(isReadTool("bash_output")).toBe(true);
    expect(isReadTool("wait")).toBe(true);
    expect(isReadTool("write_file")).toBe(false);
    expect(isWriteTool("multi_edit")).toBe(true);
    expect(isWriteTool("bash")).toBe(true);
    expect(isWriteTool("kill_shell")).toBe(true);
    expect(isWriteTool("read_file")).toBe(false);
    expect(isReadTool("bash")).toBe(false);
    expect(isReadTool("mark_no_update")).toBe(false);
    expect(isWriteTool("mark_no_update")).toBe(false);
  });

  it("fails clearly for unknown tools", () => {
    expect(() => classifyToolEffects("missing")).toThrow(/Unknown tool: missing/u);
  });
});
