import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CreateJobDto, ProviderViewDto, ReportDto } from "../shared/ipcTypes";
import { planChapterWindows } from "@novel-extractor/extraction/windowPlanner";
import { redactSecrets } from "@novel-extractor/llm/redaction";

export type DesktopRunHarnessMode = "disabled" | "prepare-only" | "real-run";

export interface DesktopRunHarnessWindowParams {
  singleRunChapterCount: number;
  extractionChapterCount: number;
  overlapChapterCount: number;
}

export interface DesktopRunHarnessConfig {
  projectName: string;
  sourceTextPath: string;
  templateDir: string;
  qualityStandardDir: string;
  templateFiles: readonly string[];
  templateOutputFileNames: readonly string[];
  preferredModelId: string;
  windowParams: DesktopRunHarnessWindowParams;
}

export interface HarnessModelSelection {
  providerConfigId: string;
  modelId: string;
  providerDisplayName: string;
  modelDisplayName: string;
}

export interface WindowPlanSummary {
  windowCount: number;
  firstContextRange: string;
  lastContextRange: string;
}

interface BuildHarnessCreateJobInput {
  bookId: string;
  templateIds: readonly string[];
  model: HarnessModelSelection;
  windowParams: DesktopRunHarnessWindowParams;
}

interface ValidateHarnessTemplateOutputReportsOptions {
  requireAllExpectedReports?: boolean;
}

type HarnessEnv = Partial<Record<string, string | undefined>>;

export const REAL_RUN_TEMPLATE_FILES = [
  "NPC性格与代表事件模板.md",
  "事件因果链（长程因果图）模板.md",
  "势力设定模板.md",
  "材料分析模板.md"
] as const;

export const REAL_RUN_WINDOW_PARAMS: DesktopRunHarnessWindowParams = {
  singleRunChapterCount: 5,
  extractionChapterCount: 81,
  overlapChapterCount: 1
};

const DEFAULT_PROJECT_NAME_PREFIX = "desktop-run-harness-凡人修仙传-20窗口";
const DEFAULT_SOURCE_TEXT_PATH =
  "E:\\AI_Projects\\CultivationWorld\\docs\\世界观参考\\凡人修仙传\\凡人修仙传.txt";
const DEFAULT_TEMPLATE_DIR =
  "E:\\AI_Projects\\CultivationWorld\\docs\\世界观参考\\模板";
const DEFAULT_QUALITY_STANDARD_DIR =
  "E:\\AI_Projects\\CultivationWorld\\docs\\世界观参考\\凡人修仙传\\质量标准";
const DEFAULT_PREFERRED_MODEL_ID = "deepseek-v4-flash";
const DEFAULT_RUN_SUFFIX = createProcessRunSuffix();
const REAL_SINGLE_RUN_CHAPTER_COUNT_ENV = "NOVEL_EXTRACTOR_REAL_SINGLE_RUN_CHAPTER_COUNT";
const REAL_EXTRACTION_CHAPTER_COUNT_ENV = "NOVEL_EXTRACTOR_REAL_EXTRACTION_CHAPTER_COUNT";
const REAL_OVERLAP_CHAPTER_COUNT_ENV = "NOVEL_EXTRACTOR_REAL_OVERLAP_CHAPTER_COUNT";

function envValue(env: HarnessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function resolveConfiguredPath(env: HarnessEnv, key: string, fallback: string): string {
  return path.resolve(envValue(env, key) ?? fallback);
}

function createProcessRunSuffix(): string {
  return `run-${Date.now().toString(36)}-${process.pid.toString(36)}-${randomUUID().slice(0, 8)}`;
}

function toSafeRunSuffix(value: string): string {
  const suffix = value
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .replace(/^[._-]+|[._-]+$/gu, "")
    .replace(/[._-]{2,}/gu, "-")
    .slice(0, 64);

  if (!suffix) {
    throw new Error("NOVEL_EXTRACTOR_REAL_RUN_ID 需要包含可用于项目名的字符");
  }

  return suffix;
}

function resolveHarnessProjectName(env: HarnessEnv): string {
  const configuredProjectName = envValue(env, "NOVEL_EXTRACTOR_REAL_PROJECT_NAME");

  if (configuredProjectName) {
    return configuredProjectName;
  }

  const runSuffix = toSafeRunSuffix(envValue(env, "NOVEL_EXTRACTOR_REAL_RUN_ID") ?? DEFAULT_RUN_SUFFIX);
  return `${DEFAULT_PROJECT_NAME_PREFIX}-${runSuffix}`;
}

function resolveTemplateFiles(env: HarnessEnv): readonly string[] {
  const configuredValue = envValue(env, "NOVEL_EXTRACTOR_REAL_TEMPLATE_FILES");
  if (!configuredValue) {
    return REAL_RUN_TEMPLATE_FILES;
  }

  const templateFiles = configuredValue
    .split(/[;,]/u)
    .map((value) => value.trim())
    .filter(Boolean);

  if (templateFiles.length === 0) {
    throw new Error("NOVEL_EXTRACTOR_REAL_TEMPLATE_FILES 至少需要包含一个模板文件名");
  }

  return templateFiles;
}

function toDefaultTemplateOutputFileName(templateFileName: string): string {
  const extension = path.extname(templateFileName);
  const baseName = path.basename(templateFileName, extension);
  const outputBaseName = baseName.endsWith("模板")
    ? baseName.slice(0, baseName.length - "模板".length)
    : baseName;
  return `${outputBaseName}${extension || ".md"}`;
}

function resolveTemplateOutputFileNames(
  env: HarnessEnv,
  templateFiles: readonly string[]
): readonly string[] {
  const configuredValue = envValue(env, "NOVEL_EXTRACTOR_REAL_TEMPLATE_OUTPUT_FILES");
  if (!configuredValue) {
    return templateFiles.map(toDefaultTemplateOutputFileName);
  }

  const outputFileNames = configuredValue
    .split(/[;,]/u)
    .map((value) => value.trim())
    .filter(Boolean);

  if (outputFileNames.length === 0) {
    throw new Error("NOVEL_EXTRACTOR_REAL_TEMPLATE_OUTPUT_FILES 至少需要包含一个输出文件名");
  }

  if (outputFileNames.length !== templateFiles.length) {
    throw new Error(
      `NOVEL_EXTRACTOR_REAL_TEMPLATE_OUTPUT_FILES 数量必须与 NOVEL_EXTRACTOR_REAL_TEMPLATE_FILES 一致：模板 ${templateFiles.length} 个，输出 ${outputFileNames.length} 个`
    );
  }

  return outputFileNames;
}

function parsePositiveIntegerEnv(env: HarnessEnv, key: string): number | undefined {
  const configuredValue = envValue(env, key);
  if (configuredValue === undefined) {
    return undefined;
  }

  const parsedValue = Number(configuredValue);
  if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`${key} 必须是正整数，实际为 ${configuredValue}`);
  }

  return parsedValue;
}

function resolveWindowParams(env: HarnessEnv): DesktopRunHarnessWindowParams {
  const windowParams = {
    ...REAL_RUN_WINDOW_PARAMS
  };
  windowParams.singleRunChapterCount =
    parsePositiveIntegerEnv(env, REAL_SINGLE_RUN_CHAPTER_COUNT_ENV) ??
    windowParams.singleRunChapterCount;
  windowParams.extractionChapterCount =
    parsePositiveIntegerEnv(env, REAL_EXTRACTION_CHAPTER_COUNT_ENV) ??
    windowParams.extractionChapterCount;
  windowParams.overlapChapterCount =
    parsePositiveIntegerEnv(env, REAL_OVERLAP_CHAPTER_COUNT_ENV) ??
    windowParams.overlapChapterCount;

  if (windowParams.overlapChapterCount >= windowParams.singleRunChapterCount) {
    throw new Error(
      `${REAL_OVERLAP_CHAPTER_COUNT_ENV} 必须小于 ${REAL_SINGLE_RUN_CHAPTER_COUNT_ENV}，实际为 ${windowParams.overlapChapterCount}/${windowParams.singleRunChapterCount}`
    );
  }

  return windowParams;
}

export function resolveHarnessRunMode(env: HarnessEnv = process.env): DesktopRunHarnessMode {
  const prepareOnly = envValue(env, "NOVEL_EXTRACTOR_PREPARE_ONLY") === "1";
  const realRun = envValue(env, "NOVEL_EXTRACTOR_REAL_RUN") === "1";

  if (prepareOnly && realRun) {
    throw new Error("不能同时启用 NOVEL_EXTRACTOR_PREPARE_ONLY=1 和 NOVEL_EXTRACTOR_REAL_RUN=1");
  }

  if (realRun) {
    return "real-run";
  }

  return prepareOnly ? "prepare-only" : "disabled";
}

export function resolveDesktopRunHarnessConfig(
  env: HarnessEnv = process.env
): DesktopRunHarnessConfig {
  const templateFiles = resolveTemplateFiles(env);

  return {
    projectName: resolveHarnessProjectName(env),
    sourceTextPath: resolveConfiguredPath(
      env,
      "NOVEL_EXTRACTOR_REAL_SOURCE_TXT",
      DEFAULT_SOURCE_TEXT_PATH
    ),
    templateDir: resolveConfiguredPath(env, "NOVEL_EXTRACTOR_REAL_TEMPLATE_DIR", DEFAULT_TEMPLATE_DIR),
    qualityStandardDir: resolveConfiguredPath(
      env,
      "NOVEL_EXTRACTOR_REAL_QUALITY_DIR",
      DEFAULT_QUALITY_STANDARD_DIR
    ),
    templateFiles,
    templateOutputFileNames: resolveTemplateOutputFileNames(env, templateFiles),
    preferredModelId: envValue(env, "NOVEL_EXTRACTOR_REAL_MODEL_ID") ?? DEFAULT_PREFERRED_MODEL_ID,
    windowParams: resolveWindowParams(env)
  };
}

export function createExpectedWindowPlanSummary(
  chapterCount = REAL_RUN_WINDOW_PARAMS.extractionChapterCount,
  windowParams: DesktopRunHarnessWindowParams = REAL_RUN_WINDOW_PARAMS
): WindowPlanSummary {
  const plannedWindows = planChapterWindows({
    chapterIds: Array.from({ length: chapterCount }, (_, index) => String(index + 1)),
    chaptersPerWindow: windowParams.singleRunChapterCount,
    maxChapters: windowParams.extractionChapterCount,
    overlapChapterCount: windowParams.overlapChapterCount
  });
  const firstWindow = plannedWindows[0];
  const lastWindow = plannedWindows.at(-1);

  if (!firstWindow || !lastWindow) {
    throw new Error("窗口规划结果为空");
  }

  return {
    windowCount: plannedWindows.length,
    firstContextRange: firstWindow.contextRange,
    lastContextRange: lastWindow.contextRange
  };
}

export function assertHarnessUploadChapterCoverage(
  uploadChapterCount: number,
  minimumChapterCount = REAL_RUN_WINDOW_PARAMS.extractionChapterCount
): void {
  if (!Number.isInteger(uploadChapterCount) || uploadChapterCount < minimumChapterCount) {
    throw new Error(
      `上传文本至少识别 ${minimumChapterCount} 章才能覆盖本次真实运行窗口，实际识别 ${String(
        uploadChapterCount
      )} 章`
    );
  }
}

export function selectHarnessModel(
  providers: readonly ProviderViewDto[],
  preferredModelId = DEFAULT_PREFERRED_MODEL_ID
): HarnessModelSelection {
  const candidates = providers.flatMap((provider) => {
    if (!provider.enabled || !provider.hasApiKey) {
      return [];
    }

    return provider.models
      .filter((model) => model.enabled)
      .map((model) => ({
        providerConfigId: provider.id,
        modelId: model.id,
        providerDisplayName: provider.displayName,
        modelDisplayName: model.displayName
      }));
  });
  const selected =
    candidates.find((candidate) => candidate.modelId === preferredModelId) ?? candidates[0];

  if (!selected) {
    throw new Error("未找到已启用、已保存 API key 且至少包含一个启用模型的 provider");
  }

  return selected;
}

export function buildHarnessCreateJobInput(input: BuildHarnessCreateJobInput): CreateJobDto {
  return {
    bookId: input.bookId,
    templateIds: [...input.templateIds],
    providerConfigId: input.model.providerConfigId,
    modelId: input.model.modelId,
    ...input.windowParams,
    skipAlreadyExtracted: false
  };
}

export function validateHarnessTemplateOutputReports(
  reports: readonly ReportDto[],
  expectedOutputFileNames: readonly string[],
  options: ValidateHarnessTemplateOutputReportsOptions = {}
): ReportDto[] {
  const expectedFileNames = new Set(expectedOutputFileNames);
  const templateReports = reports.filter((report) => report.reportKind === "template-output");
  const unexpectedReports = templateReports.filter((report) => !expectedFileNames.has(report.fileName));

  if (unexpectedReports.length > 0) {
    throw new Error(
      `真实运行 harness 发现未在本次模板输出白名单内的 template-output 报告：${unexpectedReports
        .map((report) => report.fileName)
        .sort()
        .join(", ")}`
    );
  }

  const allowedReports = templateReports.filter((report) => expectedFileNames.has(report.fileName));
  const actualFileNames = new Set(allowedReports.map((report) => report.fileName));
  const missingFileNames = expectedOutputFileNames.filter((fileName) => !actualFileNames.has(fileName));

  if (options.requireAllExpectedReports && missingFileNames.length > 0) {
    throw new Error(
      `真实运行 harness 缺少本次模板输出报告：${[...new Set(missingFileNames)].sort().join(", ")}`
    );
  }

  if (allowedReports.length === 0) {
    throw new Error("真实运行 harness 至少需要生成一个本次模板输出白名单内的 template-output 报告");
  }

  for (const report of allowedReports) {
    if (report.byteSize <= 0) {
      throw new Error(`真实运行 harness 报告 byteSize 必须大于 0：${report.fileName}`);
    }
  }

  return allowedReports;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, fieldName: string): string | undefined {
  const value = record?.[fieldName];
  return typeof value === "string" ? value : undefined;
}

function inferMinimumChapterCount(expected: WindowPlanSummary): number {
  const match = /-(\d+)$/u.exec(expected.lastContextRange);
  if (!match) {
    return REAL_RUN_WINDOW_PARAMS.extractionChapterCount;
  }

  return Number(match[1]);
}

export function validateRuntimeWindowManifest(
  manifest: unknown,
  expected: WindowPlanSummary = createExpectedWindowPlanSummary()
): WindowPlanSummary {
  const manifestRecord = asRecord(manifest);
  const windows = Array.isArray(manifestRecord?.windows) ? manifestRecord.windows : [];
  const firstWindow = asRecord(windows[0]);
  const lastWindow = asRecord(windows.at(-1));
  const totalDetectedChapterCount = manifestRecord?.totalDetectedChapterCount;
  const summary = {
    windowCount: windows.length,
    firstContextRange: stringField(firstWindow, "contextChapterRange") ?? "",
    lastContextRange: stringField(lastWindow, "contextChapterRange") ?? ""
  };

  if (typeof totalDetectedChapterCount !== "number") {
    throw new Error(
      `manifest totalDetectedChapterCount 必须为数字，实际为 ${String(totalDetectedChapterCount)}`
    );
  }
  assertHarnessUploadChapterCoverage(totalDetectedChapterCount, inferMinimumChapterCount(expected));

  if (
    summary.windowCount !== expected.windowCount ||
    summary.firstContextRange !== expected.firstContextRange ||
    summary.lastContextRange !== expected.lastContextRange
  ) {
    throw new Error(
      `manifest 窗口不符合真实运行 harness 预期：${JSON.stringify({
        actual: summary,
        expected
      })}`
    );
  }

  return summary;
}

export function toSafeHarnessError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
  return redactSecrets(message ?? "真实运行 harness 失败");
}
