import type { ToolRecoverableErrorHints } from "@novel-extractor/config/schema";
import { ToolExecutionError } from "@novel-extractor/tools";

export type ToolErrorCategory =
  | "recoverable_by_model"
  | "security_blocked"
  | "system_failure"
  | "resource_failure"
  | "repeated_failure";

export type RecoverableToolErrorReason =
  | "replacement_text_not_found"
  | "replacement_text_not_unique"
  | "read_tool_target_not_found"
  | "read_tool_scope_denied"
  | "bash_tool_scope_denied"
  | "write_tool_scope_denied"
  | "bash_runtime_failure"
  | "tool_schema_invalid_arguments"
  | "read_tool_invalid_arguments"
  | "edit_target_not_found"
  | "tool_not_enabled"
  | "tool_invalid_arguments";

export type ToolErrorReason =
  | RecoverableToolErrorReason
  | "secret_boundary"
  | "unexpected_exception"
  | "tool_resource_failure"
  | "unknown_tool"
  | "unclassified_tool_error"
  | "repeated_recoverable_tool_error";

export interface ToolErrorClassification {
  category: ToolErrorCategory;
  recoverableByModel: boolean;
  reason: ToolErrorReason;
  hint?: string;
}

export const READ_TOOL_SCOPE_DENIED_MESSAGE = "读工具路径不在当前窗口允许范围内。";
export const BASH_TOOL_SCOPE_DENIED_MESSAGE = "bash 命令路径不在当前窗口允许范围内。";

const REPLACEMENT_TEXT_NOT_FOUND_MESSAGE = "old_string not found";
const REPLACEMENT_TEXT_NOT_UNIQUE_MESSAGE = "old_string is not unique";
const FILE_LARGER_THAN_MAX_READ_BYTES_MESSAGE = "File is larger than maxReadBytes";
const TOOL_ARGUMENTS_MUST_BE_OBJECT_MESSAGE = "Tool arguments must be an object";
const UNEXPECTED_TOOL_ARGUMENT_MESSAGE_PREFIX = "Unexpected argument: ";

const DESKTOP_READ_SCOPE_TOOL_NAMES = new Set(["read_file", "grep", "glob", "ls"]);
const REPORT_WRITE_TOOL_NAMES = new Set(["write_file", "edit_file", "multi_edit"]);
const GREP_BUDGET_ERROR_MESSAGES = new Set([
  FILE_LARGER_THAN_MAX_READ_BYTES_MESSAGE,
  "grep file budget exceeded",
  "grep total byte budget exceeded",
  "grep match budget exceeded"
]);
const TOOL_SCHEMA_STRING_ARGUMENT_ERROR_MESSAGES = new Set([
  "path must be a string",
  "content must be a string",
  "pattern must be a string",
  "old_string must be a string",
  "new_string must be a string",
  "reason must be a string"
]);

export function classifyToolExecutionError(input: {
  toolName: string;
  error: unknown;
  hints: ToolRecoverableErrorHints;
}): ToolErrorClassification {
  const { toolName, error, hints } = input;

  if (!(error instanceof ToolExecutionError)) {
    return {
      category: "system_failure",
      recoverableByModel: false,
      reason: "unexpected_exception"
    };
  }

  if (error.message.includes("secret")) {
    return {
      category: "security_blocked",
      recoverableByModel: false,
      reason: "secret_boundary"
    };
  }

  if (isReplacementTextNotFoundMessage(error.message)) {
    return recoverable("replacement_text_not_found", hints);
  }

  if (isReplacementTextNotUniqueMessage(error.message)) {
    return recoverable("replacement_text_not_unique", hints);
  }

  if (DESKTOP_READ_SCOPE_TOOL_NAMES.has(toolName) && error.code === "NOT_FOUND") {
    return recoverable("read_tool_target_not_found", hints);
  }

  if (DESKTOP_READ_SCOPE_TOOL_NAMES.has(toolName) && error.code === "UNSAFE_PATH") {
    return recoverable("read_tool_scope_denied", hints);
  }

  if (toolName === "bash" && error.code === "UNSAFE_PATH") {
    return recoverable("bash_tool_scope_denied", hints);
  }

  if (REPORT_WRITE_TOOL_NAMES.has(toolName) && error.code === "UNSAFE_PATH") {
    return recoverable("write_tool_scope_denied", hints);
  }

  if (
    toolName === "bash" &&
    error.code === "IO_ERROR" &&
    (error.output !== undefined || error.message.startsWith("command exited") || error.message.startsWith("command timed out"))
  ) {
    return recoverable("bash_runtime_failure", hints);
  }

  if (isRecoverableSchemaInvalidArguments(error)) {
    return recoverable("tool_schema_invalid_arguments", hints);
  }

  if (isRecoverableReadInvalidArguments(toolName, error)) {
    return recoverable("read_tool_invalid_arguments", hints);
  }

  if ((toolName === "edit_file" || toolName === "multi_edit") && error.code === "NOT_FOUND") {
    return recoverable("edit_target_not_found", hints);
  }

  if (error.code === "IO_ERROR") {
    return {
      category: "resource_failure",
      recoverableByModel: false,
      reason: "tool_resource_failure"
    };
  }

  if (error.code === "UNKNOWN_TOOL") {
    return recoverable("tool_not_enabled", hints);
  }

  if (error.code === "INVALID_ARGUMENTS") {
    return recoverable("tool_invalid_arguments", hints);
  }

  return {
    category: "system_failure",
    recoverableByModel: false,
    reason: "unclassified_tool_error"
  };
}

export function fingerprintRecoverableToolError(input: {
  toolName: string;
  error: ToolExecutionError;
  path?: string;
}): string {
  return [input.toolName, input.error.code, input.error.message, input.path ?? ""].join("|");
}

export function repeatedFailureClassification(): ToolErrorClassification {
  return {
    category: "repeated_failure",
    recoverableByModel: false,
    reason: "repeated_recoverable_tool_error"
  };
}

function recoverable(
  reason: RecoverableToolErrorReason,
  hints: ToolRecoverableErrorHints
): ToolErrorClassification {
  return {
    category: "recoverable_by_model",
    recoverableByModel: true,
    reason,
    hint: hints[reason]
  };
}

function isReplacementTextNotFoundMessage(message: string): boolean {
  return message.includes(REPLACEMENT_TEXT_NOT_FOUND_MESSAGE) || /^edit \d+: old_string not found/u.test(message);
}

function isReplacementTextNotUniqueMessage(message: string): boolean {
  return message.includes(REPLACEMENT_TEXT_NOT_UNIQUE_MESSAGE) || /^edit \d+: old_string is not unique/u.test(message);
}

function isRecoverableSchemaInvalidArguments(error: ToolExecutionError): boolean {
  if (error.code !== "INVALID_ARGUMENTS") {
    return false;
  }

  return (
    error.message.startsWith("invalid args:") ||
    error.message === "path is required" ||
    error.message === "old_string is required" ||
    error.message === "edits must not be empty" ||
    error.message === TOOL_ARGUMENTS_MUST_BE_OBJECT_MESSAGE ||
    TOOL_SCHEMA_STRING_ARGUMENT_ERROR_MESSAGES.has(error.message) ||
    error.message.startsWith(UNEXPECTED_TOOL_ARGUMENT_MESSAGE_PREFIX)
  );
}

function isRecoverableReadInvalidArguments(toolName: string, error: ToolExecutionError): boolean {
  if (error.code !== "INVALID_ARGUMENTS") {
    return false;
  }

  if (toolName === "read_file") {
    return true;
  }

  return toolName === "grep" && GREP_BUDGET_ERROR_MESSAGES.has(error.message);
}
