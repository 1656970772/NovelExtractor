import { describe, expect, it } from "vitest";
import { ToolExecutionError } from "@novel-extractor/tools";
import {
  classifyToolExecutionError,
  fingerprintRecoverableToolError,
  type ToolErrorClassification
} from "./toolErrorClassification";

const RECOVERABLE_HINTS = {
  replacement_text_not_found: "old_string 必须精确匹配文件中的原文。",
  replacement_text_not_unique: "old_string 在文件中匹配到多处。",
  read_tool_target_not_found: "读取目标不存在。",
  read_tool_scope_denied: "读工具路径不在允许范围内。",
  bash_tool_scope_denied: "bash 路径不在允许范围内。",
  write_tool_scope_denied: "写工具路径不在允许范围内。",
  bash_runtime_failure: "bash 命令执行失败。",
  tool_schema_invalid_arguments: "工具参数结构不符合 schema。",
  read_tool_invalid_arguments: "读取工具参数无效。",
  edit_target_not_found: "目标报告不存在。",
  tool_not_enabled: "只能调用工具清单中列出的工具。",
  tool_invalid_arguments: "工具参数无效。"
};

function classify(toolName: string, error: unknown): ToolErrorClassification {
  return classifyToolExecutionError({
    toolName,
    error,
    hints: RECOVERABLE_HINTS
  });
}

describe("tool error classification", () => {
  it("classifies edit_file old_string not unique as recoverable by the model", () => {
    const result = classify(
      "edit_file",
      new ToolExecutionError("old_string is not unique in report.md (5 matches); add more surrounding context", "INVALID_ARGUMENTS")
    );

    expect(result).toEqual({
      category: "recoverable_by_model",
      recoverableByModel: true,
      hint: RECOVERABLE_HINTS.replacement_text_not_unique,
      reason: "replacement_text_not_unique"
    });
  });

  it("classifies multi_edit old_string not found as recoverable by the model", () => {
    const result = classify(
      "multi_edit",
      new ToolExecutionError("edit 1: old_string not found", "INVALID_ARGUMENTS")
    );

    expect(result.category).toBe("recoverable_by_model");
    expect(result.recoverableByModel).toBe(true);
    expect(result.reason).toBe("replacement_text_not_found");
  });

  it("classifies read scope and missing file errors as recoverable by the model", () => {
    expect(classify("read_file", new ToolExecutionError("Path does not exist", "NOT_FOUND"))).toMatchObject({
      category: "recoverable_by_model",
      reason: "read_tool_target_not_found"
    });
    expect(classify("grep", new ToolExecutionError("Path is outside allowed root", "UNSAFE_PATH"))).toMatchObject({
      category: "recoverable_by_model",
      hint: RECOVERABLE_HINTS.read_tool_scope_denied,
      reason: "read_tool_scope_denied"
    });
  });

  it("returns configured hints for recoverable errors that need model correction", () => {
    expect(classify("write_file", new ToolExecutionError("Path is outside allowed root", "UNSAFE_PATH"))).toMatchObject({
      category: "recoverable_by_model",
      hint: RECOVERABLE_HINTS.write_tool_scope_denied,
      reason: "write_tool_scope_denied"
    });
    expect(classify("write_file", new ToolExecutionError("content must be a string", "INVALID_ARGUMENTS"))).toMatchObject({
      category: "recoverable_by_model",
      hint: RECOVERABLE_HINTS.tool_schema_invalid_arguments,
      reason: "tool_schema_invalid_arguments"
    });
    expect(classify("write_file", new ToolExecutionError("invalid but model-correctable", "INVALID_ARGUMENTS"))).toMatchObject({
      category: "recoverable_by_model",
      hint: RECOVERABLE_HINTS.tool_invalid_arguments,
      reason: "tool_invalid_arguments"
    });
  });

  it("classifies bash failures with output as recoverable by the model", () => {
    const error = new ToolExecutionError("command exited with status 2", "IO_ERROR", "stderr: bad flag");

    expect(classify("bash", error)).toMatchObject({
      category: "recoverable_by_model",
      reason: "bash_runtime_failure"
    });
  });

  it("classifies model calls to unknown tool names as recoverable by the model", () => {
    const error = new ToolExecutionError("Tool is not enabled: pwd", "UNKNOWN_TOOL");

    expect(classify("pwd", error)).toEqual({
      category: "recoverable_by_model",
      recoverableByModel: true,
      hint: RECOVERABLE_HINTS.tool_not_enabled,
      reason: "tool_not_enabled"
    });
  });

  it("keeps non-bash IO errors as resource failures", () => {
    expect(classify("write_file", new ToolExecutionError("EACCES: permission denied", "IO_ERROR"))).toEqual({
      category: "resource_failure",
      recoverableByModel: false,
      reason: "tool_resource_failure"
    });
  });

  it("keeps non ToolExecutionError exceptions as system failures", () => {
    expect(classify("edit_file", new Error("Cannot read properties of undefined"))).toEqual({
      category: "system_failure",
      recoverableByModel: false,
      reason: "unexpected_exception"
    });
  });

  it("builds a stable fingerprint for repeated recoverable errors", () => {
    const error = new ToolExecutionError("old_string is not unique in report.md (5 matches); add more surrounding context", "INVALID_ARGUMENTS");

    expect(
      fingerprintRecoverableToolError({
        toolName: "edit_file",
        error,
        path: "事件因果链（长程因果图）.md"
      })
    ).toBe("edit_file|INVALID_ARGUMENTS|old_string is not unique in report.md (5 matches); add more surrounding context|事件因果链（长程因果图）.md");
  });
});
