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

export type ToolLoopRoundReason =
  | "report_discovery_rejected"
  | "old_report_relevant_sections_needed"
  | "edit_anchor_failed"
  | "tool_arguments_invalid"
  | "missing_template_outcome"
  | "unknown_tool_recovered";

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

export const TOOL_LOOP_ROUND_REASON_LABELS: Record<ToolLoopRoundReason, string> = {
  report_discovery_rejected: "报告查找方式被拒绝",
  old_report_relevant_sections_needed: "旧报告需要相关段落",
  edit_anchor_failed: "报告锚点未命中",
  tool_arguments_invalid: "工具参数或路径无效",
  missing_template_outcome: "缺失模板处理结果",
  unknown_tool_recovered: "未知工具已转为可恢复错误"
};

export const READ_TOOL_SCOPE_DENIED_MESSAGE = "读工具路径不在当前窗口允许范围内。";
export const BASH_TOOL_SCOPE_DENIED_MESSAGE = "bash 命令路径不在当前窗口允许范围内。";

const REPORT_INVENTORY_ALREADY_PROVIDED_MESSAGE_PREFIX = "报告清单已提供";
const REPLACEMENT_TEXT_NOT_FOUND_MESSAGE = "old_string not found";
const REPLACEMENT_TEXT_NOT_UNIQUE_MESSAGE = "old_string is not unique";
const FILE_LARGER_THAN_MAX_READ_BYTES_MESSAGE = "File is larger than maxReadBytes";
const TOOL_ARGUMENTS_MUST_BE_OBJECT_MESSAGE = "Tool arguments must be an object";
const UNEXPECTED_TOOL_ARGUMENT_MESSAGE_PREFIX = "Unexpected argument: ";

const DESKTOP_READ_SCOPE_TOOL_NAMES = new Set(["read_file", "grep", "glob", "ls"]);
const REPORT_WRITE_TOOL_NAMES = new Set(["write_file", "edit_file", "multi_edit", "upsert_report_section"]);
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

  if (error.code === "SECTION_NOT_FOUND") {
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

export function classifyToolLoopRoundReason(input: {
  allowedOutputFileNames?: ReadonlySet<string>;
  classification: ToolErrorClassification;
  error?: ToolExecutionError;
  executionArguments?: unknown;
  toolName: string;
}): ToolLoopRoundReason | undefined {
  if (!input.classification.recoverableByModel) {
    return undefined;
  }

  if (input.classification.reason === "tool_not_enabled") {
    return "unknown_tool_recovered";
  }

  if (input.classification.reason === "read_tool_scope_denied") {
    return isReportDiscoveryReadScopeDenial(input.toolName, input.executionArguments, input.allowedOutputFileNames)
      ? "report_discovery_rejected"
      : undefined;
  }

  if (
    input.toolName === "bash" &&
    input.classification.reason === "bash_tool_scope_denied" &&
    isReportInventoryAlreadyProvidedError(input.error)
  ) {
    return "report_discovery_rejected";
  }

  if (
    (input.toolName === "edit_file" || input.toolName === "multi_edit") &&
    (input.classification.reason === "replacement_text_not_found" ||
      input.classification.reason === "replacement_text_not_unique")
  ) {
    return "edit_anchor_failed";
  }

  if (
    input.toolName === "read_file" &&
    input.classification.reason === "read_tool_invalid_arguments" &&
    isOldReportRelevantSectionError(input.error) &&
    isAllowedOutputTarget(input.executionArguments, input.allowedOutputFileNames)
  ) {
    return "old_report_relevant_sections_needed";
  }

  if (
    input.classification.reason === "tool_schema_invalid_arguments" ||
    input.classification.reason === "read_tool_invalid_arguments" ||
    input.classification.reason === "tool_invalid_arguments" ||
    input.classification.reason === "write_tool_scope_denied" ||
    input.classification.reason === "bash_tool_scope_denied"
  ) {
    return "tool_arguments_invalid";
  }

  return undefined;
}

function isReportDiscoveryReadScopeDenial(
  toolName: string,
  executionArguments: unknown,
  allowedOutputFileNames: ReadonlySet<string> | undefined
): boolean {
  if (toolName === "glob") {
    const pattern = getStringArgument(executionArguments, "pattern");
    return pattern !== undefined && isReportDiscoveryTarget(pattern, allowedOutputFileNames);
  }

  if (toolName === "ls") {
    const pathValue = getStringArgument(executionArguments, "path");
    return pathValue !== undefined && isReportsDirectoryTarget(pathValue);
  }

  return false;
}

function isReportInventoryAlreadyProvidedError(error: ToolExecutionError | undefined): boolean {
  return error !== undefined && error.message.startsWith(REPORT_INVENTORY_ALREADY_PROVIDED_MESSAGE_PREFIX);
}

function isReportDiscoveryTarget(
  target: string,
  allowedOutputFileNames: ReadonlySet<string> | undefined
): boolean {
  const comparable = normalizeToolPath(target);
  if (
    comparable.startsWith("reports/") ||
    comparable.includes("/reports/") ||
    comparable.endsWith("/reports") ||
    comparable === "reports"
  ) {
    return true;
  }

  if (allowedOutputFileNames) {
    for (const outputFileName of allowedOutputFileNames) {
      if (comparable === outputFileName || comparable.endsWith(`/${outputFileName}`)) {
        return true;
      }
    }
  }

  return false;
}

function isReportsDirectoryTarget(target: string): boolean {
  const comparable = normalizeToolPath(target);
  return comparable === "reports" || comparable.endsWith("/reports") || comparable.includes("/reports/");
}

function isOldReportRelevantSectionError(error: ToolExecutionError | undefined): boolean {
  return (
    error !== undefined &&
    (GREP_BUDGET_ERROR_MESSAGES.has(error.message) ||
      (error.message.includes("read_report_excerpt") && error.message.includes("关键词检索相关段落")))
  );
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

function isAllowedOutputTarget(
  executionArguments: unknown,
  allowedOutputFileNames: ReadonlySet<string> | undefined
): boolean {
  if (!allowedOutputFileNames || allowedOutputFileNames.size === 0) {
    return false;
  }

  const pathValue =
    getStringArgument(executionArguments, "path");
  if (!pathValue) {
    return false;
  }

  const comparable = normalizeToolPath(pathValue);
  for (const outputFileName of allowedOutputFileNames) {
    if (comparable === outputFileName || comparable.endsWith(`/${outputFileName}`)) {
      return true;
    }
  }
  return false;
}

function getStringArgument(executionArguments: unknown, key: string): string | undefined {
  return executionArguments !== null &&
    typeof executionArguments === "object" &&
    !Array.isArray(executionArguments) &&
    typeof (executionArguments as Record<string, unknown>)[key] === "string"
    ? ((executionArguments as Record<string, unknown>)[key] as string)
    : undefined;
}

function normalizeToolPath(value: string): string {
  return value.replace(/\\/gu, "/");
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
