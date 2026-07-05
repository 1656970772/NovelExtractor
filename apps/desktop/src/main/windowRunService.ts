import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getDefaultConfig, getProviderPresets } from "@novel-extractor/config";
import type { Book, Clock, IdGenerator, Project, ReportAsset } from "@novel-extractor/domain";
import {
  buildTemplatePromptProfile,
  renderTemplatePromptProfileCard,
  type TemplatePromptProfile
} from "@novel-extractor/extraction/templatePromptProfile";
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
  BashJobManager,
  executeBuiltinFileTool,
  getEnabledTools,
  ToolExecutionError,
  type BashTeardownResult
} from "@novel-extractor/tools";
import type { TemplateDto } from "../shared/ipcTypes";
import { createBatchOutcomeTracker, type BatchOutcome, type BatchOutcomeTracker } from "./batchOutcomeTracker";
import { redactSecrets, type MemoryCredentialStore } from "./credentials";
import type { MainProviderStore } from "./providerStore";
import {
  loadReportCoverageIndex,
  type ReportCoverageIndexStore,
  type ReportCoverageTarget
} from "./reportCoverageIndex";
import { planTemplateBatches } from "./templateBatchPlanner";
import {
  replaceWindowTextReferencesForTaskLog,
  serializeModelRequestForTaskLog,
  type TaskTextLogger
} from "./taskTextLogger";
import {
  BASH_TOOL_SCOPE_DENIED_MESSAGE,
  classifyToolLoopRoundReason,
  classifyToolExecutionError,
  fingerprintRecoverableToolError,
  READ_TOOL_SCOPE_DENIED_MESSAGE,
  TOOL_LOOP_ROUND_REASON_LABELS,
  type ToolErrorClassification,
  type ToolLoopRoundReason
} from "./toolErrorClassification";

interface WindowRunJobInput {
  id: string;
  bookId: string;
  input: {
    modelId: string;
    providerConfigId: string;
    skipAlreadyExtracted: boolean;
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
  createRulesSemanticHash?: (templates: readonly TemplateDto[]) => string;
  fetch?: FetchLike;
  findExistingReport(input: { bookId: string; fileName: string }): ReportAsset | undefined;
  idGenerator: IdGenerator;
  onRuntimeState(state: JobRuntimeState): Promise<void> | void;
  providerStore: MainProviderStore;
  registerReport(input: { path: string; report: ReportAsset }): Promise<void> | void;
  taskLogger?: TaskTextLogger;
  enabledToolNames?: readonly string[];
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
const DEFAULT_CONFIG = getDefaultConfig();
const TOOL_LOOP_DEFAULTS = DEFAULT_CONFIG.toolLoopDefaults;
const TEMPLATE_PROMPT_PROFILE_DEFAULTS = DEFAULT_CONFIG.templatePromptProfileDefaults;
const COVERAGE_INDEX_DEFAULTS = DEFAULT_CONFIG.coverageIndexDefaults;
const DEFAULT_ENABLED_TOOL_NAMES = TOOL_LOOP_DEFAULTS.enabledToolNames;
const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0
};
const MARK_NO_UPDATE_TOOL_NAME = "mark_no_update";
const READ_REPORT_EXCERPT_TOOL_NAME = "read_report_excerpt";
const UPSERT_REPORT_SECTION_TOOL_NAME = "upsert_report_section";
const DEFAULT_MAX_READ_BYTES = 1024 * 1024;
const FORMAL_REPORT_FILE_NAME_PREFIX = "[报告]";
const NO_TOOL_PROTOCOL_ERROR_MESSAGE =
  "tool loop 协议错误：无工具调用时必须返回 NO_UPDATE，或先通过写工具成功写入报告。";
const NO_TOOL_PROTOCOL_CORRECTION_MESSAGE =
  "上一轮没有调用任何工具，也没有成功写入报告，最终文本不是精确的 NO_UPDATE。\n" +
  "如果本窗口没有可写入的新信息，必须精确返回 NO_UPDATE；如果有可写入内容，必须先调用写工具写入正式报告。";
const BATCH_OUTCOME_CORRECTION_PREFIX = "上一轮尚未为本批次所有选中模板提供处理结果";
const WRITE_FILE_EXISTING_REPORT_MESSAGE =
  "已有报告不能用 write_file 覆盖；请先用 read_report_excerpt 按卡片名和字段名读取目标字段块，再用 upsert_report_section 替换同一字段。";
const UPSERT_EXISTING_REPORT_MESSAGE =
  "已有报告不能直接更新字段；请先用 read_report_excerpt 按卡片名和字段名读取目标字段块，再用 upsert_report_section 替换同一字段。";
const OVERSIZED_REPORT_READ_MESSAGE =
  "已选旧报告过大，不能直接整读。请用 read_report_excerpt 按卡片名和字段名读取目标字段块。";
const OVERSIZED_REPORT_READ_HINT =
  "不要整读旧报告；按 cardName + fields 拆成更小的 queries 读取需要的字段块，内容太多时分多次读取。";
const WRITE_FILE_LOSSY_REWRITE_MESSAGE =
  "不能覆盖丢失既有内容，需要使用 edit_file/multi_edit 或包含完整旧内容。";
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

interface BashSandbox {
  env: NodeJS.ProcessEnv;
  parentRoot: string;
  reportsRoot: string;
}

export type ReportInventoryItem = {
  outputFileName: string;
  exists: boolean;
  source: "selected_template";
};

type WindowCoverageTarget = {
  template: TemplateDto;
  target: ReportCoverageTarget;
};

type WindowCoveragePlan = {
  skippedCoverageTargets: WindowCoverageTarget[];
  templatesToProcess: TemplateDto[];
};

type WindowRunJobContext = {
  coverageIndex: ReportCoverageIndexStore;
  rulesSemanticHashByTemplateId: Map<string, string>;
  coverageSummary: {
    skippedWindowCount: number;
    processedWindowCount: number;
    skippedTemplateTargetCount: number;
    processedTemplateTargetCount: number;
    pendingWindowLabels: string[];
  };
  coveragePlanByWindowId: Map<string, WindowCoveragePlan>;
};

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
    totalTokens: usage.totalTokens,
    cacheHitTokens: usage.cacheHitTokens,
    cacheMissTokens: usage.cacheMissTokens
  };
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    cacheHitTokens: (left.cacheHitTokens ?? 0) + (right.cacheHitTokens ?? 0),
    cacheMissTokens: (left.cacheMissTokens ?? 0) + (right.cacheMissTokens ?? 0)
  };
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

function createTemplatePromptHash(template: TemplateDto): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        outputFileName: template.fileName,
        templateBody: template.body,
        templateId: template.id,
        templateName: template.name
      })
    )
    .digest("hex");
}

function toFormalReportFileName(templateFileName: string): string {
  const parsed = path.parse(templateFileName);
  const extension = parsed.ext || ".md";
  const baseName = parsed.name.startsWith(FORMAL_REPORT_FILE_NAME_PREFIX)
    ? parsed.name.slice(FORMAL_REPORT_FILE_NAME_PREFIX.length)
    : parsed.name;
  if (!baseName.includes("模板") && !parsed.name.startsWith(FORMAL_REPORT_FILE_NAME_PREFIX)) {
    return templateFileName;
  }

  const reportBaseName = baseName.replace(/模板/gu, "").trim() || baseName.trim() || "未命名";
  return `${FORMAL_REPORT_FILE_NAME_PREFIX}${reportBaseName}${extension}`;
}

function toFormalReportTemplate(template: TemplateDto): TemplateDto {
  return {
    ...template,
    fileName: toFormalReportFileName(template.fileName)
  };
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function createRulesSemanticHash(templates: readonly TemplateDto[]): string {
  return sha256Json({
    toolLoopSystemInstruction: TOOL_LOOP_DEFAULTS.systemInstruction,
    toolLoopWindowInstructionLines: TOOL_LOOP_DEFAULTS.windowInstructionLines,
    templateProfileCompressionVersion: TEMPLATE_PROMPT_PROFILE_DEFAULTS.compressionVersion,
    templates: templates.map((template) => ({
      templateId: template.id,
      outputFileName: template.fileName,
      templateHash: createTemplatePromptHash(template)
    }))
  });
}

function createCoverageTarget(input: {
  artifacts: WindowRunArtifacts;
  manifestWindow: RuntimeWindowManifestWindow;
  rulesSemanticHash: string;
  template: TemplateDto;
}): ReportCoverageTarget {
  return {
    bookId: input.artifacts.book.id,
    templateId: input.template.id,
    outputFileName: input.template.fileName,
    templateHash: createTemplatePromptHash(input.template),
    windowHash: input.manifestWindow.windowHash,
    rulesSemanticHash: input.rulesSemanticHash,
    submittedChapterRange: input.manifestWindow.submittedChapterRange
  };
}

function createWindowLabel(window: RuntimeWindowManifestWindow, totalWindowCount: number): string {
  return `窗口 ${window.index + 1}/${totalWindowCount}`;
}

function createWindowCoverageTargets(input: {
  artifacts: WindowRunArtifacts;
  manifestWindow: RuntimeWindowManifestWindow;
  rulesSemanticHashByTemplateId: ReadonlyMap<string, string>;
}): WindowCoverageTarget[] {
  return input.artifacts.templates.map((template) => {
    const rulesSemanticHash = input.rulesSemanticHashByTemplateId.get(template.id);
    if (!rulesSemanticHash) {
      throw new Error(`Missing rules semantic hash for template ${template.id}`);
    }

    return {
      template,
      target: createCoverageTarget({
        artifacts: input.artifacts,
        manifestWindow: input.manifestWindow,
        rulesSemanticHash,
        template
      })
    };
  });
}

function buildTemplatePromptProfiles(templates: readonly TemplateDto[]): TemplatePromptProfile[] {
  return templates.map((template) =>
    buildTemplatePromptProfile({
      defaults: TEMPLATE_PROMPT_PROFILE_DEFAULTS,
      template: {
        id: template.id,
        name: template.name,
        fileName: template.fileName,
        body: template.body
      },
      templateHash: createTemplatePromptHash(template)
    })
  );
}

function buildStableSystemPrompt(input: {
  toolLoopInstruction: string;
  windowInstructionLines: readonly string[];
}): string {
  return [
    input.toolLoopInstruction,
    "",
    "## 窗口处理规则",
    "请根据当前窗口文本和选中模板抽取信息，并使用文件工具写入或更新正式模板 Markdown。",
    ...input.windowInstructionLines
  ].join("\n");
}

function buildWindowUserPrompt(input: {
  artifacts: WindowRunArtifacts;
  currentDate: string;
  manifestWindow: RuntimeWindowManifestWindow;
  reportInventory: readonly ReportInventoryItem[];
  templatePromptProfiles: readonly TemplatePromptProfile[];
  totalWindowCount: number;
  windowText: string;
}): string {
  const { artifacts, currentDate, manifestWindow, reportInventory, templatePromptProfiles, totalWindowCount, windowText } = input;
  const windowNumber = manifestWindow.index + 1;
  const templateSection = renderTemplatePromptProfileCards(templatePromptProfiles, reportInventory);
  const reportInventorySection = renderReportInventoryPromptSection(reportInventory);

  return [
    `小说：${artifacts.book.displayName}`,
    `书籍 ID：${artifacts.book.id}`,
    "规则与模板要求已内嵌在本请求；不要读取运行级规则快照文件。",
    `当前运行日期：${currentDate}`,
    `窗口序号：${windowNumber}/${totalWindowCount}`,
    `上下文章节范围：${manifestWindow.contextChapterRange}`,
    `提交章节范围：${manifestWindow.submittedChapterRange}`,
    `上下文章节标题：${manifestWindow.contextChapterTitles.join("、")}`,
    `提交章节标题：${manifestWindow.submittedChapterTitles.join("、")}`,
    "",
    reportInventorySection,
    "",
    "## 选中模板 Prompt Profile",
    templateSection,
    "",
    "## 当前窗口文本",
    windowText.trim()
  ].join("\n");
}

function renderReportInventoryPromptSection(reportInventory: readonly ReportInventoryItem[]): string {
  const existingReportFileNames = reportInventory
    .filter((item) => item.exists)
    .map((item) => item.outputFileName);
  const missingReportFileNames = reportInventory
    .filter((item) => !item.exists)
    .map((item) => item.outputFileName);

  return [
    "宿主已基于本批次选中模板和 reports 目录提供报告清单，清单只包含本批次允许触达的报告文件。",
    `已有报告：${existingReportFileNames.length > 0 ? existingReportFileNames.join("、") : "无"}`,
    `待创建报告：${missingReportFileNames.length > 0 ? missingReportFileNames.join("、") : "无"}`,
    "不要再调用目录或 shell 类工具查找这些报告是否存在；需要读已有报告时，直接使用允许的文件读取或搜索工具。",
    "已有报告可按需读取相关字段，并用 upsert_report_section 修改目标字段。",
    "待创建报告不要先调用 read_file 或 read_report_excerpt；有可写入信息时直接用 write_file 创建并写入完整报告正文。"
  ].join("\n");
}

function renderTemplatePromptProfileCards(
  templatePromptProfiles: readonly TemplatePromptProfile[],
  reportInventory: readonly ReportInventoryItem[]
): string {
  const reportStatusByOutputFileName = new Map(
    reportInventory.map((item) => [item.outputFileName, item.exists ? "已存在" : "待创建"])
  );

  return templatePromptProfiles
    .map((profile) =>
      renderTemplatePromptProfileCardWithReportStatus(
        profile,
        reportStatusByOutputFileName.get(profile.outputFileName) ?? "未知"
      )
    )
    .join("\n\n");
}

function renderTemplatePromptProfileCardWithReportStatus(
  profile: TemplatePromptProfile,
  reportStatus: string
): string {
  const lines = renderTemplatePromptProfileCard(profile).split("\n");
  const outputFileNameLineIndex = lines.findIndex((line) => line === `- outputFileName: ${profile.outputFileName}`);
  if (outputFileNameLineIndex >= 0) {
    lines.splice(outputFileNameLineIndex + 1, 0, `- reportStatus: ${reportStatus}`);
  }

  return lines.join("\n");
}

function toReportDisplayName(fileName: string): string {
  return path.basename(fileName, path.extname(fileName));
}

function toReportsRoot(artifacts: WindowRunArtifacts): string {
  return path.join(artifacts.project.rootPath, "assets", "books", artifacts.book.id, "reports");
}

async function createBashSandbox(reportsRoot: string, projectRoot: string): Promise<BashSandbox> {
  const parentRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-bash-sandbox-"));
  const sandboxReportsRoot = path.join(parentRoot, "reports");
  await fs.mkdir(sandboxReportsRoot, { recursive: true });
  await copyRegularTreeWithinReports({
    fromRoot: reportsRoot,
    relativePath: "",
    toRoot: sandboxReportsRoot,
    unsafeEntryBehavior: "skip"
  });
  return {
    env: await createBashSandboxEnv(process.env, [projectRoot, reportsRoot, os.homedir()], parentRoot),
    parentRoot,
    reportsRoot: sandboxReportsRoot
  };
}

async function removeBashSandbox(sandbox: BashSandbox): Promise<void> {
  await fs.rm(sandbox.parentRoot, { force: true, recursive: true });
}

async function createBashSandboxEnv(
  sourceEnv: NodeJS.ProcessEnv,
  blockedRoots: readonly string[],
  sandboxParentRoot: string
): Promise<NodeJS.ProcessEnv> {
  const blockedValues = await normalizedBlockedPathValues(blockedRoots);
  const env: NodeJS.ProcessEnv = {};
  const passthroughKeys = new Set([
    "COMSPEC",
    "ComSpec",
    "NUMBER_OF_PROCESSORS",
    "OS",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "PROCESSOR_LEVEL",
    "PROCESSOR_REVISION",
    "PSModulePath",
    "Path",
    "PATH",
    "SystemDrive",
    "SYSTEMDRIVE",
    "SystemRoot",
    "SYSTEMROOT",
    "windir",
    "WINDIR"
  ]);

  for (const [key, value] of Object.entries(sourceEnv)) {
    if (!passthroughKeys.has(key) || value === undefined || containsBlockedPath(value, blockedValues)) {
      continue;
    }
    env[key] = value;
  }

  const sandboxHome = path.join(sandboxParentRoot, "home");
  const sandboxTemp = path.join(sandboxParentRoot, "tmp");
  const sandboxAppData = path.join(sandboxParentRoot, "appdata");
  const sandboxLocalAppData = path.join(sandboxParentRoot, "localappdata");
  await fs.mkdir(sandboxHome, { recursive: true });
  await fs.mkdir(sandboxTemp, { recursive: true });
  await fs.mkdir(sandboxAppData, { recursive: true });
  await fs.mkdir(sandboxLocalAppData, { recursive: true });
  env.HOME = sandboxHome;
  env.USERPROFILE = sandboxHome;
  env.HOMEDRIVE = path.parse(sandboxHome).root.replace(/[\\/]$/u, "");
  env.HOMEPATH = path.relative(path.parse(sandboxHome).root, sandboxHome);
  env.TEMP = sandboxTemp;
  env.TMP = sandboxTemp;
  env.TMPDIR = sandboxTemp;
  env.APPDATA = sandboxAppData;
  env.LOCALAPPDATA = sandboxLocalAppData;

  return env;
}

async function normalizedBlockedPathValues(paths: readonly string[]): Promise<readonly string[]> {
  const out = new Set<string>();
  for (const item of paths) {
    for (const candidate of [item, await realpathOrOriginal(item)]) {
      const normalized = normalizeEnvPathComparable(candidate);
      if (normalized !== "") {
        out.add(normalized);
      }
    }
  }
  return [...out];
}

async function realpathOrOriginal(item: string): Promise<string> {
  try {
    return await fs.realpath(item);
  } catch {
    return item;
  }
}

function containsBlockedPath(value: string, blockedValues: readonly string[]): boolean {
  const normalized = normalizeEnvPathComparable(value);
  return blockedValues.some((blockedValue) => normalized.includes(blockedValue));
}

function normalizeEnvPathComparable(value: string): string {
  const normalized = value.replace(/\\/gu, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

interface BashReportSyncResult {
  persistedReportFileNames: string[];
  recoverableError?: ToolExecutionError;
  sandboxRefreshReportFileNames: string[];
}

async function syncBashSandboxReportsToReal(input: {
  allowedOutputFileNames: ReadonlySet<string>;
  onReportPersisted(reportFileName: string): Promise<void> | void;
  queriedReportFileNames: ReadonlySet<string>;
  reportsRoot: string;
  sandbox: BashSandbox;
  writtenReportFileNames: ReadonlySet<string>;
}): Promise<BashReportSyncResult> {
  await fs.mkdir(input.reportsRoot, { recursive: true });
  const persistedReportFileNames: string[] = [];
  const sandboxRefreshReportFileNames: string[] = [];

  for (const reportFileName of input.allowedOutputFileNames) {
    const sandboxReportPath = toSafeReportFilePathForExistenceCheck(input.sandbox.reportsRoot, reportFileName);
    const realReportPath = toSafeReportFilePathForExistenceCheck(input.reportsRoot, reportFileName);
    if (!sandboxReportPath || !realReportPath) {
      continue;
    }

    const sandboxState = await regularFileSyncState(sandboxReportPath);
    const realState = await regularFileSyncState(realReportPath);
    if (sandboxState.kind === "other") {
      if (realState.kind === "file") {
        sandboxRefreshReportFileNames.push(reportFileName);
      }
      return {
        persistedReportFileNames,
        sandboxRefreshReportFileNames,
        recoverableError: new ToolExecutionError("bash 生成的选中报告不是普通文件，已拒绝同步。", "UNSAFE_PATH")
      };
    }

    if (sandboxState.kind === "missing") {
      if (realState.kind === "file") {
        sandboxRefreshReportFileNames.push(reportFileName);
        return {
          persistedReportFileNames,
          sandboxRefreshReportFileNames,
          recoverableError: new ToolExecutionError("bash 不能删除既有选中报告；请使用 edit_file/multi_edit 修改内容。", "INVALID_ARGUMENTS")
        };
      }
      continue;
    }

    if (realState.kind === "other") {
      sandboxRefreshReportFileNames.push(reportFileName);
      return {
        persistedReportFileNames,
        sandboxRefreshReportFileNames,
        recoverableError: new ToolExecutionError(`拒绝覆盖 reports 中的非普通文件: ${reportFileName}`, "UNSAFE_PATH")
      };
    }

    if (realState.kind === "file") {
      const [sandboxContent, realContent] = await Promise.all([
        fs.readFile(sandboxReportPath),
        fs.readFile(realReportPath)
      ]);
      if (sandboxContent.equals(realContent)) {
        continue;
      }
      if (!input.queriedReportFileNames.has(reportFileName) && !input.writtenReportFileNames.has(reportFileName)) {
        sandboxRefreshReportFileNames.push(reportFileName);
        return {
          persistedReportFileNames,
          sandboxRefreshReportFileNames,
          recoverableError: new ToolExecutionError(WRITE_FILE_EXISTING_REPORT_MESSAGE, "INVALID_ARGUMENTS")
        };
      }
    }

    await fs.mkdir(path.dirname(realReportPath), { recursive: true });
    await assertNoSymlinkTarget(realReportPath);
    await fs.copyFile(sandboxReportPath, realReportPath);
    await input.onReportPersisted(reportFileName);
    persistedReportFileNames.push(reportFileName);
    sandboxRefreshReportFileNames.push(reportFileName);
  }

  return { persistedReportFileNames, sandboxRefreshReportFileNames };
}

async function regularFileSyncState(filePath: string): Promise<{ kind: "file" | "missing" | "other" }> {
  try {
    const stat = await fs.lstat(filePath);
    return stat.isFile() ? { kind: "file" } : { kind: "other" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    throw error;
  }
}

async function syncRealReportsToBashSandbox(
  reportsRoot: string,
  sandbox: BashSandbox,
  reportFileNames: readonly string[]
): Promise<void> {
  await fs.mkdir(sandbox.reportsRoot, { recursive: true });
  for (const reportFileName of reportFileNames) {
    await syncRealReportToBashSandbox(reportsRoot, sandbox, reportFileName, "skip");
  }
}

async function syncRealReportToBashSandbox(
  reportsRoot: string,
  sandbox: BashSandbox,
  reportFileName: string,
  unsafeEntryBehavior: "skip" | "throw" = "throw"
): Promise<void> {
  await fs.mkdir(sandbox.reportsRoot, { recursive: true });
  const sourcePath = resolvePathWithinReportsRoot(reportsRoot, reportFileName);
  const targetPath = resolvePathWithinReportsRoot(sandbox.reportsRoot, reportFileName);
  const stat = await fs.lstat(sourcePath);
  if (stat.isSymbolicLink()) {
    if (unsafeEntryBehavior === "skip") {
      await fs.rm(targetPath, { force: true, recursive: true });
      return;
    }
    throw new Error(`拒绝同步 bash sandbox 中的符号链接: ${reportFileName}`);
  }
  if (!stat.isFile()) {
    if (unsafeEntryBehavior === "skip") {
      await fs.rm(targetPath, { force: true, recursive: true });
      return;
    }
    throw new Error(`拒绝同步 bash sandbox 中的非普通文件: ${reportFileName}`);
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await assertNoSymlinkTarget(targetPath);
  await fs.copyFile(sourcePath, targetPath);
}

async function copyRegularTreeWithinReports(input: {
  fromRoot: string;
  relativePath: string;
  toRoot: string;
  unsafeEntryBehavior?: "skip" | "throw";
}): Promise<void> {
  const unsafeEntryBehavior = input.unsafeEntryBehavior ?? "throw";
  const sourcePath = resolvePathWithinReportsRoot(input.fromRoot, input.relativePath);
  const targetPath = resolvePathWithinReportsRoot(input.toRoot, input.relativePath);
  const stat = await fs.lstat(sourcePath);
  if (stat.isSymbolicLink()) {
    if (unsafeEntryBehavior === "skip") {
      return;
    }
    throw new Error(`拒绝同步 bash sandbox 中的符号链接: ${input.relativePath || "."}`);
  }
  if (stat.isDirectory()) {
    await assertNoSymlinkTarget(targetPath);
    await fs.mkdir(targetPath, { recursive: true });
    const entries = await fs.readdir(sourcePath, { withFileTypes: true });
    for (const entry of entries) {
      await copyRegularTreeWithinReports({
        fromRoot: input.fromRoot,
        relativePath: path.join(input.relativePath, entry.name),
        toRoot: input.toRoot,
        unsafeEntryBehavior
      });
    }
    return;
  }
  if (!stat.isFile()) {
    if (unsafeEntryBehavior === "skip") {
      return;
    }
    throw new Error(`拒绝同步 bash sandbox 中的非普通文件: ${input.relativePath}`);
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await assertNoSymlinkTarget(targetPath);
  await fs.copyFile(sourcePath, targetPath);
}

function resolvePathWithinReportsRoot(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  const rootRelativePath = path.relative(resolvedRoot, resolvedPath);
  if (rootRelativePath.startsWith("..") || path.isAbsolute(rootRelativePath)) {
    throw new Error(`拒绝同步 reports 根目录外的路径: ${relativePath}`);
  }
  return resolvedPath;
}

async function assertNoSymlinkTarget(targetPath: string): Promise<void> {
  try {
    const targetStat = await fs.lstat(targetPath);
    if (targetStat.isSymbolicLink()) {
      throw new Error(`拒绝覆盖符号链接目标: ${targetPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export async function cleanupBashSandboxAfterWindow(input: {
  bashJobManager: Pick<BashJobManager, "closeWithGrace">;
  bashSandbox: BashSandbox;
  removeSandbox?: (sandbox: BashSandbox) => Promise<void>;
  syncReportsToReal?: (sandbox: BashSandbox) => Promise<void>;
  taskLogger?: TaskTextLogger;
  windowError?: unknown;
}): Promise<void> {
  const syncReportsToReal = input.syncReportsToReal ?? (async () => {});
  const removeSandboxFn = input.removeSandbox ?? removeBashSandbox;
  const teardownResult = await input.bashJobManager.closeWithGrace(1000);
  if (teardownResult.hasTimedOut()) {
    await appendBashTeardownWarning(input.taskLogger, teardownResult);
  }

  try {
    await syncReportsToReal(input.bashSandbox);
  } catch (error) {
    if (input.windowError === undefined) {
      throw error;
    }
    await appendBashCleanupWarning(input.taskLogger, "sandbox 报告同步失败", error);
  }

  try {
    await removeSandboxFn(input.bashSandbox);
  } catch (error) {
    await appendBashCleanupWarning(input.taskLogger, "sandbox 清理失败", error);
  }
}

async function appendBashTeardownWarning(
  taskLogger: TaskTextLogger | undefined,
  result: BashTeardownResult
): Promise<void> {
  await taskLogger?.append(["警告", "bash"], {
    类型: "后台任务关闭超时",
    原因: result.cause,
    未完成任务: result.timedOut
  });
}

async function appendBashCleanupWarning(
  taskLogger: TaskTextLogger | undefined,
  type: string,
  error: unknown
): Promise<void> {
  await taskLogger?.append(["警告", "bash"], {
    类型: type,
    错误: error instanceof Error ? error.message : String(error)
  });
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

  if (name === "edit_file" && typeof args.new_string === "string") {
    return {
      ...args,
      new_string: redactSecrets(args.new_string, secrets)
    };
  }

  if (name === UPSERT_REPORT_SECTION_TOOL_NAME) {
    const redactedArgs = {
      ...args,
      ...(typeof args.content === "string" ? { content: redactSecrets(args.content, secrets) } : {})
    };

    if (Array.isArray(args.updates)) {
      return {
        ...redactedArgs,
        updates: args.updates.map((update) => {
          if (!isPlainRecord(update) || typeof update.content !== "string") {
            return update;
          }

          return {
            ...update,
            content: redactSecrets(update.content, secrets)
          };
        })
      };
    }

    return redactedArgs;
  }

  if (name === "multi_edit" && Array.isArray(args.edits)) {
    return {
      ...args,
      edits: args.edits.map((edit) => {
        if (!isPlainRecord(edit) || typeof edit.new_string !== "string") {
          return edit;
        }

        return {
          ...edit,
          new_string: redactSecrets(edit.new_string, secrets)
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

function stringifyToolResult(result: unknown, secrets: readonly string[]): string {
  if (typeof result === "string") {
    return redactSecrets(result, secrets);
  }

  return redactSecrets(JSON.stringify(result) ?? "null", secrets);
}

function getToolPathArgument(args: unknown): string | undefined {
  if (!isPlainRecord(args) || typeof args.path !== "string") {
    return undefined;
  }

  return args.path;
}

function toPlainToolArgumentRecord(args: unknown): Record<string, unknown> | undefined {
  if (isPlainRecord(args)) {
    return args;
  }

  if (typeof args === "string") {
    return parseJsonObjectString(args);
  }

  return undefined;
}

function getWriteFileContentArgument(args: unknown): string | undefined {
  if (!isPlainRecord(args) || typeof args.content !== "string") {
    return undefined;
  }

  return args.content;
}

function isReportWriteTool(name: string): boolean {
  return name === "write_file" || name === "edit_file" || name === "multi_edit" || name === UPSERT_REPORT_SECTION_TOOL_NAME;
}

function isBashToolFamily(name: string): boolean {
  return name === "bash" || name === "bash_output" || name === "wait" || name === "kill_shell";
}

function getWritableReportContentFragments(toolCall: ChatCompletionRequestToolCall): string[] {
  if (!isPlainRecord(toolCall.arguments)) {
    return [];
  }

  if (toolCall.name === "write_file") {
    return typeof toolCall.arguments.content === "string" ? [toolCall.arguments.content] : [];
  }

  if (toolCall.name === "edit_file") {
    return typeof toolCall.arguments.new_string === "string" ? [toolCall.arguments.new_string] : [];
  }

  if (toolCall.name === UPSERT_REPORT_SECTION_TOOL_NAME) {
    return getUpsertReportSectionContentFragments(toolCall.arguments);
  }

  if (toolCall.name !== "multi_edit" || !Array.isArray(toolCall.arguments.edits)) {
    return [];
  }

  return toolCall.arguments.edits.flatMap((edit) =>
    isPlainRecord(edit) && typeof edit.new_string === "string" ? [edit.new_string] : []
  );
}

function getUpsertReportSectionContentFragments(args: Record<string, unknown>): string[] {
  const fragments = typeof args.content === "string" ? [args.content] : [];
  if (!Array.isArray(args.updates)) {
    return fragments;
  }

  return fragments.concat(args.updates.flatMap((update) =>
    isPlainRecord(update) && typeof update.content === "string" ? [update.content] : []
  ));
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

function normalizeScopeComparableToolPath(inputPath: string): string {
  const comparablePath = normalizeComparableToolPath(inputPath);
  const normalizedPath = path.posix.normalize(comparablePath);
  return normalizedPath === "." ? "." : normalizedPath.replace(/^(?:\/)+/u, "");
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
  if (!isReportWriteTool(input.toolCall.name) && input.toolCall.name !== MARK_NO_UPDATE_TOOL_NAME) {
    return input.toolCall.arguments;
  }

  if (
    input.toolCall.name === UPSERT_REPORT_SECTION_TOOL_NAME &&
    isPlainRecord(input.toolCall.arguments) &&
    typeof input.toolCall.arguments.outputFileName === "string"
  ) {
    return {
      ...input.toolCall.arguments,
      outputFileName: toAllowedWriteToolOutputFileName({
        allowedOutputFileNames: input.allowedOutputFileNames,
        artifacts: input.artifacts,
        pathArgument: input.toolCall.arguments.outputFileName
      })
    };
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
  if (!isDesktopReadScopeTool(input.toolCall.name)) {
    return input.toolCall.arguments;
  }

  if (!isPlainRecord(input.toolCall.arguments)) {
    return input.toolCall.arguments;
  }

  if (input.toolCall.name === "glob") {
    return normalizeGlobToolExecutionArguments(input);
  }

  if (input.toolCall.name === "ls" && input.toolCall.arguments.path === undefined) {
    return {
      ...input.toolCall.arguments,
      path: toProjectRelativeReportsRootPath(input.artifacts)
    };
  }

  if (typeof input.toolCall.arguments.path !== "string") {
    return input.toolCall.arguments;
  }

  const comparablePath = normalizeComparableToolPath(input.toolCall.arguments.path);
  if (comparablePath === input.manifestWindow.fileName) {
    return {
      ...input.toolCall.arguments,
      path: input.manifestWindow.textPath
    };
  }

  if (comparablePath === "reports" || ((input.toolCall.name === "grep" || input.toolCall.name === "ls") && comparablePath === ".")) {
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

function normalizeGlobToolExecutionArguments(input: {
  allowedOutputFileNames: ReadonlySet<string>;
  artifacts: WindowRunArtifacts;
  manifestWindow: RuntimeWindowManifestWindow;
  toolCall: ChatCompletionRequestToolCall;
}): unknown {
  if (!isPlainRecord(input.toolCall.arguments) || typeof input.toolCall.arguments.pattern !== "string") {
    return input.toolCall.arguments;
  }

  const pattern = normalizeComparableToolPath(input.toolCall.arguments.pattern);
  if (pattern === "." || pattern === "reports") {
    return {
      ...input.toolCall.arguments,
      pattern: `${toProjectRelativeReportsRootPath(input.artifacts)}/*`
    };
  }

  const reportsAliasPrefix = "reports/";
  if (pattern.startsWith(reportsAliasPrefix)) {
    return {
      ...input.toolCall.arguments,
      pattern: `${toProjectRelativeReportsRootPath(input.artifacts)}/${pattern.slice(reportsAliasPrefix.length)}`
    };
  }

  for (const outputFileName of input.allowedOutputFileNames) {
    if (pattern === normalizeComparableToolPath(outputFileName)) {
      return {
        ...input.toolCall.arguments,
        pattern: toProjectRelativeReportPath(input.artifacts, outputFileName)
      };
    }
  }

  if (!pattern.includes("/")) {
    return {
      ...input.toolCall.arguments,
      pattern: `${toProjectRelativeReportsRootPath(input.artifacts)}/${pattern}`
    };
  }

  return input.toolCall.arguments;
}

function isDesktopReadScopeTool(name: string): boolean {
  return name === "read_file" || name === "grep" || name === "glob" || name === "ls";
}

function assertReadToolExecutionScope(input: {
  allowedOutputFileNames: ReadonlySet<string>;
  artifacts: WindowRunArtifacts;
  executionArguments: unknown;
  manifestWindow: RuntimeWindowManifestWindow;
  toolName: string;
}): void {
  if (!isDesktopReadScopeTool(input.toolName)) {
    return;
  }

  const scopePathArgument = getReadScopePathArgument(input.toolName, input.executionArguments);
  if (scopePathArgument === undefined) {
    return;
  }

  const comparablePath = normalizeScopeComparableToolPath(scopePathArgument);
  const reportsRootPath = normalizeScopeComparableToolPath(toProjectRelativeReportsRootPath(input.artifacts));
  const allowedFilePaths = new Set<string>([normalizeScopeComparableToolPath(input.manifestWindow.textPath)]);

  for (const outputFileName of input.allowedOutputFileNames) {
    allowedFilePaths.add(normalizeScopeComparableToolPath(toProjectRelativeReportPath(input.artifacts, outputFileName)));
  }

  if (input.toolName === "glob" && comparablePath.startsWith(`${reportsRootPath}/`)) {
    return;
  }

  if (allowedFilePaths.has(comparablePath) || comparablePath === reportsRootPath) {
    return;
  }

  throw new ToolExecutionError(READ_TOOL_SCOPE_DENIED_MESSAGE, "UNSAFE_PATH");
}

function getReadScopePathArgument(toolName: string, executionArguments: unknown): string | undefined {
  const args = toPlainToolArgumentRecord(executionArguments);
  if (args === undefined) {
    return undefined;
  }

  if (toolName === "glob") {
    return typeof args.pattern === "string" ? args.pattern : undefined;
  }

  if (toolName === "grep" && args.path === undefined) {
    return ".";
  }

  if (toolName === "ls" && args.path === undefined) {
    return ".";
  }

  return getToolPathArgument(args);
}

function getReadScopeSecretCheckArguments(toolName: string, executionArguments: unknown): string[] {
  const args = toPlainToolArgumentRecord(executionArguments);
  if (args === undefined) {
    return [];
  }

  if (toolName === "grep") {
    return [args.path, args.pattern].filter((value): value is string => typeof value === "string");
  }

  const targetArgument = getReadScopePathArgument(toolName, args);
  return targetArgument === undefined ? [] : [targetArgument];
}

function getRecoverableToolErrorTargetArgument(toolName: string, executionArguments: unknown): string | undefined {
  return isDesktopReadScopeTool(toolName)
    ? getReadScopePathArgument(toolName, executionArguments)
    : getReportTargetArgument(toolName, executionArguments);
}

function assertBashToolExecutionScope(input: {
  executionArguments: unknown;
  toolName: string;
}): void {
  if (input.toolName !== "bash") {
    return;
  }

  const args = toPlainToolArgumentRecord(input.executionArguments);
  if (args === undefined || typeof args.command !== "string") {
    return;
  }

  const command = normalizeComparableToolPath(args.command);
  const hasPathTraversal = /(?:^|[\/\s"'`])\.\.(?:[\/\s"'`]|$)/u.test(command);
  const hasWindowsAbsolutePath = /[A-Za-z]:\//u.test(command);
  const hasPosixAbsolutePath = bashCommandReferencesPosixAbsolutePath(command);
  const hasProjectRelativeRoot = bashCommandReferencesProjectRelativeRoot(command);

  if (hasPathTraversal || hasWindowsAbsolutePath || hasPosixAbsolutePath || hasProjectRelativeRoot) {
    throw new ToolExecutionError(BASH_TOOL_SCOPE_DENIED_MESSAGE, "UNSAFE_PATH");
  }
}

function bashCommandReferencesPosixAbsolutePath(command: string): boolean {
  return command
    .split(/[\s"'`|;&<>()[\]{}]+/u)
    .some((token) => token.startsWith("/"));
}

function bashCommandReferencesProjectRelativeRoot(command: string): boolean {
  const forbiddenRoots = new Set(["apps", "assets", "config", "docs", "e2e", "packages", "rules", "runs"]);
  return command
    .split(/[\s"'`|;&<>()[\]{}]+/u)
    .map((token) => token.replace(/^(?:\.\/)+/u, ""))
    .some((token) => {
      const [root] = token.split("/", 1);
      return forbiddenRoots.has(root.toLowerCase());
    });
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

function getToolOutputFileNameArgument(args: unknown): string | undefined {
  if (!isPlainRecord(args) || typeof args.outputFileName !== "string") {
    return undefined;
  }

  return args.outputFileName;
}

function getReadReportExcerptFieldArguments(args: unknown): string[] {
  if (!isPlainRecord(args) || !Array.isArray(args.queries)) {
    return [];
  }

  return args.queries.flatMap((query) => {
    if (!isPlainRecord(query) || typeof query.cardName !== "string" || !Array.isArray(query.fields)) {
      return [];
    }

    return [query.cardName, ...query.fields.filter((field): field is string => typeof field === "string")];
  });
}

function getReportTargetArgument(toolName: string, args: unknown): string | undefined {
  return toolName === UPSERT_REPORT_SECTION_TOOL_NAME
    ? getToolOutputFileNameArgument(args)
    : getToolPathArgument(args);
}

function collectReadReportFieldKeys(args: unknown): string[] {
  const outputFileName = getToolOutputFileNameArgument(args);
  if (!outputFileName || !isPlainRecord(args) || !Array.isArray(args.queries)) {
    return [];
  }

  return args.queries.flatMap((query) => {
    if (!isPlainRecord(query) || typeof query.cardName !== "string" || !Array.isArray(query.fields)) {
      return [];
    }

    const cardName = query.cardName;
    return query.fields.flatMap((field) =>
      typeof field === "string" ? [createReportFieldKey(outputFileName, cardName, field)] : []
    );
  });
}

function collectUpsertReportFieldKeys(args: unknown): string[] {
  const outputFileName = getToolOutputFileNameArgument(args);
  if (!outputFileName || !isPlainRecord(args) || !Array.isArray(args.updates)) {
    return [];
  }

  return args.updates.flatMap((update) => {
    if (!isPlainRecord(update) || typeof update.cardName !== "string" || typeof update.fieldName !== "string") {
      return [];
    }

    return [createReportFieldKey(outputFileName, update.cardName, update.fieldName)];
  });
}

function createReportFieldKey(outputFileName: string, cardName: string, fieldName: string): string {
  return [
    normalizeReportFieldKeyPart(outputFileName),
    normalizeReportFieldKeyPart(cardName),
    normalizeReportFieldKeyPart(fieldName)
  ].join("\u0000");
}

function normalizeReportFieldKeyPart(value: string): string {
  return value.trim().normalize("NFC");
}

function describeReportFieldKey(key: string): string {
  return key.split("\u0000").join("/");
}

async function createReportInventory(input: {
  reportsRoot: string;
  templates: readonly TemplateDto[];
}): Promise<ReportInventoryItem[]> {
  const inventory: ReportInventoryItem[] = [];
  for (const template of input.templates) {
    const targetReportPath = toSafeReportFilePathForExistenceCheck(input.reportsRoot, template.fileName);
    inventory.push({
      outputFileName: template.fileName,
      exists: targetReportPath !== undefined && (await fileIsRegularFile(targetReportPath)),
      source: "selected_template"
    });
  }
  return inventory;
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
  enabledToolNameSet: ReadonlySet<string>;
  queriedReportFileNames: ReadonlySet<string>;
  reportsRoot: string;
  secrets: readonly string[];
  toolCall: ChatCompletionRequestToolCall;
  writtenReportFileNames: ReadonlySet<string>;
}): Promise<void> {
  const { toolCall } = input;

  if (!input.enabledToolNameSet.has(toolCall.name)) {
    throw new Error(`Tool is not enabled: ${toolCall.name}`);
  }

  if (toolCall.name === MARK_NO_UPDATE_TOOL_NAME) {
    const pathArgument = getToolPathArgument(toolCall.arguments);
    if (pathArgument === undefined) {
      return;
    }

    if (containsKnownSecret(pathArgument, input.secrets)) {
      throw new Error(`工具 ${toolCall.name} 的 path 包含已知 secret，已拒绝执行。`);
    }

    if (!input.allowedOutputFileNames.has(pathArgument)) {
      throw new Error(
        `工具 ${toolCall.name} 的 path 必须属于本轮选中模板 outputFileName：${redactSecrets(pathArgument, input.secrets)}`
      );
    }
    return;
  }

  if (toolCall.name === READ_REPORT_EXCERPT_TOOL_NAME) {
    const args = toPlainToolArgumentRecord(toolCall.arguments);
    const outputFileName = getToolOutputFileNameArgument(args);
    const secretArguments = [
      outputFileName,
      ...getReadReportExcerptFieldArguments(args),
      ...(Array.isArray(args?.keywords) ? args.keywords : [])
    ].filter((value): value is string => typeof value === "string");
    if (secretArguments.some((argument) => containsKnownSecret(argument, input.secrets))) {
      throw new Error(`读工具 ${toolCall.name} 的参数包含已知 secret，已拒绝执行。`);
    }
    if (outputFileName !== undefined && !input.allowedOutputFileNames.has(outputFileName)) {
      throw new Error(
        `工具 ${toolCall.name} 的 outputFileName 必须属于本轮选中模板 outputFileName：${redactSecrets(outputFileName, input.secrets)}`
      );
    }
    return;
  }

  if (isDesktopReadScopeTool(toolCall.name)) {
    const secretArgument = getReadScopeSecretCheckArguments(toolCall.name, toolCall.arguments).find((argument) =>
      containsKnownSecret(argument, input.secrets)
    );
    if (secretArgument !== undefined) {
      throw new Error(`读工具 ${toolCall.name} 的 path 包含已知 secret，已拒绝执行。`);
    }
    return;
  }

  if (!isReportWriteTool(toolCall.name)) {
    return;
  }

  const pathArgument = getReportTargetArgument(toolCall.name, toolCall.arguments);
  if (pathArgument === undefined) {
    return;
  }
  const targetLabel = toolCall.name === UPSERT_REPORT_SECTION_TOOL_NAME ? "outputFileName" : "path";

  if (containsKnownSecret(pathArgument, input.secrets)) {
    throw new Error(`写工具 ${toolCall.name} 的 ${targetLabel} 包含已知 secret，已拒绝执行。`);
  }

  if (!input.allowedOutputFileNames.has(pathArgument)) {
    throw new Error(
      `写工具 ${toolCall.name} 的 ${targetLabel} 必须属于本轮选中模板 outputFileName：${redactSecrets(pathArgument, input.secrets)}`
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
      `写工具 ${toolCall.name} 不能直接修改既有报告；请先用 read_report_excerpt 按卡片名和字段名读取目标字段块，再用 upsert_report_section 替换同一字段：${redactSecrets(pathArgument, input.secrets)}`
    );
  }
}

function recordReportQuery(input: {
  artifacts: WindowRunArtifacts;
  allowedOutputFileNames: ReadonlySet<string>;
  queriedReportFieldKeys: Set<string>;
  queriedReportFileNames: Set<string>;
  toolCall: ChatCompletionRequestToolCall;
  toolResult: unknown;
}): void {
  if (input.toolCall.name === READ_REPORT_EXCERPT_TOOL_NAME) {
    const outputFileName = getToolOutputFileNameArgument(input.toolCall.arguments);
    if (outputFileName !== undefined && input.allowedOutputFileNames.has(outputFileName)) {
      for (const fieldKey of collectReadReportFieldKeys(input.toolCall.arguments)) {
        input.queriedReportFieldKeys.add(fieldKey);
      }
    }
    return;
  }

  if (input.toolCall.name !== "read_file" && input.toolCall.name !== "grep") {
    return;
  }

  const pathArgument = getReportTargetArgument(input.toolCall.name, input.toolCall.arguments);
  if (pathArgument === undefined) {
    return;
  }

  const reportFileName = toQueriedReportFileName(pathArgument, input.artifacts);
  if (reportFileName && input.allowedOutputFileNames.has(reportFileName)) {
    input.queriedReportFileNames.add(reportFileName);
  }

  if (input.toolCall.name !== "grep" || typeof input.toolResult !== "string") {
    return;
  }

  for (const matchPath of extractGrepResultPaths(input.toolResult)) {
    const matchReportFileName = toQueriedReportFileName(matchPath, input.artifacts);
    if (matchReportFileName && input.allowedOutputFileNames.has(matchReportFileName)) {
      input.queriedReportFileNames.add(matchReportFileName);
    }
  }
}

function extractGrepResultPaths(toolResult: string): string[] {
  return toolResult
    .split(/\r?\n/u)
    .flatMap((line) => {
      const match = /^(.+?):\d+:/u.exec(line);
      return match ? [match[1]] : [];
    });
}

function recordSuccessfulReportWrite(input: {
  artifacts: WindowRunArtifacts;
  allowedOutputFileNames: ReadonlySet<string>;
  writtenReportFileNames: Set<string>;
  toolCall: ChatCompletionRequestToolCall;
}): void {
  const pathArgument = getReportTargetArgument(input.toolCall.name, input.toolCall.arguments);
  if (pathArgument === undefined) {
    return;
  }

  const reportFileName = toQueriedReportFileName(pathArgument, input.artifacts);
  if (reportFileName && input.allowedOutputFileNames.has(reportFileName)) {
    input.writtenReportFileNames.add(reportFileName);
  }
}

function classifyToolErrorForRuntime(name: string, error: unknown): ToolErrorClassification {
  return classifyToolExecutionError({
    toolName: name,
    error,
    hints: TOOL_LOOP_DEFAULTS.recoverableToolErrorHints
  });
}

function toRecoverableToolErrorResult(input: {
  classification: ToolErrorClassification;
  code?: string;
  executionArguments: unknown;
  error: ToolExecutionError;
  hint?: string;
  output?: string;
  path?: string;
  secrets: readonly string[];
  toolName: string;
}): Record<string, unknown> {
  const pathArgument = input.path ?? getRecoverableToolErrorTargetArgument(input.toolName, input.executionArguments);
  const hint = input.hint ?? input.classification.hint;
  const output = input.output ?? input.error.output;

  return {
    error: {
      code: input.code ?? input.error.code,
      message: redactSecrets(input.error.message, input.secrets)
    },
    classification: input.classification.category,
    reason: input.classification.reason,
    ...(output !== undefined ? { output: redactSecrets(output, input.secrets) } : {}),
    ...(hint ? { hint: redactSecrets(hint, input.secrets) } : {}),
    ...(pathArgument ? { path: redactSecrets(pathArgument, input.secrets) } : {})
  };
}

const TOOL_EXECUTION_ERROR_CODES = new Set<string>([
  "UNKNOWN_TOOL",
  "INVALID_ARGUMENTS",
  "UNSAFE_PATH",
  "NOT_FOUND",
  "IO_ERROR",
  "CARD_NOT_FOUND",
  "FIELD_NOT_FOUND",
  "FIELD_AMBIGUOUS",
  "INVALID_FIELD_CONTENT"
]);

function toToolExecutionErrorCode(code: unknown): ToolExecutionError["code"] {
  return typeof code === "string" && TOOL_EXECUTION_ERROR_CODES.has(code)
    ? (code as ToolExecutionError["code"])
    : "INVALID_ARGUMENTS";
}

function getToolResultErrorCode(toolResult: Record<string, unknown>): string | undefined {
  const error = isPlainRecord(toolResult.error) ? toolResult.error : {};
  return typeof error.code === "string" ? error.code : undefined;
}

function toRecoverableToolResultError(toolResult: Record<string, unknown>): ToolExecutionError {
  const error = isPlainRecord(toolResult.error) ? toolResult.error : {};
  const message = typeof error.message === "string" ? error.message : "可恢复工具错误";
  const output = typeof toolResult.output === "string" ? toolResult.output : undefined;
  const classificationCode = typeof toolResult.classificationCode === "string" ? toolResult.classificationCode : error.code;
  return new ToolExecutionError(message, toToolExecutionErrorCode(classificationCode), output);
}

function toClassifiedPreExecutionRecoverableToolResult(input: {
  classification: ToolErrorClassification;
  error: ToolExecutionError;
  executionArguments: unknown;
  preExecutionResult: Record<string, unknown>;
  secrets: readonly string[];
  toolName: string;
}): Record<string, unknown> {
  return toRecoverableToolErrorResult({
    classification: input.classification,
    executionArguments: input.executionArguments,
    error: input.error,
    code: getToolResultErrorCode(input.preExecutionResult),
    ...(typeof input.preExecutionResult.hint === "string" ? { hint: input.preExecutionResult.hint } : {}),
    ...(typeof input.preExecutionResult.output === "string" ? { output: input.preExecutionResult.output } : {}),
    ...(typeof input.preExecutionResult.path === "string" ? { path: input.preExecutionResult.path } : {}),
    secrets: input.secrets,
    toolName: input.toolName
  });
}

function guardRepeatedRecoverableToolError(input: {
  counts: Map<string, number>;
  error: ToolExecutionError;
  executionArguments: unknown;
  maxRepeatedRecoverableToolErrors: number;
  secrets: readonly string[];
  toolName: string;
}): void {
  const pathArgument = getRecoverableToolErrorTargetArgument(input.toolName, input.executionArguments);
  const fingerprint = fingerprintRecoverableToolError({
    toolName: input.toolName,
    error: input.error,
    path: pathArgument
  });
  const nextCount = (input.counts.get(fingerprint) ?? 0) + 1;
  input.counts.set(fingerprint, nextCount);

  if (nextCount > input.maxRepeatedRecoverableToolErrors) {
    throw new Error(
      `同一工具错误重复超过 ${input.maxRepeatedRecoverableToolErrors} 次：${redactSecrets(input.error.message, input.secrets)}`
    );
  }
}

function incrementToolLoopRoundReason(
  counts: Map<ToolLoopRoundReason, number>,
  reason: ToolLoopRoundReason | undefined
): void {
  if (!reason) {
    return;
  }
  counts.set(reason, (counts.get(reason) ?? 0) + 1);
}

function toToolLoopRoundReasonLogFields(
  reason: ToolLoopRoundReason | undefined
): { 继续原因: string; 继续原因标签: ToolLoopRoundReason; 继续原因文本: string } | Record<string, never> {
  return reason
    ? {
        继续原因标签: reason,
        继续原因: TOOL_LOOP_ROUND_REASON_LABELS[reason],
        继续原因文本: `继续原因：${TOOL_LOOP_ROUND_REASON_LABELS[reason]}`
      }
    : {};
}

function toToolLoopReasonCountRecord(
  counts: ReadonlyMap<ToolLoopRoundReason, number>
): Partial<Record<ToolLoopRoundReason, number>> {
  const out: Partial<Record<ToolLoopRoundReason, number>> = {};
  for (const reason of Object.keys(TOOL_LOOP_ROUND_REASON_LABELS) as ToolLoopRoundReason[]) {
    const count = counts.get(reason);
    if (count && count > 0) {
      out[reason] = count;
    }
  }
  return out;
}

function createToolNotEnabledRecoverableResult(input: {
  enabledToolNameSet: ReadonlySet<string>;
  secrets: readonly string[];
  toolCall: ChatCompletionRequestToolCall;
}): Record<string, unknown> | undefined {
  if (input.enabledToolNameSet.has(input.toolCall.name)) {
    return undefined;
  }

  return {
    error: {
      code: "UNKNOWN_TOOL",
      message: redactSecrets(`Tool is not enabled: ${input.toolCall.name}`, input.secrets)
    }
  };
}

const REPORT_INVENTORY_ALREADY_PROVIDED_CODE = "REPORT_INVENTORY_ALREADY_PROVIDED";
const REPORT_INVENTORY_ALREADY_PROVIDED_MESSAGE =
  "报告清单已提供；请直接根据清单判断已有报告和待创建报告，不要再调用目录或 shell 类工具查找报告是否存在。";

export function interceptReportDiscoveryToolCall(input: {
  args: unknown;
  reportDirectoryPaths?: readonly string[];
  reportInventory: readonly ReportInventoryItem[];
  toolName: string;
}): Record<string, unknown> | undefined {
  if (!isReportDiscoveryToolCall(input)) {
    return undefined;
  }

  return {
    code: REPORT_INVENTORY_ALREADY_PROVIDED_CODE,
    classificationCode: "UNSAFE_PATH",
    error: {
      code: REPORT_INVENTORY_ALREADY_PROVIDED_CODE,
      message: REPORT_INVENTORY_ALREADY_PROVIDED_MESSAGE
    }
  };
}

function isReportDiscoveryToolCall(input: {
  args: unknown;
  reportDirectoryPaths?: readonly string[];
  reportInventory: readonly ReportInventoryItem[];
  toolName: string;
}): boolean {
  const args = toPlainToolArgumentRecord(input.args);
  if (args === undefined) {
    return false;
  }

  if (input.toolName === "glob") {
    return typeof args.pattern === "string" && isReportDiscoveryGlobPattern(args.pattern, input);
  }

  if (input.toolName === "ls") {
    return typeof args.path === "string" && isReportDirectoryTarget(args.path, input.reportDirectoryPaths);
  }

  if (input.toolName === "bash") {
    return typeof args.command === "string" && isReportDiscoveryBashCommand(args.command, input);
  }

  return false;
}

function isReportDiscoveryGlobPattern(
  pattern: string,
  input: {
    reportDirectoryPaths?: readonly string[];
    reportInventory: readonly ReportInventoryItem[];
  }
): boolean {
  const comparablePattern = normalizeReportDiscoveryComparablePath(pattern);
  if (isKnownReportOutputTarget(comparablePattern, input.reportInventory)) {
    return true;
  }

  if (!isReportsMarkdownGlob(comparablePattern)) {
    return false;
  }

  return (
    comparablePattern.startsWith("reports/") ||
    (input.reportDirectoryPaths ?? []).some((directoryPath) =>
      comparablePattern.startsWith(`${normalizeComparableToolPath(directoryPath)}/`)
    )
  );
}

function isReportDiscoveryBashCommand(
  command: string,
  input: {
    reportDirectoryPaths?: readonly string[];
    reportInventory: readonly ReportInventoryItem[];
  }
): boolean {
  const comparableCommand = normalizeReportDiscoveryComparablePath(command);
  if (!/\b(?:cat|dir|fd|find|gc|gci|get-childitem|get-content|grep|ls|rg|select-string|type|wc)\b/u.test(comparableCommand)) {
    return false;
  }

  return (
    commandMentionsKnownReportOutput(comparableCommand, input.reportInventory) ||
    isCurrentReportDirectoryBashDiscoveryCommand(comparableCommand) ||
    /\breports(?:\/|\b)/iu.test(comparableCommand) ||
    (input.reportDirectoryPaths ?? []).some((directoryPath) =>
      comparableCommand.includes(normalizeReportDiscoveryComparablePath(directoryPath))
    )
  );
}

function isCurrentReportDirectoryBashDiscoveryCommand(command: string): boolean {
  if (/^(?:dir|gci|get-childitem|ls)(?:\s+(?:-[\w-]+|\.))*$/u.test(command)) {
    return true;
  }

  if (/^(?:fd|find|grep|rg|select-string)\b/u.test(command) && /(?:\*\.md|\.md\b)/u.test(command)) {
    return true;
  }

  return /^wc\b/u.test(command) && /(?:\*\.md|\.md\b)/u.test(command);
}

function commandMentionsKnownReportOutput(
  command: string,
  reportInventory: readonly ReportInventoryItem[]
): boolean {
  return reportInventory.some(({ outputFileName }) =>
    command.includes(normalizeReportDiscoveryComparablePath(outputFileName))
  );
}

function isReportsMarkdownGlob(pattern: string): boolean {
  return /(?:^|\/)reports\/(?:\*\*\/)?\*\.md$/iu.test(pattern);
}

function isKnownReportOutputTarget(
  target: string,
  reportInventory: readonly ReportInventoryItem[]
): boolean {
  const comparableTarget = normalizeReportDiscoveryComparablePath(target);
  return reportInventory.some(({ outputFileName }) => {
    const comparableOutputFileName = normalizeReportDiscoveryComparablePath(outputFileName);
    return comparableTarget === comparableOutputFileName || comparableTarget.endsWith(`/${comparableOutputFileName}`);
  });
}

function isReportDirectoryTarget(
  target: string,
  reportDirectoryPaths: readonly string[] | undefined
): boolean {
  const comparableTarget = normalizeReportDiscoveryComparablePath(target);
  if (comparableTarget === "reports" || comparableTarget.endsWith("/reports")) {
    return true;
  }

  return (reportDirectoryPaths ?? []).some(
    (directoryPath) => comparableTarget === normalizeReportDiscoveryComparablePath(directoryPath)
  );
}

function normalizeReportDiscoveryComparablePath(value: string): string {
  return normalizeComparableToolPath(value).replace(/\/+$/u, "").toLowerCase();
}

async function createExistingReportWriteRecoverableResult(input: {
  queriedReportFieldKeys: ReadonlySet<string>;
  queriedReportFileNames: ReadonlySet<string>;
  reportsRoot: string;
  secrets: readonly string[];
  toolCall: ChatCompletionRequestToolCall;
  writtenReportFileNames: ReadonlySet<string>;
}): Promise<Record<string, unknown> | undefined> {
  if (input.toolCall.name !== "write_file" && input.toolCall.name !== UPSERT_REPORT_SECTION_TOOL_NAME) {
    return undefined;
  }

  const pathArgument = getReportTargetArgument(input.toolCall.name, input.toolCall.arguments);
  if (pathArgument === undefined) {
    return undefined;
  }

  const targetReportPath = toSafeReportFilePathForExistenceCheck(input.reportsRoot, pathArgument);
  if (!targetReportPath || !(await fileIsRegularFile(targetReportPath))) {
    return undefined;
  }

  if (input.toolCall.name === UPSERT_REPORT_SECTION_TOOL_NAME) {
    const missingFieldKeys = collectUpsertReportFieldKeys(input.toolCall.arguments).filter(
      (fieldKey) => !input.queriedReportFieldKeys.has(fieldKey)
    );
    if (missingFieldKeys.length > 0) {
      return {
        error: {
          code: "INVALID_ARGUMENTS",
          message: redactSecrets(UPSERT_EXISTING_REPORT_MESSAGE, input.secrets)
        },
        missingFields: missingFieldKeys.map((fieldKey) => redactSecrets(describeReportFieldKey(fieldKey), input.secrets)),
        path: redactSecrets(pathArgument, input.secrets)
      };
    }

    return undefined;
  }

  if (!input.queriedReportFileNames.has(pathArgument) && !input.writtenReportFileNames.has(pathArgument)) {
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

async function createOversizedSelectedReportReadRecoverableResult(input: {
  allowedOutputFileNames: ReadonlySet<string>;
  artifacts: WindowRunArtifacts;
  executionArguments: unknown;
  reportsRoot: string;
  secrets: readonly string[];
  toolCall: ChatCompletionRequestToolCall;
}): Promise<Record<string, unknown> | undefined> {
  if (input.toolCall.name !== "read_file") {
    return undefined;
  }

  const pathArgument = getToolPathArgument(input.executionArguments);
  if (pathArgument === undefined) {
    return undefined;
  }

  const reportFileName = toQueriedReportFileName(pathArgument, input.artifacts);
  if (reportFileName === undefined || !input.allowedOutputFileNames.has(reportFileName)) {
    return undefined;
  }

  const targetReportPath = toSafeReportFilePathForExistenceCheck(input.reportsRoot, reportFileName);
  if (targetReportPath === undefined) {
    return undefined;
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(targetReportPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  if (!stat.isFile() || stat.size <= DEFAULT_MAX_READ_BYTES) {
    return undefined;
  }

  return {
    error: {
      code: "INVALID_ARGUMENTS",
      message: redactSecrets(OVERSIZED_REPORT_READ_MESSAGE, input.secrets)
    },
    hint: redactSecrets(OVERSIZED_REPORT_READ_HINT, input.secrets),
    path: redactSecrets(reportFileName, input.secrets)
  };
}

function createInternalReportContentMetadataRecoverableResult(input: {
  secrets: readonly string[];
  toolCall: ChatCompletionRequestToolCall;
}): Record<string, unknown> | undefined {
  if (!isReportWriteTool(input.toolCall.name)) {
    return undefined;
  }

  const contentFragments = getWritableReportContentFragments(input.toolCall);
  const unsafeMetadata = findInternalReportContentMetadata(contentFragments);
  if (!unsafeMetadata) {
    return undefined;
  }

  const pathArgument = getReportTargetArgument(input.toolCall.name, input.toolCall.arguments);

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
  if (!isReportWriteTool(input.toolCall.name)) {
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

  const pathArgument = getReportTargetArgument(input.toolCall.name, input.toolCall.arguments);

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
  if (!isReportWriteTool(input.toolCall.name)) {
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

  const pathArgument = getReportTargetArgument(input.toolCall.name, input.toolCall.arguments);

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
    (input.toolCall.name === "read_file" || input.toolCall.name === "grep" || input.toolCall.name === READ_REPORT_EXCERPT_TOOL_NAME)
  );
}

function createBatchOutcomeCorrectionMessage(tracker: BatchOutcomeTracker): string {
  const missingOutputs = tracker.missingOutputFileNames().join("、");
  return [
    `上一轮尚未为本批次所有选中模板提供处理结果，缺少 outputFileName：${missingOutputs}。`,
    "下一轮只处理上述缺失 outputFileName；已完成处理结果的输出文件不要继续读取、编辑或重写。",
    "请对每个缺失 outputFileName 调用 write_file/edit_file/multi_edit 写入正式报告，或调用 mark_no_update 标记本窗口无新增信息。",
    "如果缺失模板没有当前窗口明确证据，立即调用 mark_no_update；不要为了无新增模板继续查询或修改其他报告。",
    "如果本批所有模板都没有可写入的新信息，最终文本必须严格返回 NO_UPDATE。"
  ].join("\n");
}

function replaceBatchOutcomeCorrectionMessage(
  messages: ChatCompletionMessage[],
  correctionMessage: string
): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message.role === "user" &&
      typeof message.content === "string" &&
      message.content.startsWith(BATCH_OUTCOME_CORRECTION_PREFIX)
    ) {
      messages.splice(index, 1);
    }
  }

  messages.push({
    role: "user",
    content: correctionMessage
  });
}

export function createWindowRunService(options: WindowRunServiceOptions): WindowRunService {
  const enabledToolNames = options.enabledToolNames ?? DEFAULT_ENABLED_TOOL_NAMES;
  const enabledToolNameSet = new Set<string>(enabledToolNames);
  const toolSchemas = getEnabledTools([...enabledToolNames]).map(toLlmToolSchema);

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

    await options.registerReport({ path: reportPath, report });
    return report;
  }

  async function executeWindowToolLoop(input: {
    artifacts: WindowRunArtifacts;
    batchIndex: number;
    batchMaxTemplatesPerCall: number;
    batchTotal: number;
    client: OpenAiCompatibleClient;
    job: WindowRunJobInput;
    manifestWindow: RuntimeWindowManifestWindow;
    modelId: string;
    providerId: string;
    totalWindowCount: number;
    toolLoopRoundReasonCounts: Map<ToolLoopRoundReason, number>;
    windowText: string;
  }): Promise<{ content: string; outcomes: BatchOutcome[]; usage: TokenUsage }> {
    const reportsRoot = toReportsRoot(input.artifacts);
    await fs.mkdir(reportsRoot, { recursive: true });

    const secrets = await getReportRedactionSecrets(input.job.input.providerConfigId);
    options.taskLogger?.setSecrets(secrets);
    const allowedOutputFileNames = new Set(input.artifacts.templates.map((template) => template.fileName));
    const outcomeTracker = createBatchOutcomeTracker(
      input.artifacts.templates.map((template) => ({
        templateId: template.id,
        templateName: template.name,
        outputFileName: template.fileName
      }))
    );
    const reportInventory = await createReportInventory({
      reportsRoot,
      templates: input.artifacts.templates
    });
    const templatePromptProfiles = buildTemplatePromptProfiles(input.artifacts.templates);
    const queriedReportFieldKeys = new Set<string>();
    const queriedReportFileNames = new Set<string>();
    const writtenReportFileNames = new Set<string>();
    const bashJobManager = new BashJobManager();
    const bashSessionId = `${input.job.id}:${input.manifestWindow.windowId}:batch-${input.batchIndex + 1}`;
    const bashSandbox = await createBashSandbox(reportsRoot, input.artifacts.project.rootPath);
    const messages: ChatCompletionMessage[] = [
      {
        role: "system",
        content: buildStableSystemPrompt({
          toolLoopInstruction: TOOL_LOOP_DEFAULTS.systemInstruction,
          windowInstructionLines: TOOL_LOOP_DEFAULTS.windowInstructionLines
        })
      },
      {
        role: "user",
        content: buildWindowUserPrompt({
          artifacts: input.artifacts,
          currentDate: toPromptDate(options.clock.now()),
          manifestWindow: input.manifestWindow,
          reportInventory,
          templatePromptProfiles,
          totalWindowCount: input.totalWindowCount,
          windowText: input.windowText
        })
      }
    ];
    let usage = { ...EMPTY_USAGE };
    let currentRoundIndex: number | undefined;
    let caughtWindowError: unknown;
    const recoverableToolErrorCounts = new Map<string, number>();
    const maxRepeatedRecoverableToolErrors = TOOL_LOOP_DEFAULTS.maxRepeatedRecoverableToolErrors;

    const persistBashSandboxReportChanges = async (): Promise<Record<string, unknown> | undefined> => {
      const syncResult = await syncBashSandboxReportsToReal({
        allowedOutputFileNames,
        onReportPersisted: async (reportFileName) => {
          await registerTemplateOutputReport({
            artifacts: input.artifacts,
            reportFileName
          });
          writtenReportFileNames.add(reportFileName);
          outcomeTracker.recordWritten(reportFileName);
        },
        queriedReportFileNames,
        reportsRoot,
        sandbox: bashSandbox,
        writtenReportFileNames
      });

      if (syncResult.sandboxRefreshReportFileNames.length > 0) {
        await syncRealReportsToBashSandbox(reportsRoot, bashSandbox, syncResult.sandboxRefreshReportFileNames);
      }

      if (syncResult.recoverableError === undefined) {
        return undefined;
      }

      const classification = classifyToolErrorForRuntime("bash", syncResult.recoverableError);
      guardRepeatedRecoverableToolError({
        counts: recoverableToolErrorCounts,
        error: syncResult.recoverableError,
        executionArguments: {},
        maxRepeatedRecoverableToolErrors,
        secrets,
        toolName: "bash"
      });
      return toRecoverableToolErrorResult({
        classification,
        executionArguments: {},
        error: syncResult.recoverableError,
        secrets,
        toolName: "bash"
      });
    };

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
        分批策略: `按模板数量分批：每批最多 ${input.batchMaxTemplatesPerCall} 个模板`,
        模板: input.artifacts.templates.map((template) => ({
          模板ID: template.id,
          模板名称: template.name,
          输出文件: template.fileName
        })),
        模板Prompt压缩: templatePromptProfiles.map((profile) => ({
          模板ID: profile.templateId,
          模板名称: profile.templateName,
          输出文件: profile.outputFileName,
          模板Hash: profile.templateHash,
          压缩版本: profile.compressionVersion,
          原始字符数: profile.originalChars,
          卡片字符数: profile.profileChars,
          压缩率: Number(profile.compressionRatio.toFixed(4)),
          是否回退: profile.fallback,
          回退原因: profile.fallbackReason
        }))
      });

      for (let roundIndex = 0; ; roundIndex += 1) {
        currentRoundIndex = roundIndex + 1;
        const backgroundJobNote = bashJobManager.drainCompletedNoteForSession(bashSessionId);
        if (backgroundJobNote !== "") {
          const bashReportSyncError = await persistBashSandboxReportChanges();
          messages.push({
            role: "user",
            content:
              bashReportSyncError === undefined
                ? backgroundJobNote
                : `${backgroundJobNote}\n\nbash report sync result:\n${stringifyToolResult(bashReportSyncError, secrets)}`
          });
        }

        await options.taskLogger?.append(
          ["大模型请求", "Prompt"],
          serializeModelRequestForTaskLog({
            value: {
              供应商: input.providerId,
              模型: input.modelId,
              窗口: `${input.manifestWindow.index + 1}/${input.totalWindowCount}`,
              批次: `${input.batchIndex + 1}/${input.batchTotal}`,
              轮次: currentRoundIndex,
              messages,
              tools: toolSchemas
            },
            windowFileName: input.manifestWindow.fileName,
            windowText: input.windowText
          })
        );
        const completion = await input.client.chatCompletion({
          providerId: input.providerId,
          modelId: input.modelId,
          messages,
          tools: toolSchemas
        });
        const usageDelta = mapUsage(completion.normalizedUsage);
        usage = addUsage(usage, usageDelta);

        await options.taskLogger?.append(["大模型返回"], {
          轮次: currentRoundIndex,
          正文: redactSecrets(completion.content, secrets),
          工具调用: redactJsonValue(completion.toolCalls, secrets),
          Token使用: usageDelta
        });

        if (completion.toolCalls.length === 0) {
          const completionText = completion.content.trim();
          if (completionText === "NO_UPDATE" && outcomeTracker.outcomes().length === 0) {
            outcomeTracker.recordBatchNoUpdate("NO_UPDATE");
          }

          if (!outcomeTracker.isComplete()) {
            const correctionMessage =
              outcomeTracker.outcomes().length === 0 && completionText !== "NO_UPDATE"
                ? NO_TOOL_PROTOCOL_CORRECTION_MESSAGE
                : createBatchOutcomeCorrectionMessage(outcomeTracker);
            const retryReason =
              correctionMessage === NO_TOOL_PROTOCOL_CORRECTION_MESSAGE
                ? undefined
                : "missing_template_outcome";
            incrementToolLoopRoundReason(input.toolLoopRoundReasonCounts, retryReason);
            await options.taskLogger?.append(["上下文", "重试"], {
              原因: correctionMessage,
              ...toToolLoopRoundReasonLogFields(retryReason)
            });
            messages.push({
              role: "assistant",
              content: redactSecrets(completion.content, secrets)
            });
            if (correctionMessage === NO_TOOL_PROTOCOL_CORRECTION_MESSAGE) {
              messages.push({
                role: "user",
                content: correctionMessage
              });
            } else {
              replaceBatchOutcomeCorrectionMessage(messages, correctionMessage);
            }
            continue;
          }

          await options.taskLogger?.append(["上下文", "批次结果"], {
            窗口: `${input.manifestWindow.index + 1}/${input.totalWindowCount}`,
            批次: `${input.batchIndex + 1}/${input.batchTotal}`,
            处理结果: outcomeTracker.outcomes()
          });
          return {
            content: redactSecrets(completion.content, secrets),
            outcomes: outcomeTracker.outcomes(),
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
          const normalizesOutputPath = isReportWriteTool(toolCall.name) || toolCall.name === MARK_NO_UPDATE_TOOL_NAME;
          const executionArguments = redactWritableToolArguments(toolCall.name, executionSourceArguments, secrets);
          const replaySourceArguments = redactWritableToolArguments(
            toolCall.name,
            normalizesOutputPath ? executionSourceArguments : toolCall.arguments,
            secrets
          );
          const replayArguments = redactJsonValue(replaySourceArguments, secrets);

          return {
            ...toolCall,
            arguments: normalizesOutputPath ? toToolCallArguments(executionSourceArguments) : toolCall.arguments,
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
            实际执行输入: redactJsonValue(toolCall.executionArguments, secrets)
          });

          const toolNotEnabledRecoverableToolResult = createToolNotEnabledRecoverableResult({
            enabledToolNameSet,
            secrets,
            toolCall
          });
          const reportDiscoveryRecoverableToolResult =
            toolNotEnabledRecoverableToolResult === undefined
              ? interceptReportDiscoveryToolCall({
                  args: toolCall.executionArguments,
                  reportDirectoryPaths: [toProjectRelativeReportsRootPath(input.artifacts), "reports"],
                  reportInventory,
                  toolName: toolCall.name
                })
              : undefined;
          if (!toolNotEnabledRecoverableToolResult && !reportDiscoveryRecoverableToolResult) {
            await validateToolCallBeforeExecution({
              allowedOutputFileNames,
              artifacts: input.artifacts,
              enabledToolNameSet,
              queriedReportFileNames,
              reportsRoot,
              secrets,
              toolCall,
              writtenReportFileNames
            });
          }

          let toolResult: unknown;
          let returnedRecoverableToolError = false;
          let toolLoopRoundReason: ToolLoopRoundReason | undefined;
          const preExecutionRecoverableToolResult =
            toolNotEnabledRecoverableToolResult ??
            reportDiscoveryRecoverableToolResult ??
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
            (await createOversizedSelectedReportReadRecoverableResult({
              allowedOutputFileNames,
              artifacts: input.artifacts,
              executionArguments: toolCall.executionArguments,
              reportsRoot,
              secrets,
              toolCall
            })) ??
            (await createExistingReportWriteRecoverableResult({
              queriedReportFieldKeys,
              queriedReportFileNames,
              reportsRoot,
              secrets,
              toolCall,
              writtenReportFileNames
            }));
          if (preExecutionRecoverableToolResult) {
            const preExecutionRecoverableToolError = toRecoverableToolResultError(preExecutionRecoverableToolResult);
            const classification = classifyToolErrorForRuntime(toolCall.name, preExecutionRecoverableToolError);
            toolLoopRoundReason = classifyToolLoopRoundReason({
              allowedOutputFileNames,
              classification,
              error: preExecutionRecoverableToolError,
              executionArguments: toolCall.executionArguments,
              toolName: toolCall.name
            });
            incrementToolLoopRoundReason(input.toolLoopRoundReasonCounts, toolLoopRoundReason);
            guardRepeatedRecoverableToolError({
              counts: recoverableToolErrorCounts,
              error: preExecutionRecoverableToolError,
              executionArguments: toolCall.executionArguments,
              maxRepeatedRecoverableToolErrors,
              secrets,
              toolName: toolCall.name
            });
            returnedRecoverableToolError = true;
            toolResult = toClassifiedPreExecutionRecoverableToolResult({
              classification,
              error: preExecutionRecoverableToolError,
              executionArguments: toolCall.executionArguments,
              preExecutionResult: preExecutionRecoverableToolResult,
              secrets,
              toolName: toolCall.name
            });
          } else {
            try {
              assertReadToolExecutionScope({
                allowedOutputFileNames,
                artifacts: input.artifacts,
                executionArguments: toolCall.executionArguments,
                manifestWindow: input.manifestWindow,
                toolName: toolCall.name
              });
              assertBashToolExecutionScope({
                executionArguments: toolCall.executionArguments,
                toolName: toolCall.name
              });
              toolResult = await executeBuiltinFileTool(toolCall.name, toolCall.executionArguments, {
                projectRoot: isBashToolFamily(toolCall.name) ? bashSandbox.reportsRoot : input.artifacts.project.rootPath,
                reportsRoot: isBashToolFamily(toolCall.name) ? bashSandbox.reportsRoot : reportsRoot,
                allowedReportFileNames: [...allowedOutputFileNames],
                readAliasRoots: [
                  {
                    token: input.manifestWindow.textPath,
                    root: path.join(input.artifacts.project.rootPath, input.manifestWindow.textPath)
                  },
                  {
                    token: input.manifestWindow.fileName,
                    root: path.join(input.artifacts.project.rootPath, input.manifestWindow.textPath)
                  }
                ],
                jobManager: bashJobManager,
                sessionId: bashSessionId,
                env: isBashToolFamily(toolCall.name) ? bashSandbox.env : undefined
              });
              if (isBashToolFamily(toolCall.name)) {
                const bashReportSyncError = await persistBashSandboxReportChanges();
                if (bashReportSyncError !== undefined) {
                  returnedRecoverableToolError = true;
                  toolResult = {
                    output: toolResult,
                    report_sync: bashReportSyncError
                  };
                }
              }
            } catch (error) {
              const classification = classifyToolErrorForRuntime(toolCall.name, error);
              if (!classification.recoverableByModel || !(error instanceof ToolExecutionError)) {
                throw error;
              }

              toolLoopRoundReason = classifyToolLoopRoundReason({
                allowedOutputFileNames,
                classification,
                error,
                executionArguments: toolCall.executionArguments,
                toolName: toolCall.name
              });
              incrementToolLoopRoundReason(input.toolLoopRoundReasonCounts, toolLoopRoundReason);
              guardRepeatedRecoverableToolError({
                counts: recoverableToolErrorCounts,
                error,
                executionArguments: toolCall.executionArguments,
                maxRepeatedRecoverableToolErrors,
                secrets,
                toolName: toolCall.name
              });

              returnedRecoverableToolError = true;
              const recoverableToolResult = toRecoverableToolErrorResult({
                classification,
                executionArguments: toolCall.executionArguments,
                error,
                secrets,
                toolName: toolCall.name
              });
              if (isBashToolFamily(toolCall.name)) {
                const bashReportSyncError = await persistBashSandboxReportChanges();
                toolResult =
                  bashReportSyncError === undefined
                    ? recoverableToolResult
                    : {
                        ...(isPlainRecord(recoverableToolResult)
                          ? recoverableToolResult
                          : { error: recoverableToolResult }),
                        report_sync: bashReportSyncError
                      };
              } else {
                toolResult = recoverableToolResult;
              }
            }
          }

          await options.taskLogger?.append(["工具返回", toolCall.name], {
            轮次: currentRoundIndex,
            工具调用ID: toolCall.id,
            实际执行输入: redactJsonValue(toolCall.executionArguments, secrets),
            是否可恢复错误: returnedRecoverableToolError,
            ...toToolLoopRoundReasonLogFields(toolLoopRoundReason),
            返回内容: replaceWindowTextReferencesForTaskLog({
              value: toolResult,
              windowFileName: input.manifestWindow.fileName,
              windowText: input.windowText
            })
          });
          if (shouldRecordSuccessfulReportQuery({ returnedRecoverableToolError, toolCall })) {
            recordReportQuery({
              allowedOutputFileNames,
              artifacts: input.artifacts,
              queriedReportFieldKeys,
              queriedReportFileNames,
              toolCall,
              toolResult
            });
          }

          if (isReportWriteTool(toolCall.name) && !returnedRecoverableToolError) {
            const reportFileName = getReportTargetArgument(toolCall.name, toolCall.arguments);
            if (reportFileName === undefined) {
              throw new Error(`写工具 ${toolCall.name} 未提供报告目标`);
            }

            await registerTemplateOutputReport({
              artifacts: input.artifacts,
              reportFileName
            });
            recordSuccessfulReportWrite({
              allowedOutputFileNames,
              artifacts: input.artifacts,
              writtenReportFileNames,
              toolCall
            });
            outcomeTracker.recordWritten(reportFileName);
            await syncRealReportToBashSandbox(reportsRoot, bashSandbox, reportFileName);
          }

          if (toolCall.name === MARK_NO_UPDATE_TOOL_NAME && !returnedRecoverableToolError) {
            const noUpdatePath = getToolPathArgument(toolCall.arguments);
            const noUpdateReason =
              isPlainRecord(toolCall.arguments) && typeof toolCall.arguments.reason === "string"
                ? toolCall.arguments.reason
                : undefined;
            if (noUpdatePath === undefined || noUpdateReason === undefined) {
              throw new Error(`工具 ${toolCall.name} 未提供无更新 path/reason`);
            }

            outcomeTracker.recordNoUpdate(noUpdatePath, noUpdateReason);
          }

          messages.push({
            role: "tool",
            toolCallId: toolCall.id,
            name: toolCall.name,
            content: stringifyToolResult(toolResult, secrets)
          });
        }

        if (
          !outcomeTracker.isComplete() &&
          outcomeTracker.outcomes().length > 0
        ) {
          const correctionMessage = createBatchOutcomeCorrectionMessage(outcomeTracker);
          const retryReason: ToolLoopRoundReason = "missing_template_outcome";
          incrementToolLoopRoundReason(input.toolLoopRoundReasonCounts, retryReason);
          await options.taskLogger?.append(["上下文", "重试"], {
            原因: correctionMessage,
            ...toToolLoopRoundReasonLogFields(retryReason)
          });
          replaceBatchOutcomeCorrectionMessage(messages, correctionMessage);
        }
      }
    } catch (error) {
      caughtWindowError = error;
      await options.taskLogger?.append(["错误", "窗口"], {
        ...(currentRoundIndex ? { 轮次: currentRoundIndex } : {}),
        错误: toSafeErrorMessage(error, secrets),
        Token使用: usage
      });
      throw error;
    } finally {
      await cleanupBashSandboxAfterWindow({
        bashJobManager,
        bashSandbox,
        taskLogger: options.taskLogger,
        windowError: caughtWindowError
      });
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

  async function createWindowRunJobContext(input: {
    artifacts: WindowRunArtifacts;
    job: WindowRunJobInput;
    totalWindowCount: number;
  }): Promise<WindowRunJobContext> {
    const coverageIndex = await loadReportCoverageIndex({
      projectRoot: input.artifacts.project.rootPath,
      relativePath: COVERAGE_INDEX_DEFAULTS.relativePath,
      corruptionStrategy: COVERAGE_INDEX_DEFAULTS.corruptionStrategy
    });
    const createRulesHash = options.createRulesSemanticHash ?? createRulesSemanticHash;
    const rulesSemanticHashByTemplateId = new Map(
      input.artifacts.templates.map((template) => [template.id, createRulesHash([template])])
    );
    const coveragePlanByWindowId = new Map<string, WindowCoveragePlan>();
    let skippedWindowCount = 0;
    let skippedTemplateTargetCount = 0;
    let processedTemplateTargetCount = 0;
    const pendingWindowLabels: string[] = [];

    for (const manifestWindow of input.artifacts.runtimeWindowManifest.windows) {
      const coverageTargets = createWindowCoverageTargets({
        artifacts: input.artifacts,
        manifestWindow,
        rulesSemanticHashByTemplateId
      });
      const skippedCoverageTargets = input.job.input.skipAlreadyExtracted
        ? coverageTargets.filter(({ target }) => coverageIndex.isCovered(target))
        : [];
      const skippedOutputFileNames = new Set(
        skippedCoverageTargets.map(({ template }) => template.fileName)
      );
      const templatesToProcess = input.artifacts.templates.filter(
        (template) => !skippedOutputFileNames.has(template.fileName)
      );

      coveragePlanByWindowId.set(manifestWindow.windowId, {
        skippedCoverageTargets,
        templatesToProcess
      });
      skippedTemplateTargetCount += skippedCoverageTargets.length;
      processedTemplateTargetCount += templatesToProcess.length;

      if (templatesToProcess.length === 0) {
        skippedWindowCount += 1;
      } else {
        pendingWindowLabels.push(createWindowLabel(manifestWindow, input.totalWindowCount));
      }
    }

    return {
      coverageIndex,
      rulesSemanticHashByTemplateId,
      coverageSummary: {
        skippedWindowCount,
        processedWindowCount: input.totalWindowCount - skippedWindowCount,
        skippedTemplateTargetCount,
        processedTemplateTargetCount,
        pendingWindowLabels
      },
      coveragePlanByWindowId
    };
  }

  function createLlmAdapter(input: {
    artifacts: WindowRunArtifacts;
    client: OpenAiCompatibleClient;
    context: WindowRunJobContext;
    job: WindowRunJobInput;
    modelId: string;
    providerId: string;
    totalWindowCount: number;
  }): JobLlmClient {
    return {
      async completeWindow({ window }) {
        const manifestWindow = getWindowMetadata(window);
        let secrets: string[] = [];
        const toolLoopRoundReasonCounts = new Map<ToolLoopRoundReason, number>();
        let wroteToolLoopRoundReasonSummary = false;

        const appendToolLoopRoundReasonSummary = async (): Promise<void> => {
          if (wroteToolLoopRoundReasonSummary) {
            return;
          }
          await options.taskLogger?.append(["上下文", "多轮原因汇总"], {
            窗口: `${manifestWindow.index + 1}/${input.totalWindowCount}`,
            原因计数: toToolLoopReasonCountRecord(toolLoopRoundReasonCounts)
          });
          wroteToolLoopRoundReasonSummary = true;
        };

        try {
          secrets = await getReportRedactionSecrets(input.job.input.providerConfigId);
          const coveragePlan = input.context.coveragePlanByWindowId.get(manifestWindow.windowId);
          if (!coveragePlan) {
            throw new Error(`Missing coverage plan for window ${manifestWindow.windowId}`);
          }

          if (coveragePlan.templatesToProcess.length === 0) {
            await options.taskLogger?.append(["上下文", "覆盖索引跳过窗口"], {
              窗口: `${manifestWindow.index + 1}/${input.totalWindowCount}`,
              窗口文件: manifestWindow.fileName
            });
            await appendToolLoopRoundReasonSummary();
            return {
              content: "skipped_covered",
              usage: { ...EMPTY_USAGE },
              fee: NO_TOOL_FEE,
              toolCalls: [],
              skipped: true
            };
          }

          const windowText = await readWindowText(input.artifacts.project, manifestWindow);
          const templateBatching = DEFAULT_CONFIG.extractionRuleDefaults.templateBatching;
          const templateBatches = planTemplateBatches({
            templates: coveragePlan.templatesToProcess,
            maxTemplatesPerCall: templateBatching.maxTemplatesPerCall
          });
          const templatesByOutputFileName = new Map(
            coveragePlan.templatesToProcess.map((template) => [template.fileName, template])
          );
          const contentParts: string[] = [];
          let usage = { ...EMPTY_USAGE };
          let coverageRecordCount = 0;

          for (const [templateBatchIndex, templateBatch] of templateBatches.entries()) {
            const result = await executeWindowToolLoop({
              artifacts: {
                ...input.artifacts,
                templates: templateBatch.templates
              },
              batchIndex: templateBatchIndex,
              batchMaxTemplatesPerCall: templateBatching.maxTemplatesPerCall,
              batchTotal: templateBatches.length,
              client: input.client,
              job: input.job,
              manifestWindow,
              modelId: input.modelId,
              providerId: input.providerId,
              totalWindowCount: input.totalWindowCount,
              toolLoopRoundReasonCounts,
              windowText
            });
            usage = addUsage(usage, result.usage);
            contentParts.push(result.content);

            for (const outcome of result.outcomes) {
              if (outcome.status !== "written" && outcome.status !== "no_update") {
                continue;
              }

              const template = templatesByOutputFileName.get(outcome.outputFileName);
              const rulesSemanticHash = template
                ? input.context.rulesSemanticHashByTemplateId.get(template.id)
                : undefined;
              if (!template) {
                continue;
              }
              if (!rulesSemanticHash) {
                throw new Error(`Missing rules semantic hash for template ${template.id}`);
              }

              input.context.coverageIndex.recordCovered({
                ...createCoverageTarget({
                  artifacts: input.artifacts,
                  manifestWindow,
                  rulesSemanticHash,
                  template
                }),
                status: outcome.status,
                updatedAt: options.clock.now()
              });
              coverageRecordCount += 1;
            }
          }

          await appendToolLoopRoundReasonSummary();
          if (coverageRecordCount > 0) {
            await input.context.coverageIndex.save();
            await options.taskLogger?.append(["上下文", "覆盖索引更新"], {
              索引路径: COVERAGE_INDEX_DEFAULTS.relativePath,
              窗口: `${manifestWindow.index + 1}/${input.totalWindowCount}`,
              新增或更新记录数: coverageRecordCount
            });
          }

          return {
            content: redactSecrets(contentParts.join("\n"), secrets),
            usage,
            fee: NO_TOOL_FEE,
            toolCalls: []
          };
        } catch (error) {
          try {
            await appendToolLoopRoundReasonSummary();
          } catch {
            // Preserve the original window failure; summary logging is diagnostic only on failure paths.
          }
          throw new Error(
            `窗口 ${manifestWindow.index + 1}/${input.totalWindowCount}（${manifestWindow.fileName}）执行失败：${toSafeErrorMessage(error, secrets)}`
          );
        }
      }
    };
  }

  return {
    async runJobWindows({ artifacts, job }) {
      const reportArtifacts: WindowRunArtifacts = {
        ...artifacts,
        templates: artifacts.templates.map(toFormalReportTemplate)
      };
      const { client, modelId, providerId } = await createLlmClient(job);
      const runtimeInput = createRuntimeInput({ artifacts: reportArtifacts, job, modelId });
      const context = await createWindowRunJobContext({
        artifacts: reportArtifacts,
        job,
        totalWindowCount: runtimeInput.windows.length
      });
      await options.taskLogger?.append(["上下文", "覆盖索引预检"], {
        索引路径: COVERAGE_INDEX_DEFAULTS.relativePath,
        跳过已提取: job.input.skipAlreadyExtracted,
        窗口总数: runtimeInput.windows.length,
        已覆盖窗口数: context.coverageSummary.skippedWindowCount,
        待处理窗口数: context.coverageSummary.processedWindowCount,
        已覆盖模板目标数: context.coverageSummary.skippedTemplateTargetCount,
        待处理模板目标数: context.coverageSummary.processedTemplateTargetCount,
        待处理窗口: context.coverageSummary.pendingWindowLabels
      });
      const runtime = createJobRuntime({
        clock: options.clock,
        llm: createLlmAdapter({
          artifacts: reportArtifacts,
          client,
          context,
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
