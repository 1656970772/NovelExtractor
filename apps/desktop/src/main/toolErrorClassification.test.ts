import { describe, expect, it } from "vitest";
import { ToolExecutionError } from "@novel-extractor/tools";
import {
  classifyToolExecutionError,
  fingerprintRecoverableToolError,
  REPLACEMENT_TEXT_NOT_UNIQUE_HINT,
  type ToolErrorClassification
} from "./toolErrorClassification";

function classify(toolName: string, error: unknown): ToolErrorClassification {
  return classifyToolExecutionError({ toolName, error });
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
      hint: REPLACEMENT_TEXT_NOT_UNIQUE_HINT,
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
      reason: "read_tool_scope_denied"
    });
  });

  it("classifies bash failures with output as recoverable by the model", () => {
    const error = new ToolExecutionError("command exited with status 2", "IO_ERROR", "stderr: bad flag");

    expect(classify("bash", error)).toMatchObject({
      category: "recoverable_by_model",
      reason: "bash_runtime_failure"
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
