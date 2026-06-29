import { describe, expect, it } from "vitest";
import { classifyToolEffects, isReadTool, isWriteTool } from "./toolPolicy";

describe("tool policy", () => {
  it("classifies reads and writes for ordered execution", () => {
    expect(classifyToolEffects("ls")).toBe("read");
    expect(classifyToolEffects("read_file")).toBe("read");
    expect(classifyToolEffects("grep")).toBe("read");
    expect(classifyToolEffects("write_file")).toBe("write");
    expect(classifyToolEffects("edit_file")).toBe("write");
    expect(classifyToolEffects("multi_edit")).toBe("write");
  });

  it("offers helpers for runtime scheduling", () => {
    expect(isReadTool("grep")).toBe(true);
    expect(isReadTool("write_file")).toBe(false);
    expect(isWriteTool("multi_edit")).toBe(true);
    expect(isWriteTool("read_file")).toBe(false);
  });

  it("fails clearly for unknown tools", () => {
    expect(() => classifyToolEffects("missing")).toThrow(/Unknown tool: missing/u);
  });
});
