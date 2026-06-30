import fs from "node:fs/promises";
import path from "node:path";
import { getDefaultConfig, getProviderPresets } from "@novel-extractor/config";
import type { Book, Clock, IdGenerator, Project, ReportAsset } from "@novel-extractor/domain";
import {
  createJobRuntime,
  type FeeAmount,
  type JobLlmClient,
  type JobRunInput,
  type JobRuntimeResult,
  type JobRuntimeState,
  type JobWindowInput,
  type TokenUsage
} from "@novel-extractor/jobs";
import {
  createProviderRegistry,
  OpenAiCompatibleClient,
  type ChatCompletionMessage,
  type ChatCompletionRequestToolCall,
  type ChatCompletionResult,
  type CredentialStore as LlmCredentialStore,
  type FetchLike,
  type ToolCall,
  type ToolCallArguments,
  type ToolSchema as LlmToolSchema
} from "@novel-extractor/llm";
import type { RuntimeWindowManifest, RuntimeWindowManifestWindow } from "@novel-extractor/extraction/runtimeWindows";
import {
  executeBuiltinFileTool,
  getEnabledTools,
  isWriteTool,
  ToolExecutionError,
  type GrepResult,
  type ToolWriteSummary
} from "@novel-extractor/tools";
import type { TemplateDto } from "../shared/ipcTypes";
import { redactSecrets, type MemoryCredentialStore } from "./credentials";
import type { MainProviderStore } from "./providerStore";
import type { TaskTextLogger } from "./taskTextLogger";

interface WindowRunJobInput {
  id: string;
  bookId: string;
  input: {
    modelId: string;
    providerConfigId: string;
    templateIds: string[];
  };
}

export interface WindowRunArtifacts {
  book: Book;
  project: Project;
  runtimeWindowManifest: RuntimeWindowManifest;
  rulesSnapshotPath: string;
  templates: TemplateDto[];
}

export interface WindowRunServiceOptions {
  clock: Clock;
  credentialStore: MemoryCredentialStore;
  fetch?: FetchLike;
  findExistingReport(input: { bookId: string; fileName: string }): ReportAsset | undefined;
  idGenerator: IdGenerator;
  onRuntimeState(state: JobRuntimeState): Promise<void> | void;
  providerStore: MainProviderStore;
  registerReport(input: { path: string; report: ReportAsset }): void;
  taskLogger?: TaskTextLogger;
}

export interface WindowRunService {
  runJobWindows(input: {
    artifacts: WindowRunArtifacts;
    job: WindowRunJobInput;
  }): Promise<JobRuntimeResult>;
}

const NO_TOOL_FEE: FeeAmount = {
  amount: 0,
  currency: "CNY"
};
const REPLACEMENT_TEXT_NOT_FOUND_MESSAGE = "Replacement text was not found";

const TOOL_LOOP_DEFAULTS = getDefaultConfig().toolLoopDefaults;
const MAX_FULL_TEMPLATES_PER_CALL = getDefaultConfig().extractionRuleDefaults.maxFullTemplatesPerCall;
const ENABLED_TOOL_NAMES = TOOL_LOOP_DEFAULTS.enabledToolNames;
const ENABLED_TOOL_NAME_SET = new Set<string>(ENABLED_TOOL_NAMES);
const TOOL_SCHEMAS = getEnabledTools([...ENABLED_TOOL_NAMES]).map(toLlmToolSchema);
const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0
};
const TOOL_ARGUMENTS_MUST_BE_OBJECT_MESSAGE = "Tool arguments must be an object";
const UNEXPECTED_TOOL_ARGUMENT_MESSAGE_PREFIX = "Unexpected argument: ";
const TOOL_SCHEMA_STRING_ARGUMENT_ERROR_MESSAGES = new Set([
  "path must be a string",
  "content must be a string",
  "pattern must be a string",
  "oldText must be a string",
  "newText must be a string"
]);
const FILE_LARGER_THAN_MAX_READ_BYTES_MESSAGE = "File is larger than maxReadBytes";
const NO_TOOL_PROTOCOL_ERROR_MESSAGE =
  "tool loop 协议错误：无工具调用时必须返回 NO_UPDATE，或先通过写工具成功写入报告。";
const NO_TOOL_PROTOCOL_CORRECTION_MESSAGE =
  "上一轮没有调用任何工具，也没有成功写入报告，最终文本不是精确的 NO_UPDATE。\n" +
  "如果本窗口没有可写入的新信息，必须精确返回 NO_UPDATE；如果有可写入内容，必须先调用写工具写入正式报告。";
const WRITE_FILE_EXISTING_REPORT_MESSAGE =
  "已有报告不能用 write_file 覆盖；需先 read_file/grep 查询已有内容，再使用 edit_file/multi_edit 追加或修改。";
const WRITE_FILE_LOSSY_REWRITE_MESSAGE =
  "不能覆盖丢失既有内容，需要使用 edit_file/multi_edit 或包含完整旧内容。";
const REPLACEMENT_TEXT_NOT_FOUND_HINT =
  "oldText 必须精确匹配文件中的原文；可先用 grep/read_file 找到准确片段；若已 read_file 且需要整体更新，可用 write_file 提交完整保留旧内容的新版报告。";
const READ_TOOL_SCOPE_DENIED_MESSAGE = "read_file/grep 路径不在当前窗口允许范围内。";
const READ_TOOL_SCOPE_DENIED_HINT =
  "只能读取/搜索当前窗口文本、当前规则快照、当前书籍 reports 目录或本批选中输出报告；请改用窗口文件路径、规则快照路径、reports 或选中报告文件名。";
const REPORT_CONTENT_INTERNAL_METADATA_MESSAGE = "报告正文不得包含内部运行路径或流程性元数据。";
const REPORT_CONTENT_INTERNAL_METADATA_HINT =
  "请把资料来源、参考范围等公开元数据改写为窗口编号/章节范围、章节名或原文范围；不要写 runs/job、assets/books、本机绝对路径、AppData 项目路径或后续窗口等流程性措辞。";
const REPORT_CONTENT_WINDOW_FILE_IDENTIFIER_MESSAGE =
  "报告正文不得包含运行窗口文件名或内部窗口标识。";
const REPORT_CONTENT_WINDOW_FILE_IDENTIFIER_HINT =
  "请把 window-0001 等运行窗口文件名改写为“窗口 1（第1-2章）”、章节范围、章节名或原文范围；不要把运行窗口文件名写入最终 Markdown。";
const REPORT_CONTENT_DRAFT_OR_TEMPLATE_STATUS_MESSAGE = "报告正文不得包含模板或草案状态。";
const REPORT_CONTENT_DRAFT_OR_TEMPLATE_STATUS_HINT =
  "请把“状态：草案”或“状态：模板”改为“状态：原文已复核”“状态：已抽取”等非草案状态，或删除该状态行。";
const REPORT_CONTENT_INTERNAL_METADATA_PATTERNS: ReadonlyArray<{
  label: string;
  pattern: RegExp;
}> = [
  { label: "runs/job", pattern: /\bruns[\\/]+job-[^`)\]\s]*/iu },
  { label: "runs/<jobId>/windows", pattern: /\bruns[\\/]+[^\\/`)\]\s]+[\\/]+windows\b/iu },
  { label: "assets/books", pattern: /\bassets[\\/]+books[\\/]/iu },
  { label: "Windows 绝对路径", pattern: /[A-Za-z]:[\\/]/u },
  { label: "AppData 项目路径", pattern: /AppData[\\/]+Roaming[\\/]+@novel-extractor/iu },
  { label: "后续窗口", pattern: /后续窗口/u }
];
const REPORT_CONTENT_WINDOW_FILE_IDENTIFIER_PATTERN = /\bwindow-\d{4}\b/iu;
const REPORT_CONTENT_DRAFT_OR_TEMPLATE_STATUS_PATTERN = /状态：\s*(?:草案|模板)/u;
const GREP_BUDGET_ERROR_MESSAGES = new Set([
  FILE_LARGER_THAN_MAX_READ_BYTES_MESSAGE,
  "grep file budget exceeded",
  "grep total byte budget exceeded",
  "grep match budget exceeded"
]);
function getWindowMetadata(window: JobWindowInput): RuntimeWindowManifestWindow {
  const manifestWindow = window.metadata?.manifestWindow;
  if (!manifestWindow || typeof manifestWindow !== "object") {
    throw new Error(`Missing manifest metadata for window ${window.id}`);
  }
  return manifestWindow as RuntimeWindowManifestWindow;
}

function toJobWindowInputs(manifest: RuntimeWindowManifest): JobWindowInput[] {
  return manifest.windows.map((window) => ({
    id: window.windowId,
    chapterIds: [...window.submittedChapterTitles],
    metadata: {
      manifestWindow: window
    }
  }));
}

function mapUsage(usage: ChatCompletionResult["normalizedUsage"]): TokenUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens
  };
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens
  };
}

function chunkTemplates(templates: TemplateDto[], maxFullTemplatesPerCall: number): TemplateDto[][] {
  const batchSize = Math.max(1, Math.floor(maxFullTemplatesPerCall));
  const batches: TemplateDto[][] = [];
  for (let index = 0; index < templates.length; index += batchSize) {
    batches.push(templates.slice(index, index + batchSize));
  }
  return batches;
}

function toLlmToolSchema(tool: ReturnType<typeof getEnabledTools>[number]): LlmToolSchema {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as unknown as Record<string, unknown>
    }
  };
}

function toPromptDate(timestamp: string): string {
  return timestamp.match(/^\d{4}-\d{2}-\d{2}/u)?.[0] ?? timestamp;
}

function buildWindowPrompt(input: {
  artifacts: WindowRunArtifacts;
  currentDate: string;
  manifestWindow: RuntimeWindowManifestWindow;
  totalWindowCount: number;
  windowText: string;
}): string {
  const { artifacts, currentDate, manifestWindow, totalWindowCount, windowText } = input;
  const windowNumber = manifestWindow.index + 1;
  const templateSection = artifacts.templates
    .map((template) =>
      [
        `### ${template.name}`,
        `- templateId: ${template.id}`,
        `- outputFileName: ${template.fileName}`,
        "",
        template.body.trim()
      ].join("\n")
    )
    .join("\n\n");

  return [
    `小说：${artifacts.book.displayName}`,
    `书籍 ID：${artifacts.book.id}`,
    `规则快照路径：${artifacts.rulesSnapshotPath}`,
    `当前运行日期：${currentDate}`,
    `窗口序号：${windowNumber}/${totalWindowCount}`,
    `窗口文件：${manifestWindow.textPath}`,
    `read_file/grep 如需读取当前窗口文件，必须使用项目相对路径 ${manifestWindow.textPath}，不要使用裸文件名 ${manifestWindow.fileName}`,
    `上下文章节范围：${manifestWindow.contextChapterRange}`,
    `提交章节范围：${manifestWindow.submittedChapterRange}`,
    `上下文章节标题：${manifestWindow.contextChapterTitles.join("、")}`,
    `提交章节标题：${manifestWindow.submittedChapterTitles.join("、")}`,
    "",
    "请根据当前窗口文本和选中模板抽取信息，并使用文件工具写入或更新正式模板 Markdown。",
    ...TOOL_LOOP_DEFAULTS.windowInstructionLines,
    "",
    "## 选中模板",
    templateSection,
    "",
    "## 当前窗口文本",
    windowText.trim()
  ].join("\n");
}

function toReportDisplayName(fileName: string): string {
  return path.basename(fileName, path.extname(fileName));
}

function toReportsRoot(artifacts: WindowRunArtifacts): string {
  return path.join(artifacts.project.rootPath, "assets", "books", artifacts.book.id, "reports");
}

function toSafeErrorMessage(error: unknown, secrets: readonly string[] = []): string {
  return redactSecrets(error instanceof Error ? error.message : "窗口执行失败", secrets);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactJsonValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return redactSecrets(value, secrets);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item, secrets));
  }

  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactJsonValue(item, secrets)])
    );
  }

  return value;
}

function redactWritableToolArguments(name: string, args: unknown, secrets: readonly string[]): unknown {
  if (!isPlainRecord(args)) {
    return args;
  }

  if (name === "write_file" && typeof args.content === "string") {
    return {
      ...args,
      content: redactSecrets(args.content, secrets)
    };
  }

  if (name === "edit_file" && typeof args.newText === "string") {
    return {
      ...args,
      newText: redactSecrets(args.newText, secrets)
    };
  }

  if (name === "multi_edit" && Array.isArray(args.edits)) {
    return {
      ...args,
      edits: args.edits.map((edit) => {
        if (!isPlainRecord(edit) || typeof edit.newText !== "string") {
          return edit;
        }

        return {
          ...edit,
          newText: redactSecrets(edit.newText, secrets)
        };
      })
    };
  }

  return args;
}

function toToolCallArguments(value: unknown): ToolCallArguments {
  if (typeof value === "string") {
    const parsedObject = parseJsonObjectString(value);
    return parsedObject ?? value;
  }

  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    Array.isArray(value)
  ) {
    return value;
  }

  if (isPlainRecord(value)) {
    return value;
  }

  return String(value);
}

function parseJsonObjectString(value: string): Record<string, unknown> | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isPlainRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeToolCalls(toolCalls: ToolCall[], roundIndex: number): ChatCompletionRequestToolCall[] {
  return toolCalls.map((toolCall, index) => ({
    id: toolCall.id || `tool-call-${roundIndex + 1}-${index + 1}`,
    name: toolCall.name,
    arguments: toToolCallArguments(toolCall.arguments)
  }));
}

function isToolWriteSummary(result: unknown): result is ToolWriteSummary {
  return (
    isPlainRecord(result) &&
    typeof result.path === "string" &&
    typeof result.changedBytes === "number" &&
    (result.operation === "write_file" ||
      result.operation === "edit_file" ||
      result.operation === "multi_edit")
  );
}

function isGrepResult(result: unknown): result is GrepResult {
  return (
    isPlainRecord(result) &&
    Array.isArray(result.matches) &&
    result.matches.every((match) => isPlainRecord(match) && typeof match.path === "string")
  );
}

function stringifyToolResult(result: unknown, secrets: readonly string[]): string {
  return redactSecrets(JSON.stringify(result) ?? "null", secrets);
}

function getToolPathArgument(args: unknown): string | undefined {
  if (!isPlainRecord(args) || typeof args.path !== "string") {
    return undefined;
  }

  return args.path;
}

function getWriteFileContentArgument(args: unknown): string | undefined {
  if (!isPlainRecord(args) || typeof args.content !== "string") {
    return undefined;
  }

  return args.content;
}

function getWritableReportContentFragments(toolCall: ChatCompletionRequestToolCall): string[] {
  if (!isPlainRecord(toolCall.arguments)) {
    return [];
  }

  if (toolCall.name === "write_file") {
    return typeof toolCall.arguments.content === "string" ? [toolCall.arguments.content] : [];
  }

  if (toolCall.name === "edit_file") {
    return typeof toolCall.arguments.newText === "string" ? [toolCall.arguments.newText] : [];
  }

  if (toolCall.name !== "multi_edit" || !Array.isArray(toolCall.arguments.edits)) {
    return [];
  }

  return toolCall.arguments.edits.flatMap((edit) =>
    isPlainRecord(edit) && typeof edit.newText === "string" ? [edit.newText] : []
  );
}

function findInternalReportContentMetadata(contentFragments: readonly string[]): string | undefined {
  for (const content of contentFragments) {
    const matchedPattern = REPORT_CONTENT_INTERNAL_METADATA_PATTERNS.find(({ pattern }) => pattern.test(content));
    if (matchedPattern) {
      return matchedPattern.label;
    }
  }

  return undefined;
}

function includesReportContentPattern(contentFragments: readonly string[], pattern: RegExp): boolean {
  return contentFragments.some((content) => pattern.test(content));
}

function normalizeComparableToolPath(inputPath: string): string {
  return inputPath.replace(/\\/g, "/").replace(/^(?:\.\/)+/u, "");
}

function toProjectRelativeReportsRootPath(artifacts: WindowRunArtifacts): string {
  return `assets/books/${artifacts.book.id}/reports`;
}

function toProjectRelativeReportPath(artifacts: WindowRunArtifacts, reportFileName: string): string {
  return `${toProjectRelativeReportsRootPath(artifacts)}/${reportFileName.replace(/\\/g, "/")}`;
}

function toDirectReportsAliasFileName(comparablePath: string): string | undefined {
  const reportsAliasPrefix = "reports/";
  if (!comparablePath.startsWith(reportsAliasPrefix)) {
    return undefined;
  }

  const reportFileName = comparablePath.slice(reportsAliasPrefix.length);
  return reportFileName && !reportFileName.includes("/") ? reportFileName : undefined;
}

function toCurrentBookReportFileName(inputPath: string, artifacts: WindowRunArtifacts): string | undefined {
  const normalizedPath = normalizeComparableToolPath(inputPath);
  const reportsPrefix = `${toProjectRelativeReportsRootPath(artifacts)}/`;

  if (normalizedPath === "." || normalizedPath === "reports") {
    return undefined;
  }

  if (normalizedPath.startsWith(reportsPrefix)) {
    const reportFileName = normalizedPath.slice(reportsPrefix.length);
    return reportFileName && !reportFileName.includes("/") ? reportFileName : undefined;
  }

  const reportsAliasFileName = toDirectReportsAliasFileName(normalizedPath);
  if (reportsAliasFileName) {
    return reportsAliasFileName;
  }

  return normalizedPath && !normalizedPath.includes("/") ? normalizedPath : undefined;
}

function toAllowedWriteToolOutputFileName(input: {
  allowedOutputFileNames: ReadonlySet<string>;
  artifacts: WindowRunArtifacts;
  pathArgument: string;
}): string {
  const comparablePath = normalizeComparableToolPath(input.pathArgument);
  if (input.allowedOutputFileNames.has(comparablePath)) {
    return comparablePath;
  }

  const reportsPrefix = `${toProjectRelativeReportsRootPath(input.artifacts)}/`;
  if (comparablePath.startsWith(reportsPrefix)) {
    const outputFileName = comparablePath.slice(reportsPrefix.length);
    return input.allowedOutputFileNames.has(outputFileName) ? outputFileName : input.pathArgument;
  }

  const reportsAliasFileName = toDirectReportsAliasFileName(comparablePath);
  return reportsAliasFileName && input.allowedOutputFileNames.has(reportsAliasFileName)
    ? reportsAliasFileName
    : input.pathArgument;
}

function normalizeWriteToolExecutionArguments(input: {
  allowedOutputFileNames: ReadonlySet<string>;
  artifacts: WindowRunArtifacts;
  toolCall: ChatCompletionRequestToolCall;
}): unknown {
  if (!isWriteTool(input.toolCall.name)) {
    return input.toolCall.arguments;
  }

  if (!isPlainRecord(input.toolCall.arguments) || typeof input.toolCall.arguments.path !== "string") {
    return input.toolCall.arguments;
  }

  return {
    ...input.toolCall.arguments,
    path: toAllowedWriteToolOutputFileName({
      allowedOutputFileNames: input.allowedOutputFileNames,
      artifacts: input.artifacts,
      pathArgument: input.toolCall.arguments.path
    })
  };
}

function normalizeReadToolExecutionArguments(input: {
  allowedOutputFileNames: ReadonlySet<string>;
  artifacts: WindowRunArtifacts;
  manifestWindow: RuntimeWindowManifestWindow;
  toolCall: ChatCompletionRequestToolCall;
}): unknown {
  if (input.toolCall.name !== "read_file" && input.toolCall.name !== "grep") {
    return input.toolCall.arguments;
  }

  if (!isPlainRecord(input.toolCall.arguments) || typeof input.toolCall.arguments.path !== "string") {
    return input.toolCall.arguments;
  }

  const comparablePath = normalizeComparableToolPath(input.toolCall.arguments.path);
  if (comparablePath === input.manifestWindow.fileName) {
    return {
      ...input.toolCall.arguments,
      path: input.manifestWindow.textPath
    };
  }

  if (comparablePath === "reports" || (input.toolCall.name === "grep" && comparablePath === ".")) {
    return {
      ...input.toolCall.arguments,
      path: toProjectRelativeReportsRootPath(input.artifacts)
    };
  }

  const reportsAliasFileName = toDirectReportsAliasFileName(comparablePath);
  if (reportsAliasFileName && input.allowedOutputFileNames.has(reportsAliasFileName)) {
    return {
      ...input.toolCall.arguments,
      path: toProjectRelativeReportPath(input.artifacts, reportsAliasFileName)
    };
  }

  for (const outputFileName of input.allowedOutputFileNames) {
    if (comparablePath === normalizeComparableToolPath(outputFileName)) {
      return {
        ...input.toolCall.arguments,
        path: toProjectRelativeReportPath(input.artifacts, outputFileName)
      };
    }
  }

  return input.toolCall.arguments;
}

function assertReadToolExecutionScope(input: {
  allowedOutputFileNames: ReadonlySet<string>;
  artifacts: WindowRunArtifacts;
  executionArguments: unknown;
  manifestWindow: RuntimeWindowManifestWindow;
  toolName: string;
}): void {
  if (input.toolName !== "read_file" && input.toolName !== "grep") {
    return;
  }

  const pathArgument = getToolPathArgument(input.executionArguments);
  if (pathArgument === undefined) {
    return;
  }

  const comparablePath = normalizeComparableToolPath(pathArgument);
  const reportsRootPath = normalizeComparableToolPath(toProjectRelativeReportsRootPath(input.artifacts));
  const allowedFilePaths = new Set<string>([
    normalizeComparableToolPath(input.manifestWindow.textPath),
    normalizeComparableToolPath(input.artifacts.rulesSnapshotPath)
  ]);

  for (const outputFileName of input.allowedOutputFileNames) {
    allowedFilePaths.add(normalizeComparableToolPath(toProjectRelativeReportPath(input.artifacts, outputFileName)));
  }

  if (allowedFilePaths.has(comparablePath) || comparablePath === reportsRootPath) {
    return;
  }

  throw new ToolExecutionError(READ_TOOL_SCOPE_DENIED_MESSAGE, "UNSAFE_PATH");
}

function containsKnownSecret(value: string, secrets: readonly string[]): boolean {
  return secrets.some((secret) => secret.length > 0 && value.includes(secret));
}

function toQueriedReportFileName(inputPath: string, artifacts: WindowRunArtifacts): string | undefined {
  return toCurrentBookReportFileName(inputPath, artifacts);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function fileIsRegularFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(filePath);
    return stat.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function toSafeReportFilePathForExistenceCheck(
  reportsRoot: string,
  reportFileName: string
): string | undefined {
  const normalized = reportFileName.normalize("NFC");
  if (
    normalized === "" ||
    normalized === "." ||
    normalized === ".." ||
    /[\0/\\]/u.test(normalized) ||
    /^[A-Za-z]:/u.test(normalized) ||
    path.win32.isAbsolute(normalized) ||
    path.posix.isAbsolute(normalized)
  ) {
    return undefined;
  }

  return path.join(reportsRoot, normalized);
}

async function validateToolCallBeforeExecution(input: {
  allowedOutputFileNames: ReadonlySet<string>;
  artifacts: WindowRunArtifacts;
  queriedReportFileNames: ReadonlySet<string>;
  reportsRoot: string;
  secrets: readonly string[];
  toolCall: ChatCompletionRequestToolCall;
  writtenReportFileNames: ReadonlySet<string>;
}): Promise<void> {
  const { toolCall } = input;

  if (!ENABLED_TOOL_NAME_SET.has(toolCall.name)) {
    throw new Error(`Tool is not enabled: ${toolCall.name}`);
  }

  if (!isWriteTool(toolCall.name)) {
    return;
  }

  const pathArgument = getToolPathArgument(toolCall.arguments);
  if (pathArgument === undefined) {
    return;
  }

  if (containsKnownSecret(pathArgument, input.secrets)) {
    throw new Error(`写工具 ${toolCall.name} 的 path 包含已知 secret，已拒绝执行。`);
  }

  if (!input.allowedOutputFileNames.has(pathArgument)) {
    throw new Error(
      `写工具 ${toolCall.name} 的 path 必须属于本轮选中模板 outputFileName：${redactSecrets(pathArgument, input.secrets)}`
    );
  }

  if (toolCall.name !== "edit_file" && toolCall.name !== "multi_edit") {
    return;
  }

  const targetReportPath = path.join(input.reportsRoot, pathArgument);
  if (
    (await fileExists(targetReportPath)) &&
    !input.queriedReportFileNames.has(pathArgument) &&
    !input.writtenReportFileNames.has(pathArgument)
  ) {
    throw new Error(
      `写工具 ${toolCall.name} 修改既有报告前，必须先在本轮使用 read_file 或 grep 查询同一个报告文件：${redactSecrets(pathArgument, input.secrets)}`
    );
  }
}

function recordReportQuery(input: {
  artifacts: WindowRunArtifacts;
  allowedOutputFileNames: ReadonlySet<string>;
  queriedReportFileNames: Set<string>;
  toolCall: ChatCompletionRequestToolCall;
  toolResult: unknown;
}): void {
  if (input.toolCall.name !== "read_file" && input.toolCall.name !== "grep") {
    return;
  }

  const pathArgument = getToolPathArgument(input.toolCall.arguments);
  if (pathArgument === undefined) {
    return;
  }

  const reportFileName = toQueriedReportFileName(pathArgument, input.artifacts);
  if (reportFileName && input.allowedOutputFileNames.has(reportFileName)) {
    input.queriedReportFileNames.add(reportFileName);
  }

  if (input.toolCall.name !== "grep" || !isGrepResult(input.toolResult)) {
    return;
  }

  for (const match of input.toolResult.matches) {
    const matchReportFileName = toQueriedReportFileName(match.path, input.artifacts);
    if (matchReportFileName && input.allowedOutputFileNames.has(matchReportFileName)) {
      input.queriedReportFileNames.add(matchReportFileName);
    }
  }
}

function recordSuccessfulReportWrite(input: {
  artifacts: WindowRunArtifacts;
  allowedOutputFileNames: ReadonlySet<string>;
  writtenReportFileNames: Set<string>;
  toolResult: ToolWriteSummary;
}): void {
  const reportFileName = toQueriedReportFileName(input.toolResult.path, input.artifacts);
  if (reportFileName && input.allowedOutputFileNames.has(reportFileName)) {
    input.writtenReportFileNames.add(reportFileName);
  }
}

function shouldReturnRecoverableToolError(name: string, error: unknown): error is ToolExecutionError {
  if (!(error instanceof ToolExecutionError)) {
    return false;
  }

  if (
    (name === "read_file" || name === "grep") &&
    (error.code === "NOT_FOUND" || error.code === "UNSAFE_PATH")
  ) {
    return true;
  }

  if (isRecoverableToolSchemaInvalidArguments(error)) {
    return true;
  }

  if (isRecoverableReadToolInvalidArguments(name, error)) {
    return true;
  }

  return (name === "edit_file" || name === "multi_edit") && error.message === REPLACEMENT_TEXT_NOT_FOUND_MESSAGE;
}

function isRecoverableToolSchemaInvalidArguments(error: ToolExecutionError): boolean {
  if (error.code !== "INVALID_ARGUMENTS") {
    return false;
  }

  return (
    error.message === TOOL_ARGUMENTS_MUST_BE_OBJECT_MESSAGE ||
    TOOL_SCHEMA_STRING_ARGUMENT_ERROR_MESSAGES.has(error.message) ||
    error.message.startsWith(UNEXPECTED_TOOL_ARGUMENT_MESSAGE_PREFIX)
  );
}

function isRecoverableReadToolInvalidArguments(name: string, error: ToolExecutionError): boolean {
  if (error.code !== "INVALID_ARGUMENTS") {
    return false;
  }

  if (name === "read_file") {
    return true;
  }

  return name === "grep" && GREP_BUDGET_ERROR_MESSAGES.has(error.message);
}

function toRecoverableToolErrorResult(input: {
  executionArguments: unknown;
  error: ToolExecutionError;
  secrets: readonly string[];
}): Record<string, unknown> {
  const pathArgument = getToolPathArgument(input.executionArguments);
  const hint =
    input.error.message === REPLACEMENT_TEXT_NOT_FOUND_MESSAGE
      ? REPLACEMENT_TEXT_NOT_FOUND_HINT
      : input.error.message === READ_TOOL_SCOPE_DENIED_MESSAGE
        ? READ_TOOL_SCOPE_DENIED_HINT
        : undefined;

  return {
    error: {
      code: input.error.code,
      message: redactSecrets(input.error.message, input.secrets)
    },
    ...(hint ? { hint: redactSecrets(hint, input.secrets) } : {}),
    ...(pathArgument ? { path: redactSecrets(pathArgument, input.secrets) } : {})
  };
}

async function createExistingReportWriteRecoverableResult(input: {
  queriedReportFileNames: ReadonlySet<string>;
  reportsRoot: string;
  secrets: readonly string[];
  toolCall: ChatCompletionRequestToolCall;
}): Promise<Record<string, unknown> | undefined> {
  if (input.toolCall.name !== "write_file") {
    return undefined;
  }

  const pathArgument = getToolPathArgument(input.toolCall.arguments);
  if (pathArgument === undefined) {
    return undefined;
  }

  const targetReportPath = toSafeReportFilePathForExistenceCheck(input.reportsRoot, pathArgument);
  if (!targetReportPath || !(await fileIsRegularFile(targetReportPath))) {
    return undefined;
  }

  if (!input.queriedReportFileNames.has(pathArgument)) {
    return {
      error: {
        code: "INVALID_ARGUMENTS",
        message: redactSecrets(WRITE_FILE_EXISTING_REPORT_MESSAGE, input.secrets)
      },
      path: redactSecrets(pathArgument, input.secrets)
    };
  }

  const writeContent = getWriteFileContentArgument(input.toolCall.arguments);
  const existingContent = await fs.readFile(targetReportPath, "utf8");
  const normalizedWriteContent = writeContent === undefined ? "" : `${writeContent.trimEnd()}\n`;
  const containsExistingContent =
    normalizedWriteContent.includes(existingContent) ||
    normalizedWriteContent.replace(/\r\n/gu, "\n").includes(existingContent.replace(/\r\n/gu, "\n"));
  if (writeContent === undefined || !containsExistingContent) {
    return {
      error: {
        code: "INVALID_ARGUMENTS",
        message: redactSecrets(WRITE_FILE_LOSSY_REWRITE_MESSAGE, input.secrets)
      },
      path: redactSecrets(pathArgument, input.secrets)
    };
  }

  return undefined;
}

function createInternalReportContentMetadataRecoverableResult(input: {
  secrets: readonly string[];
  toolCall: ChatCompletionRequestToolCall;
}): Record<string, unknown> | undefined {
  if (!isWriteTool(input.toolCall.name)) {
    return undefined;
  }

  const contentFragments = getWritableReportContentFragments(input.toolCall);
  const unsafeMetadata = findInternalReportContentMetadata(contentFragments);
  if (!unsafeMetadata) {
    return undefined;
  }

  const pathArgument = getToolPathArgument(input.toolCall.arguments);

  return {
    error: {
      code: "INVALID_ARGUMENTS",
      message: redactSecrets(
        `${REPORT_CONTENT_INTERNAL_METADATA_MESSAGE} 检测到：${unsafeMetadata}`,
        input.secrets
      )
    },
    hint: redactSecrets(REPORT_CONTENT_INTERNAL_METADATA_HINT, input.secrets),
    ...(pathArgument ? { path: redactSecrets(pathArgument, input.secrets) } : {})
  };
}

function createWindowFileIdentifierRecoverableResult(input: {
  secrets: readonly string[];
  toolCall: ChatCompletionRequestToolCall;
}): Record<string, unknown> | undefined {
  if (!isWriteTool(input.toolCall.name)) {
    return undefined;
  }

  if (
    !includesReportContentPattern(
      getWritableReportContentFragments(input.toolCall),
      REPORT_CONTENT_WINDOW_FILE_IDENTIFIER_PATTERN
    )
  ) {
    return undefined;
  }

  const pathArgument = getToolPathArgument(input.toolCall.arguments);

  return {
    error: {
      code: "INVALID_ARGUMENTS",
      message: redactSecrets(REPORT_CONTENT_WINDOW_FILE_IDENTIFIER_MESSAGE, input.secrets)
    },
    hint: redactSecrets(REPORT_CONTENT_WINDOW_FILE_IDENTIFIER_HINT, input.secrets),
    ...(pathArgument ? { path: redactSecrets(pathArgument, input.secrets) } : {})
  };
}

function createDraftOrTemplateStatusRecoverableResult(input: {
  secrets: readonly string[];
  toolCall: ChatCompletionRequestToolCall;
}): Record<string, unknown> | undefined {
  if (!isWriteTool(input.toolCall.name)) {
    return undefined;
  }

  if (
    !includesReportContentPattern(
      getWritableReportContentFragments(input.toolCall),
      REPORT_CONTENT_DRAFT_OR_TEMPLATE_STATUS_PATTERN
    )
  ) {
    return undefined;
  }

  const pathArgument = getToolPathArgument(input.toolCall.arguments);

  return {
    error: {
      code: "INVALID_ARGUMENTS",
      message: redactSecrets(REPORT_CONTENT_DRAFT_OR_TEMPLATE_STATUS_MESSAGE, input.secrets)
    },
    hint: redactSecrets(REPORT_CONTENT_DRAFT_OR_TEMPLATE_STATUS_HINT, input.secrets),
    ...(pathArgument ? { path: redactSecrets(pathArgument, input.secrets) } : {})
  };
}

function shouldRecordSuccessfulReportQuery(input: {
  returnedRecoverableToolError: boolean;
  toolCall: ChatCompletionRequestToolCall;
}): boolean {
  return (
    !input.returnedRecoverableToolError &&
    (input.toolCall.name === "read_file" || input.toolCall.name === "grep")
  );
}

export function createWindowRunService(options: WindowRunServiceOptions): WindowRunService {
  const llmCredentialStore: LlmCredentialStore = {
    async resolveApiKey(ref) {
      return options.credentialStore.readApiKey(ref) ?? null;
    }
  };

  async function readWindowText(project: Project, manifestWindow: RuntimeWindowManifestWindow): Promise<string> {
    return fs.readFile(path.join(project.rootPath, manifestWindow.textPath), "utf8");
  }

  async function getReportRedactionSecrets(providerConfigId: string): Promise<string[]> {
    const providerConfig = (await options.providerStore.listProviderConfigs()).find(
      (config) => config.id === providerConfigId
    );
    const apiKey = providerConfig?.apiKeyRef
      ? options.credentialStore.readApiKey(providerConfig.apiKeyRef)
      : undefined;
    return apiKey ? [apiKey] : [];
  }

  async function registerTemplateOutputReport(input: {
    artifacts: WindowRunArtifacts;
    reportFileName: string;
  }): Promise<ReportAsset> {
    const reportsRoot = toReportsRoot(input.artifacts);
    const reportPath = path.join(reportsRoot, input.reportFileName);
    const stat = await fs.stat(reportPath);
    const existingReport = options.findExistingReport({
      bookId: input.artifacts.book.id,
      fileName: input.reportFileName
    });
    const now = options.clock.now();
    const report: ReportAsset = {
      id: existingReport?.id ?? options.idGenerator.createId("report"),
      bookId: input.artifacts.book.id,
      fileName: input.reportFileName,
      displayName: toReportDisplayName(input.reportFileName),
      relativePath: path.relative(input.artifacts.project.rootPath, reportPath),
      byteSize: stat.size,
      createdAt: existingReport?.createdAt ?? now,
      updatedAt: now,
      reportKind: "template-output"
    };

    options.registerReport({ path: reportPath, report });
    return report;
  }

  async function executeWindowToolLoop(input: {
    artifacts: WindowRunArtifacts;
    batchIndex: number;
    batchTotal: number;
    client: OpenAiCompatibleClient;
    job: WindowRunJobInput;
    manifestWindow: RuntimeWindowManifestWindow;
    modelId: string;
    providerId: string;
    totalWindowCount: number;
    windowText: string;
  }): Promise<{ content: string; usage: TokenUsage }> {
    const reportsRoot = toReportsRoot(input.artifacts);
    await fs.mkdir(reportsRoot, { recursive: true });

    const secrets = await getReportRedactionSecrets(input.job.input.providerConfigId);
    options.taskLogger?.setSecrets(secrets);
    const allowedOutputFileNames = new Set(input.artifacts.templates.map((template) => template.fileName));
    const queriedReportFileNames = new Set<string>();
    const writtenReportFileNames = new Set<string>();
    let hasSuccessfulWrite = false;
    const messages: ChatCompletionMessage[] = [
      {
        role: "system",
        content: TOOL_LOOP_DEFAULTS.systemInstruction
      },
      {
        role: "user",
        content: buildWindowPrompt({
          artifacts: input.artifacts,
          currentDate: toPromptDate(options.clock.now()),
          manifestWindow: input.manifestWindow,
          totalWindowCount: input.totalWindowCount,
          windowText: input.windowText
        })
      }
    ];
    let usage = { ...EMPTY_USAGE };
    let currentRoundIndex: number | undefined;

    try {
      await options.taskLogger?.append(["上下文", "窗口"], {
        正在处理: `窗口 ${input.manifestWindow.index + 1}/${input.totalWindowCount}`,
        窗口序号: `${input.manifestWindow.index + 1}/${input.totalWindowCount}`,
        窗口文件: input.manifestWindow.textPath,
        章节范围: input.manifestWindow.submittedChapterRange,
        上下文章节范围: input.manifestWindow.contextChapterRange,
        规则快照: input.artifacts.rulesSnapshotPath,
        报告目录: path.relative(input.artifacts.project.rootPath, reportsRoot) || reportsRoot,
        批次: `${input.batchIndex + 1}/${input.batchTotal}`,
        模板: input.artifacts.templates.map((template) => ({
          模板ID: template.id,
          模板名称: template.name,
          输出文件: template.fileName
        }))
      });

      for (let roundIndex = 0; roundIndex < TOOL_LOOP_DEFAULTS.maxRounds; roundIndex += 1) {
        currentRoundIndex = roundIndex + 1;
        await options.taskLogger?.append(["大模型请求", "Prompt"], {
          供应商: input.providerId,
          模型: input.modelId,
          轮次: currentRoundIndex,
          messages,
          tools: TOOL_SCHEMAS
        });
        const completion = await input.client.chatCompletion({
          providerId: input.providerId,
          modelId: input.modelId,
          messages,
          tools: TOOL_SCHEMAS
        });
        const usageDelta = mapUsage(completion.normalizedUsage);
        usage = addUsage(usage, usageDelta);

        await options.taskLogger?.append(["大模型返回"], {
          轮次: currentRoundIndex,
          正文: completion.content,
          工具调用: completion.toolCalls,
          Token使用: usageDelta
        });

        if (completion.toolCalls.length === 0) {
          if (completion.content.trim() !== "NO_UPDATE" && !hasSuccessfulWrite) {
            if (roundIndex + 1 >= TOOL_LOOP_DEFAULTS.maxRounds) {
              throw new Error(NO_TOOL_PROTOCOL_ERROR_MESSAGE);
            }

            await options.taskLogger?.append(["上下文", "重试"], NO_TOOL_PROTOCOL_CORRECTION_MESSAGE);
            messages.push({
              role: "assistant",
              content: redactSecrets(completion.content, secrets)
            });
            messages.push({
              role: "user",
              content: NO_TOOL_PROTOCOL_CORRECTION_MESSAGE
            });
            continue;
          }

          return {
            content: redactSecrets(completion.content, secrets),
            usage
          };
        }

        const toolCalls = normalizeToolCalls(completion.toolCalls, roundIndex).map((toolCall) => {
          const normalizedReadExecutionArguments = normalizeReadToolExecutionArguments({
            allowedOutputFileNames,
            artifacts: input.artifacts,
            manifestWindow: input.manifestWindow,
            toolCall
          });
          const executionSourceArguments = normalizeWriteToolExecutionArguments({
            allowedOutputFileNames,
            artifacts: input.artifacts,
            toolCall: {
              ...toolCall,
              arguments: toToolCallArguments(normalizedReadExecutionArguments)
            }
          });
          const executionArguments = redactWritableToolArguments(toolCall.name, executionSourceArguments, secrets);
          const replaySourceArguments = redactWritableToolArguments(
            toolCall.name,
            isWriteTool(toolCall.name) ? executionSourceArguments : toolCall.arguments,
            secrets
          );
          const replayArguments = redactJsonValue(replaySourceArguments, secrets);

          return {
            ...toolCall,
            arguments: isWriteTool(toolCall.name) ? toToolCallArguments(executionSourceArguments) : toolCall.arguments,
            executionArguments,
            replayArguments: toToolCallArguments(replayArguments)
          };
        });

        messages.push({
          role: "assistant",
          content: redactSecrets(completion.content, secrets),
          toolCalls: toolCalls.map((toolCall) => ({
            id: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.replayArguments
          }))
        });

        for (const toolCall of toolCalls) {
          await options.taskLogger?.append(["工具调用", toolCall.name], {
            轮次: currentRoundIndex,
            工具调用ID: toolCall.id,
            模型原始输入: toolCall.replayArguments,
            实际执行输入: toolCall.executionArguments
          });

          await validateToolCallBeforeExecution({
            allowedOutputFileNames,
            artifacts: input.artifacts,
            queriedReportFileNames,
            reportsRoot,
            secrets,
            toolCall,
            writtenReportFileNames
          });

          let toolResult: unknown;
          let returnedRecoverableToolError = false;
          const preExecutionRecoverableToolResult =
            createInternalReportContentMetadataRecoverableResult({
              secrets,
              toolCall
            }) ??
            createWindowFileIdentifierRecoverableResult({
              secrets,
              toolCall
            }) ??
            createDraftOrTemplateStatusRecoverableResult({
              secrets,
              toolCall
            }) ??
            (await createExistingReportWriteRecoverableResult({
              queriedReportFileNames,
              reportsRoot,
              secrets,
              toolCall
            }));
          if (preExecutionRecoverableToolResult) {
            returnedRecoverableToolError = true;
            toolResult = preExecutionRecoverableToolResult;
          } else {
            try {
              assertReadToolExecutionScope({
                allowedOutputFileNames,
                artifacts: input.artifacts,
                executionArguments: toolCall.executionArguments,
                manifestWindow: input.manifestWindow,
                toolName: toolCall.name
              });
              toolResult = await executeBuiltinFileTool(toolCall.name, toolCall.executionArguments, {
                projectRoot: input.artifacts.project.rootPath,
                reportsRoot
              });
            } catch (error) {
              if (!shouldReturnRecoverableToolError(toolCall.name, error)) {
                throw error;
              }

              returnedRecoverableToolError = true;
              toolResult = toRecoverableToolErrorResult({
                executionArguments: toolCall.executionArguments,
                error,
                secrets
              });
            }
          }

          await options.taskLogger?.append(["工具返回", toolCall.name], {
            轮次: currentRoundIndex,
            工具调用ID: toolCall.id,
            是否可恢复错误: returnedRecoverableToolError,
            返回内容: toolResult
          });
          if (shouldRecordSuccessfulReportQuery({ returnedRecoverableToolError, toolCall })) {
            recordReportQuery({
              allowedOutputFileNames,
              artifacts: input.artifacts,
              queriedReportFileNames,
              toolCall,
              toolResult
            });
          }

          if (isWriteTool(toolCall.name) && !returnedRecoverableToolError) {
            if (!isToolWriteSummary(toolResult)) {
              throw new Error(`写工具 ${toolCall.name} 未返回写入摘要`);
            }

            await registerTemplateOutputReport({
              artifacts: input.artifacts,
              reportFileName: toolResult.path
            });
            recordSuccessfulReportWrite({
              allowedOutputFileNames,
              artifacts: input.artifacts,
              writtenReportFileNames,
              toolResult
            });
            hasSuccessfulWrite = true;
          }

          messages.push({
            role: "tool",
            toolCallId: toolCall.id,
            name: toolCall.name,
            content: stringifyToolResult(toolResult, secrets)
          });
        }
      }

      if (hasSuccessfulWrite) {
        return {
          content: "tool loop 达到最大轮次，已保留本窗口成功写入结果",
          usage
        };
      }

      throw new Error(`tool loop 超过最大轮次 ${TOOL_LOOP_DEFAULTS.maxRounds}`);
    } catch (error) {
      await options.taskLogger?.append(["错误", "窗口"], {
        ...(currentRoundIndex ? { 轮次: currentRoundIndex } : {}),
        错误: toSafeErrorMessage(error, secrets),
        Token使用: usage
      });
      throw error;
    }
  }

  async function createLlmClient(job: WindowRunJobInput): Promise<{
    client: OpenAiCompatibleClient;
    modelId: string;
    providerId: string;
  }> {
    const registry = createProviderRegistry({
      presets: getProviderPresets(),
      providerConfigs: await options.providerStore.listProviderConfigs()
    });
    const { provider, modelId } = registry.resolveModelRef(
      `${job.input.providerConfigId}/${job.input.modelId}`
    );

    return {
      client: new OpenAiCompatibleClient(provider, llmCredentialStore, {
        fetch: options.fetch
      }),
      modelId,
      providerId: provider.id
    };
  }

  function createRuntimeInput(input: {
    artifacts: WindowRunArtifacts;
    job: WindowRunJobInput;
    modelId: string;
  }): JobRunInput {
    return {
      jobId: input.job.id,
      bookId: input.artifacts.book.id,
      modelId: input.modelId,
      providerConfigId: input.job.input.providerConfigId,
      templateIds: [...input.job.input.templateIds],
      windows: toJobWindowInputs(input.artifacts.runtimeWindowManifest),
      metadata: {
        rulesSnapshotPath: input.artifacts.rulesSnapshotPath
      }
    };
  }

  function createLlmAdapter(input: {
    artifacts: WindowRunArtifacts;
    client: OpenAiCompatibleClient;
    job: WindowRunJobInput;
    modelId: string;
    providerId: string;
    totalWindowCount: number;
  }): JobLlmClient {
    return {
      async completeWindow({ window }) {
        const manifestWindow = getWindowMetadata(window);
        let secrets: string[] = [];

        try {
          secrets = await getReportRedactionSecrets(input.job.input.providerConfigId);
          const windowText = await readWindowText(input.artifacts.project, manifestWindow);
          const templateBatches = chunkTemplates(input.artifacts.templates, MAX_FULL_TEMPLATES_PER_CALL);
          const contentParts: string[] = [];
          let usage = { ...EMPTY_USAGE };

          for (const [templateBatchIndex, templateBatch] of templateBatches.entries()) {
            const result = await executeWindowToolLoop({
              artifacts: {
                ...input.artifacts,
                templates: templateBatch
              },
              batchIndex: templateBatchIndex,
              batchTotal: templateBatches.length,
              client: input.client,
              job: input.job,
              manifestWindow,
              modelId: input.modelId,
              providerId: input.providerId,
              totalWindowCount: input.totalWindowCount,
              windowText
            });
            usage = addUsage(usage, result.usage);
            contentParts.push(result.content);
          }

          return {
            content: redactSecrets(contentParts.join("\n"), secrets),
            usage,
            fee: NO_TOOL_FEE,
            toolCalls: []
          };
        } catch (error) {
          throw new Error(
            `窗口 ${manifestWindow.index + 1}/${input.totalWindowCount}（${manifestWindow.fileName}）执行失败：${toSafeErrorMessage(error, secrets)}`
          );
        }
      }
    };
  }

  return {
    async runJobWindows({ artifacts, job }) {
      const { client, modelId, providerId } = await createLlmClient(job);
      const runtimeInput = createRuntimeInput({ artifacts, job, modelId });
      const runtime = createJobRuntime({
        clock: options.clock,
        llm: createLlmAdapter({
          artifacts,
          client,
          job,
          modelId,
          providerId,
          totalWindowCount: runtimeInput.windows.length
        }),
        repository: {
          async saveState(state) {
            await options.onRuntimeState(state);
          }
        },
        tools: {
          async execute() {
            throw new Error("窗口 tool loop 已在 LLM adapter 内执行，runtime tools.execute 不应被调用");
          }
        }
      });

      return runtime.startJob(runtimeInput);
    }
  };
}
