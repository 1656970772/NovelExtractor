import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  getBuiltInTemplates,
  getDefaultConfig,
  getTaskStatusConfig,
  type TaskAction,
  type TemplateGroupFallbackStrategy,
  type NovelExtractorConfig
} from "@novel-extractor/config";
import type { Book, Clock, IdGenerator, Project, ReportAsset } from "@novel-extractor/domain";
import { toTaskStatus, type JobStatus } from "@novel-extractor/domain/job";
import {
  ExtractionRulesError,
  generateExtractionRules,
  type GenerateExtractionRulesResult,
  type TemplateGroupRulesSnapshot,
  type TemplateRulesSnapshot
} from "@novel-extractor/extraction/extractionRules";
import { generateRuntimeWindows, type GenerateRuntimeWindowsResult } from "@novel-extractor/extraction/runtimeWindows";
import { uploadBook, type UploadedBookRepository } from "@novel-extractor/extraction/uploadBook";
import { planChapterWindows } from "@novel-extractor/extraction/windowPlanner";
import type { JobRuntime, JobRuntimeError, JobRuntimeState, TokenUsage } from "@novel-extractor/jobs";
import type { FetchLike } from "@novel-extractor/llm";
import { renderSafeMarkdown } from "@novel-extractor/markdown/preview";
import { createMemoryCredentialStore, type MemoryCredentialStore } from "./credentials";
import { createFailureRetryScheduler } from "./failureRetryScheduler";
import type { DesktopIpcHandlers } from "./ipc";
import { createJobScheduler, type JobScheduler, type QueueBlockReason } from "./jobScheduler";
import {
  createMiniMaxTokenPlanWaitGate,
  type MiniMaxTokenPlanWaitGate
} from "./minimaxTokenPlanWaitGate";
import {
  createFileProjectRuntimeStore,
  type ProjectRuntimeJobProgressRecord,
  type ProjectRuntimeJobTimingRecord,
  type ProjectRuntimeJobRecord,
  type ProjectRuntimeState,
  type ProjectRuntimeStore
} from "./projectRuntimeStore";
import { createFileProjectStore, type MainProjectStore } from "./projectStore";
import { createMemoryProviderStore, type MainProviderStore } from "./providerStore";
import { appendTaskTextLogEntry, createTaskTextLogger, type TaskTextLogger } from "./taskTextLogger";
import { createWindowRunService, type WindowRunArtifacts } from "./windowRunService";
import type {
  CreateJobDto,
  InputSummaryDto,
  JobDto,
  JobProgressDto,
  JobTimingDto,
  ProjectRuntimeDto,
  ReportDto,
  SaveTemplateDto,
  TemplateDto,
  TemplateSelectionDto
} from "../shared/ipcTypes";

type P0Handlers = Pick<
  DesktopIpcHandlers,
  | "project:create"
  | "project:list"
  | "books:uploadTxt"
  | "books:listReports"
  | "projectRuntime:get"
  | "templates:list"
  | "templates:save"
  | "templates:delete"
  | "templateSelection:get"
  | "templateSelection:save"
  | "jobs:create"
  | "jobs:start"
  | "jobs:pause"
  | "jobs:resume"
  | "jobs:restart"
  | "jobs:updateRetryPolicy"
  | "jobs:delete"
  | "jobs:readLog"
  | "jobs:openLog"
  | "jobs:openOutputDirectory"
  | "reports:preview"
>;

type P0JobRecord = ProjectRuntimeJobRecord;

interface TemplateStoreState {
  templates: TemplateDto[];
  selectionsByProjectId: Record<string, string[]>;
}

interface PreparedPreRunArtifacts extends WindowRunArtifacts {
  rulesLatestPath: string;
  rulesSnapshotAbsolutePath: string;
  rulesLatestAbsolutePath: string;
  windowsManifestPath: string;
  windowsRoot: string;
}

export interface P0IpcHandlersOptions {
  workspaceRoot?: string;
  projectsRoot?: string | (() => string);
  clock?: Clock;
  idGenerator?: IdGenerator;
  projectStore?: MainProjectStore;
  providerStore?: MainProviderStore;
  projectRuntimeStoreFactory?: (project: Project) => ProjectRuntimeStore;
  credentialStore?: MemoryCredentialStore;
  fetch?: FetchLike;
  getAppVersion?: () => string;
  estimateRandom?: () => number;
  onJobUpdated?: (job: JobDto) => void;
  enabledToolNames?: readonly string[];
  jobSchedulerDefaults?: Partial<NovelExtractorConfig["jobSchedulerDefaults"]>;
  failureRetryIntervalMs?: number;
  templateBatchFailureRetryIntervalMs?: number;
  tokenPlanWaitGate?: MiniMaxTokenPlanWaitGate;
  shell?: {
    openPath(path: string): Promise<string>;
  };
}

const TASK_STATUS_CONFIG = getTaskStatusConfig();
const RULES_FILE_NAME = "提取规则.md";
const JOB_ID_COLLISION_RETRY_LIMIT = 50;
const JOB_TIMING_DEFAULTS = getDefaultConfig().jobTimingDefaults;

const systemClock: Clock = {
  now: () => new Date().toISOString()
};

function createSequentialIdGenerator(): IdGenerator {
  const nextValues = new Map<string, number>();

  return {
    createId(prefix = "id") {
      const nextValue = (nextValues.get(prefix) ?? 0) + 1;
      nextValues.set(prefix, nextValue);
      return `${prefix}-${nextValue}`;
    }
  };
}

function toSafeSegment(value: string): string {
  const normalized = value
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return normalized || "project";
}

function toReportDisplayName(fileName: string): string {
  return path.basename(fileName, path.extname(fileName));
}

function toTemplateFileName(name: string): string {
  return `${toSafeSegment(name)}.md`;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function deriveSimpleLogFilePath(logFilePath: string): string {
  return logFilePath.replace(/\.txt$/u, ".simple.txt");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function assertSupportedTemplateFile(fileName: string): void {
  const extension = path.extname(fileName).toLowerCase();

  if (extension !== ".txt" && extension !== ".md") {
    throw new Error("模板文件仅支持 .txt 或 .md");
  }
}

function normalizeTemplateName(name: string): string {
  const normalized = name.trim().normalize("NFC");
  if (!normalized) {
    throw new Error("模板名字不能为空");
  }
  return normalized;
}

function normalizeTemplateBody(body: string): string {
  return body.normalize("NFC");
}

function createBuiltInTemplateDtos(now: string): TemplateDto[] {
  return getBuiltInTemplates().map((template) => ({
    id: template.id,
    scope: "global",
    name: template.name,
    fileName: template.defaultOutputFileName || toTemplateFileName(template.name),
    body: template.description,
    createdAt: now,
    updatedAt: now
  }));
}

function sortTemplates(templates: TemplateDto[]): TemplateDto[] {
  return [...templates].sort((left, right) => {
    if (left.scope !== right.scope) {
      return left.scope === "global" ? -1 : 1;
    }

    return left.createdAt.localeCompare(right.createdAt) || left.name.localeCompare(right.name);
  });
}

function getAllowedActions(status: JobStatus): TaskAction[] {
  const taskStatus = toTaskStatus(status);
  return taskStatus ? [...TASK_STATUS_CONFIG[taskStatus].allowedActions] : [];
}

function formatTokenText(
  usage: Pick<TokenUsage, "totalTokens" | "cacheHitTokens" | "cacheMissTokens"> | null | undefined
): string {
  const cacheHitTokens = usage?.cacheHitTokens ?? 0;
  const cacheMissTokens = usage?.cacheMissTokens ?? 0;
  const cacheMeasuredTokens = cacheHitTokens + cacheMissTokens;
  const cacheHitRate = cacheMeasuredTokens > 0 ? (cacheHitTokens / cacheMeasuredTokens) * 100 : 0;
  return `Token ${usage?.totalTokens ?? 0} / 缓存命中率 ${cacheHitRate.toFixed(2)}%`;
}

function formatRuntimeProgress(state: Pick<JobRuntimeState, "completedWindowCount" | "totalWindowCount">): string {
  return `进度：${state.completedWindowCount}/${state.totalWindowCount} 模板窗口`;
}

function toJobStatusFromRuntime(status: JobRuntimeState["status"]): JobStatus {
  return status === "cancelled" ? "failed" : status;
}

interface RuntimeEstimateOptions {
  createInitialWindowEstimateMs?: () => number;
}

interface RuntimeWindowMetrics {
  completedWindowCount: number;
  totalWindowCount: number;
  skippedWindowCount: number;
  executedWindowCount: number;
  executedWindowElapsedMs?: number;
  effectiveTotalWindowCount: number;
  hasDetailedWindowMetrics: boolean;
}

function clampWindowCount(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function toNonNegativeFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function createRandomInitialWindowEstimateMs(random: () => number = Math.random): number {
  const rawRandom = random();
  const normalizedRandom = Number.isFinite(rawRandom) ? Math.min(1, Math.max(0, rawRandom)) : 0;
  return Math.round(
    JOB_TIMING_DEFAULTS.initialWindowEstimateMinMs +
      normalizedRandom *
        (JOB_TIMING_DEFAULTS.initialWindowEstimateMaxMs - JOB_TIMING_DEFAULTS.initialWindowEstimateMinMs)
  );
}

function getInitialWindowEstimateMs(
  timing: ProjectRuntimeJobTimingRecord,
  options: RuntimeEstimateOptions
): number {
  if (timing.initialWindowEstimateMs !== undefined && Number.isFinite(timing.initialWindowEstimateMs)) {
    return timing.initialWindowEstimateMs;
  }

  return options.createInitialWindowEstimateMs?.() ?? createRandomInitialWindowEstimateMs();
}

function getRuntimeWindowMetrics(state: JobRuntimeState): RuntimeWindowMetrics {
  const totalWindowCount = clampWindowCount(state.totalWindowCount, 0, Number.MAX_SAFE_INTEGER);
  const completedWindowCount = clampWindowCount(state.completedWindowCount, 0, totalWindowCount);
  const rawSkippedWindowCount = toNonNegativeFiniteNumber(state.skippedWindowCount);
  const rawExecutedWindowCount = toNonNegativeFiniteNumber(state.executedWindowCount);
  const executedWindowElapsedMs = toNonNegativeFiniteNumber(state.executedWindowElapsedMs);
  const hasDetailedWindowMetrics =
    rawSkippedWindowCount !== undefined ||
    rawExecutedWindowCount !== undefined ||
    executedWindowElapsedMs !== undefined;

  if (!hasDetailedWindowMetrics) {
    return {
      completedWindowCount,
      totalWindowCount,
      skippedWindowCount: 0,
      executedWindowCount: completedWindowCount,
      effectiveTotalWindowCount: totalWindowCount,
      hasDetailedWindowMetrics
    };
  }

  const skippedWindowCount = clampWindowCount(rawSkippedWindowCount ?? 0, 0, completedWindowCount);
  const maxExecutedWindowCount = Math.max(0, completedWindowCount - skippedWindowCount);
  const executedWindowCount = clampWindowCount(
    rawExecutedWindowCount ?? maxExecutedWindowCount,
    0,
    maxExecutedWindowCount
  );

  return {
    completedWindowCount,
    totalWindowCount,
    skippedWindowCount,
    executedWindowCount,
    executedWindowElapsedMs: executedWindowElapsedMs ?? 0,
    effectiveTotalWindowCount: Math.max(0, totalWindowCount - skippedWindowCount),
    hasDetailedWindowMetrics
  };
}

function calculateLegacyEstimatedTotalMs(
  completedWindowCount: number,
  totalWindowCount: number,
  startedAt: string,
  nowIso: string
): number | undefined {
  if (completedWindowCount <= 0 || totalWindowCount <= 0) {
    return undefined;
  }

  const startedAtMs = Date.parse(startedAt);
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(startedAtMs) || Number.isNaN(nowMs) || nowMs < startedAtMs) {
    return undefined;
  }

  const averageWindowMs = (nowMs - startedAtMs) / completedWindowCount;
  return Math.max(0, Math.round(averageWindowMs * totalWindowCount));
}

function calculateDetailedEstimatedTotalMs(
  metrics: RuntimeWindowMetrics,
  timing: ProjectRuntimeJobTimingRecord,
  options: RuntimeEstimateOptions
): number | undefined {
  const estimateWindowCount = clampWindowCount(
    timing.effectiveTotalWindowCount ?? metrics.totalWindowCount,
    0,
    metrics.totalWindowCount
  );
  timing.effectiveTotalWindowCount = estimateWindowCount;
  if (estimateWindowCount <= 0) {
    return 0;
  }

  const baselineExecutedWindowCount = clampWindowCount(
    timing.estimateBaselineExecutedWindowCount ?? 0,
    0,
    metrics.executedWindowCount
  );
  const baselineExecutedWindowElapsedMs = Math.min(
    timing.estimateBaselineExecutedWindowElapsedMs ?? 0,
    metrics.executedWindowElapsedMs ?? 0
  );
  const stageExecutedWindowCount = metrics.executedWindowCount - baselineExecutedWindowCount;
  const stageExecutedWindowElapsedMs =
    (metrics.executedWindowElapsedMs ?? 0) - baselineExecutedWindowElapsedMs;

  if (stageExecutedWindowCount > 0 && stageExecutedWindowElapsedMs > 0) {
    const averageWindowMs = stageExecutedWindowElapsedMs / stageExecutedWindowCount;
    return Math.max(0, Math.round(averageWindowMs * estimateWindowCount));
  }

  const initialWindowEstimateMs = getInitialWindowEstimateMs(timing, options);
  timing.initialWindowEstimateMs = initialWindowEstimateMs;
  return Math.max(0, initialWindowEstimateMs * estimateWindowCount);
}

function applyRuntimeEstimateMetadata(
  timing: ProjectRuntimeJobTimingRecord,
  metrics: RuntimeWindowMetrics
): void {
  if (!metrics.hasDetailedWindowMetrics) {
    return;
  }

  timing.executedWindowElapsedMs = metrics.executedWindowElapsedMs ?? 0;
}

function beginRuntimeEstimateStage(
  timing: ProjectRuntimeJobTimingRecord,
  metrics: RuntimeWindowMetrics,
  options: RuntimeEstimateOptions
): void {
  const initialWindowEstimateMs =
    options.createInitialWindowEstimateMs?.() ?? createRandomInitialWindowEstimateMs();
  const estimateWindowCount = Math.max(0, metrics.totalWindowCount - metrics.completedWindowCount);
  timing.initialWindowEstimateMs = initialWindowEstimateMs;
  timing.effectiveTotalWindowCount = estimateWindowCount;
  timing.estimateBaselineExecutedWindowCount = metrics.executedWindowCount;
  timing.estimateBaselineExecutedWindowElapsedMs = metrics.executedWindowElapsedMs ?? 0;
  timing.estimatedTotalMs = initialWindowEstimateMs * estimateWindowCount;
  timing.estimatedRemainingMs = undefined;
  timing.estimateFrozenAt = undefined;
}

function calculateRuntimeEstimatedTotalMs(
  metrics: RuntimeWindowMetrics,
  timing: ProjectRuntimeJobTimingRecord,
  nowIso: string,
  options: RuntimeEstimateOptions
): number | undefined {
  if (metrics.hasDetailedWindowMetrics) {
    return calculateDetailedEstimatedTotalMs(metrics, timing, options);
  }

  if (metrics.completedWindowCount <= 0) {
    timing.effectiveTotalWindowCount = metrics.totalWindowCount;
    const initialWindowEstimateMs = getInitialWindowEstimateMs(timing, options);
    timing.initialWindowEstimateMs = initialWindowEstimateMs;
    return Math.max(0, initialWindowEstimateMs * metrics.totalWindowCount);
  }

  return timing.startedAt
    ? calculateLegacyEstimatedTotalMs(
        metrics.completedWindowCount,
        metrics.totalWindowCount,
        timing.startedAt,
        nowIso
      )
    : undefined;
}

function isAllWindowsCompleted(
  progress: Pick<ProjectRuntimeJobProgressRecord, "completedWindowCount" | "totalWindowCount"> | undefined
): boolean {
  return Boolean(
    progress &&
      progress.totalWindowCount > 0 &&
      progress.completedWindowCount >= progress.totalWindowCount
  );
}

function getReusableEstimatedTotalMs(
  metrics: RuntimeWindowMetrics,
  previousJob: Pick<ProjectRuntimeJobRecord, "progress" | "timing"> | undefined
): number | undefined {
  if (
    previousJob?.progress?.completedWindowCount !== metrics.completedWindowCount ||
    previousJob.progress.totalWindowCount !== metrics.totalWindowCount
  ) {
    return undefined;
  }

  if (
    metrics.hasDetailedWindowMetrics &&
    ((previousJob.progress.skippedWindowCount ?? 0) !== metrics.skippedWindowCount ||
      (previousJob.progress.executedWindowCount ?? 0) !== metrics.executedWindowCount)
  ) {
    return undefined;
  }

  const estimatedTotalMs = previousJob.timing?.estimatedTotalMs;
  return estimatedTotalMs !== undefined && Number.isFinite(estimatedTotalMs) ? estimatedTotalMs : undefined;
}

export function toJobPatchFromRuntimeState(
  state: JobRuntimeState,
  previousJob: Pick<ProjectRuntimeJobRecord, "status" | "progress" | "timing"> | undefined,
  clock: Clock,
  estimateOptions: RuntimeEstimateOptions = {}
): Partial<ProjectRuntimeJobRecord> {
  const now = clock.now();
  const status = toJobStatusFromRuntime(state.status);
  const previousTiming = previousJob?.timing;
  const timing: ProjectRuntimeJobTimingRecord = previousTiming ? { ...previousTiming } : {};
  const metrics = getRuntimeWindowMetrics(state);

  if (state.status === "running" && !timing.startedAt) {
    timing.startedAt = now;
  }

  if ((status === "completed" || status === "failed") && !timing.completedAt) {
    timing.completedAt = now;
  }

  const progress: ProjectRuntimeJobProgressRecord = {
    completedWindowCount: metrics.completedWindowCount,
    totalWindowCount: metrics.totalWindowCount
  };
  if (metrics.hasDetailedWindowMetrics) {
    progress.skippedWindowCount = metrics.skippedWindowCount;
    progress.executedWindowCount = metrics.executedWindowCount;
  }
  applyRuntimeEstimateMetadata(timing, metrics);
  const isResumeTransition = previousJob?.status === "paused" && status === "running";
  if (isResumeTransition) {
    beginRuntimeEstimateStage(timing, metrics, estimateOptions);
  }
  const reusableEstimatedTotalMs = isResumeTransition
    ? undefined
    : getReusableEstimatedTotalMs(metrics, previousJob);

  if (isResumeTransition) {
    // The resume transition has already created a new estimate stage above.
  } else if (status === "running" && reusableEstimatedTotalMs !== undefined) {
    timing.estimatedTotalMs = reusableEstimatedTotalMs;
    timing.estimatedRemainingMs = undefined;
    timing.estimateFrozenAt = undefined;
  } else if ((status === "running" || status === "completed") && isAllWindowsCompleted(progress)) {
    const estimatedTotalMs = calculateRuntimeEstimatedTotalMs(metrics, timing, now, estimateOptions);
    timing.estimatedTotalMs = estimatedTotalMs ?? 0;
    timing.estimatedRemainingMs = undefined;
    timing.estimateFrozenAt = undefined;
  } else if (
    status === "running" &&
    timing.startedAt &&
    metrics.completedWindowCount < metrics.totalWindowCount
  ) {
    const estimatedTotalMs = calculateRuntimeEstimatedTotalMs(metrics, timing, now, estimateOptions);
    if (estimatedTotalMs !== undefined) {
      timing.estimatedTotalMs = estimatedTotalMs;
      timing.estimatedRemainingMs = undefined;
      timing.estimateFrozenAt = undefined;
    }
  }

  if (status === "paused" && previousTiming?.estimatedTotalMs !== undefined) {
    timing.estimatedTotalMs = previousTiming.estimatedTotalMs;
    timing.estimatedRemainingMs = undefined;
    timing.estimateFrozenAt = now;
  }

  return {
    status,
    progressText: formatRuntimeProgress(state),
    tokenText: formatTokenText(state.usage),
    failureReason: state.failureReason,
    progress,
    timing
  };
}

function toReportDto(report: ReportAsset): ReportDto {
  return {
    id: report.id,
    bookId: report.bookId,
    fileName: report.fileName,
    displayName: report.displayName,
    reportKind: report.reportKind,
    byteSize: report.byteSize,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt
  };
}

export function createP0IpcHandlers(options: P0IpcHandlersOptions = {}): P0Handlers {
  const clock = options.clock ?? systemClock;
  const createInitialWindowEstimateMs = () => createRandomInitialWindowEstimateMs(options.estimateRandom);
  const idGenerator = options.idGenerator ?? createSequentialIdGenerator();
  const defaultConfig = getDefaultConfig();
  const workspaceRoot =
    options.workspaceRoot ??
    process.env.NOVEL_EXTRACTOR_E2E_DATA_DIR ??
    path.join(process.cwd(), ".novel-extractor-data");

  const schedulerDefaults = {
    ...defaultConfig.jobSchedulerDefaults,
    ...options.jobSchedulerDefaults
  };
  const failureRetryIntervalMs =
    options.failureRetryIntervalMs ?? defaultConfig.jobFailureRetryDefaults.failureRetryIntervalMs;
  const templateBatchFailureRetryIntervalMs =
    options.templateBatchFailureRetryIntervalMs ??
    defaultConfig.extractionRuleDefaults.templateBatching.failureRetryIntervalMs;

  const booksById = new Map<string, Book>();
  const jobsById = new Map<string, P0JobRecord>();
  const pendingAutoRetryRunLogsByJobId = new Map<string, { intervalText: string }>();
  const reportsById = new Map<string, ReportAsset>();
  const reportPathById = new Map<string, string>();
  const projectRuntimeStoresByRoot = new Map<string, ProjectRuntimeStore>();
  const providerStore = options.providerStore ?? createMemoryProviderStore();
  const shellApi = options.shell ?? {
    openPath: async () => "完整日志打开入口尚未初始化。"
  };
  const credentialStore = options.credentialStore ?? createMemoryCredentialStore();
  const tokenPlanWaitGate =
    options.tokenPlanWaitGate ??
    createMiniMaxTokenPlanWaitGate({
      defaults: defaultConfig.minimaxTokenPlanWaitDefaults,
      fetch: options.fetch,
      resolveApiKey: (ref) => credentialStore.readApiKey(ref)
    });
  const activeWindowRuntimes = new Map<string, JobRuntime>();
  const projectStore =
    options.projectStore ??
    createFileProjectStore({
      workspaceRoot,
      projectsRoot: options.projectsRoot,
      clock,
      idGenerator
    });
  const templateStorePath = path.join(workspaceRoot, "templates.json");
  let templateStorePromise: Promise<TemplateStoreState> | null = null;

  const uploadedBookRepository: UploadedBookRepository = {
    async saveUploadedBook(input) {
      booksById.set(input.book.id, input.book);
      return input;
    }
  };

  async function ensureProject(projectId: string): Promise<Project> {
    return projectStore.ensureProject(projectId);
  }

  function getProjectRuntimeStore(project: Project): ProjectRuntimeStore {
    const storeKey = path.resolve(project.rootPath);
    const existingStore = projectRuntimeStoresByRoot.get(storeKey);
    if (existingStore) {
      return existingStore;
    }

    const store =
      options.projectRuntimeStoreFactory?.(project) ??
      createFileProjectRuntimeStore({ projectRoot: project.rootPath });
    projectRuntimeStoresByRoot.set(storeKey, store);
    return store;
  }

  function hydrateProjectRuntimeState(state: ProjectRuntimeState): void {
    for (const { book } of state.books) {
      booksById.set(book.id, book);
    }

    for (const job of state.jobs) {
      jobsById.set(job.id, job);
      syncFailureRetrySchedule(job);
    }

    for (const report of state.reports) {
      reportsById.set(report.id, report);
      const reportPath = state.reportPathById[report.id];
      if (reportPath) {
        reportPathById.set(report.id, reportPath);
      }
    }
  }

  function clampPercent(completedWindowCount: number, totalWindowCount: number): number {
    if (totalWindowCount <= 0) {
      return 0;
    }

    const percent = Math.round((completedWindowCount / totalWindowCount) * 100);
    return Math.min(100, Math.max(0, percent));
  }

  function toJobProgressDto(job: P0JobRecord): JobProgressDto | undefined {
    if (!job.progress) {
      return undefined;
    }

    return {
      completedWindowCount: job.progress.completedWindowCount,
      totalWindowCount: job.progress.totalWindowCount,
      percent: clampPercent(job.progress.completedWindowCount, job.progress.totalWindowCount)
    };
  }

  function calculateElapsedMs(startedAt: string, endedAt: string): number | undefined {
    const startedAtMs = Date.parse(startedAt);
    const endedAtMs = Date.parse(endedAt);
    if (Number.isNaN(startedAtMs) || Number.isNaN(endedAtMs)) {
      return undefined;
    }

    return Math.max(0, endedAtMs - startedAtMs);
  }

  function toJobTimingDto(job: P0JobRecord, nowIso: string): JobTimingDto | undefined {
    const timing = job.timing;
    if (!timing?.startedAt) {
      return undefined;
    }

    const elapsedEndAt = timing.completedAt ?? nowIso;
    const rawElapsedMs = calculateElapsedMs(timing.startedAt, elapsedEndAt);
    const completedTokenPlanWaitElapsedMs = Math.max(0, timing.tokenPlanWaitElapsedMs ?? 0);
    const activeTokenPlanWaitElapsedMs = timing.tokenPlanWaitStartedAt
      ? (calculateElapsedMs(timing.tokenPlanWaitStartedAt, elapsedEndAt) ?? 0)
      : 0;
    const elapsedMs =
      rawElapsedMs === undefined
        ? undefined
        : Math.max(
            0,
            rawElapsedMs - completedTokenPlanWaitElapsedMs - activeTokenPlanWaitElapsedMs
          );
    const estimatedTotalMs = timing.estimatedTotalMs;
    const hasEstimatedTotal = estimatedTotalMs !== undefined;
    const estimateState: JobTimingDto["estimateState"] =
      job.status === "paused" && hasEstimatedTotal
        ? "frozen"
        : hasEstimatedTotal && (job.status === "running" || job.status === "completed")
          ? "available"
          : job.status === "running"
            ? "calculating"
            : "unknown";
    const dto: JobTimingDto = {
      startedAt: timing.startedAt,
      elapsedUpdatedAt: nowIso,
      elapsedTimerState: timing.tokenPlanWaitStartedAt ? "waiting_token_plan" : "running",
      estimateState
    };

    if (timing.completedAt !== undefined) {
      dto.completedAt = timing.completedAt;
    }
    if (elapsedMs !== undefined) {
      dto.elapsedMs = elapsedMs;
    }
    if (estimatedTotalMs !== undefined) {
      dto.estimatedTotalMs = estimatedTotalMs;
    }

    return dto;
  }

  function toInputSummaryDto(
    job: P0JobRecord,
    book: Book,
    templates: readonly TemplateDto[]
  ): InputSummaryDto {
    const templatesById = new Map(templates.map((template) => [template.id, template]));

    return {
      bookDisplayName: book.displayName,
      templateNames: job.input.templateIds
        .map((templateId) => templatesById.get(templateId)?.name)
        .filter((name): name is string => Boolean(name)),
      modelId: job.input.modelId,
      modelSelectionMode: job.input.modelSelectionMode
    };
  }

  async function resolveJobTemplatesForInputSummary(job: P0JobRecord): Promise<TemplateDto[]> {
    const book = requireBook(job.bookId);
    const templatesById = new Map(
      (await listTemplatesForProject(book.projectId)).map((template) => [template.id, template])
    );
    return job.input.templateIds
      .map((templateId) => templatesById.get(templateId))
      .filter((template): template is TemplateDto => Boolean(template));
  }

  async function buildJobDto(job: P0JobRecord): Promise<JobDto> {
    const book = requireBook(job.bookId);
    const templates = await resolveJobTemplatesForInputSummary(job);

    return {
      id: job.id,
      bookId: job.bookId,
      status: job.status,
      modelSelectionMode: job.input.modelSelectionMode,
      autoRetryOnFailure: job.input.autoRetryOnFailure,
      progressText: job.progressText,
      progress: toJobProgressDto(job),
      timing: toJobTimingDto(job, clock.now()),
      output: {
        outputDirectoryLabel: book.displayName,
        canOpenOutputDirectory: job.status === "completed"
      },
      inputSummary: toInputSummaryDto(job, book, templates),
      tokenText: job.tokenText,
      failureReason: job.failureReason,
      logFilePath: job.logFilePath,
      allowedActions: getAllowedActions(job.status),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    };
  }

  async function loadProjectRuntime(projectId: string): Promise<ProjectRuntimeDto> {
    const project = await ensureProject(projectId);
    const state = await getProjectRuntimeStore(project).load();
    hydrateProjectRuntimeState(state);

    return {
      books: state.books.map((record) => record.upload),
      jobs: await Promise.all(state.jobs.filter((job) => job.status !== "deleted").map(buildJobDto))
    };
  }

  function createUniqueTemplateId(usedTemplateIds: Set<string>): string {
    let nextId = idGenerator.createId("template");
    while (usedTemplateIds.has(nextId)) {
      nextId = idGenerator.createId("template");
    }
    usedTemplateIds.add(nextId);
    return nextId;
  }

  function ensureUniqueTemplateIds(store: TemplateStoreState): boolean {
    const usedTemplateIds = new Set<string>();
    let changed = false;

    store.templates = store.templates.map((template) => {
      if (template.id && !usedTemplateIds.has(template.id)) {
        usedTemplateIds.add(template.id);
        return template;
      }

      changed = true;
      return {
        ...template,
        id: createUniqueTemplateId(usedTemplateIds)
      };
    });

    return changed;
  }

  function getDefaultTemplateSelectionIdsFromStore(
    store: TemplateStoreState,
    projectId: string
  ): string[] {
    const builtInTemplateIds = new Set<string>(getBuiltInTemplates().map((template) => template.id));
    return sortTemplates(
      store.templates.filter(
        (template) =>
          builtInTemplateIds.has(template.id) &&
          (template.scope === "global" || template.projectId === projectId)
      )
    ).map((template) => template.id);
  }

  async function loadTemplateStore(): Promise<TemplateStoreState> {
    if (templateStorePromise) {
      return templateStorePromise;
    }

    templateStorePromise = (async () => {
      try {
        const rawStore = await fs.readFile(templateStorePath, "utf8");
        const parsed = JSON.parse(rawStore) as Partial<TemplateStoreState>;
        const store = {
          templates: Array.isArray(parsed.templates) ? parsed.templates : createBuiltInTemplateDtos(clock.now()),
          selectionsByProjectId:
            parsed.selectionsByProjectId && typeof parsed.selectionsByProjectId === "object"
              ? parsed.selectionsByProjectId
              : {}
        };

        if (ensureUniqueTemplateIds(store)) {
          for (const projectId of Object.keys(store.selectionsByProjectId)) {
            store.selectionsByProjectId[projectId] = getDefaultTemplateSelectionIdsFromStore(
              store,
              projectId
            );
          }
          await saveTemplateStore(store);
        }

        return store;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }

        return {
          templates: createBuiltInTemplateDtos(clock.now()),
          selectionsByProjectId: {}
        };
      }
    })();

    return templateStorePromise;
  }

  async function saveTemplateStore(store: TemplateStoreState): Promise<void> {
    await fs.mkdir(path.dirname(templateStorePath), { recursive: true });
    await fs.writeFile(templateStorePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }

  async function listTemplatesForProject(projectId: string): Promise<TemplateDto[]> {
    const store = await loadTemplateStore();
    return sortTemplates(
      store.templates.filter(
        (template) => template.scope === "global" || template.projectId === projectId
      )
    );
  }

  async function filterTemplateIdsForProject(
    projectId: string,
    templateIds: readonly string[]
  ): Promise<string[]> {
    const allowedTemplateIds = new Set(
      (await listTemplatesForProject(projectId)).map((template) => template.id)
    );
    const nextTemplateIds: string[] = [];

    for (const templateId of templateIds) {
      if (allowedTemplateIds.has(templateId) && !nextTemplateIds.includes(templateId)) {
        nextTemplateIds.push(templateId);
      }
    }

    return nextTemplateIds;
  }

  async function getTemplateSelection(projectId: string): Promise<TemplateSelectionDto> {
    const store = await loadTemplateStore();
    const storedSelection = store.selectionsByProjectId[projectId];

    if (!storedSelection) {
      return {
        projectId,
        templateIds: await filterTemplateIdsForProject(
          projectId,
          getBuiltInTemplates().map((template) => template.id)
        )
      };
    }

    const templateIds = await filterTemplateIdsForProject(projectId, storedSelection);
    if (templateIds.length !== storedSelection.length) {
      store.selectionsByProjectId[projectId] = templateIds;
      await saveTemplateStore(store);
    }

    return { projectId, templateIds };
  }

  function normalizeTemplateOutputFileNameForUniqueness(fileName: string): string {
    return fileName.trim().replace(/\\/g, "/").toLowerCase();
  }

  function assertUniqueTemplateOutputFileNames(templates: readonly TemplateDto[]): void {
    const templatesByOutput = new Map<string, TemplateDto[]>();

    for (const template of templates) {
      const normalizedOutputFileName = normalizeTemplateOutputFileNameForUniqueness(template.fileName);
      templatesByOutput.set(normalizedOutputFileName, [
        ...(templatesByOutput.get(normalizedOutputFileName) ?? []),
        template
      ]);
    }

    const duplicateGroups = [...templatesByOutput.values()].filter((group) => group.length > 1);
    if (duplicateGroups.length === 0) {
      return;
    }

    const duplicateDescriptions = duplicateGroups.map((group) => {
      const outputFileName = group[0].fileName;
      const templateNames = group.map((template) => template.name).join("、");
      return `${outputFileName}（${templateNames}）`;
    });

    throw new Error(`模板输出文件名不能重复：${duplicateDescriptions.join("；")}`);
  }

  async function resolveTemplatesForProject(
    projectId: string,
    templateIds: readonly string[]
  ): Promise<TemplateDto[]> {
    const templatesById = new Map(
      (await listTemplatesForProject(projectId)).map((template) => [template.id, template])
    );
    const templates = templateIds
      .map((templateId) => templatesById.get(templateId))
      .filter((template): template is TemplateDto => Boolean(template));

    if (templates.length === 0) {
      throw new Error("请选择模板");
    }

    assertUniqueTemplateOutputFileNames(templates);
    return templates;
  }

  async function resolveJobTemplates(job: P0JobRecord): Promise<TemplateDto[]> {
    const book = requireBook(job.bookId);
    return resolveTemplatesForProject(book.projectId, job.input.templateIds);
  }

  function createTemplateGroupId(prefix: string, value: string): string {
    const safeValue = toSafeSegment(value);
    const hash = sha256(value).slice(0, 12);
    return `${prefix}-${safeValue}-${hash}`;
  }

  function createTemplateHash(template: TemplateDto): string {
    return sha256(
      stableJson({
        outputFileName: template.fileName,
        templateBody: template.body,
        templateId: template.id,
        templateName: template.name
      })
    );
  }

  function createGroupHash(group: {
    groupDisplayName: string;
    groupId: string;
    maxFullTemplatesPerCall: number;
    templates: TemplateDto[];
  }): string {
    return sha256(
      stableJson({
        groupDisplayName: group.groupDisplayName,
        groupId: group.groupId,
        maxFullTemplatesPerCall: group.maxFullTemplatesPerCall,
        templates: group.templates.map((template) => ({
          outputFileName: template.fileName,
          templateBody: template.body,
          templateId: template.id,
          templateName: template.name
        }))
      })
    );
  }

  function buildRuleSnapshots(
    templates: TemplateDto[],
    strategy: TemplateGroupFallbackStrategy,
    maxFullTemplatesPerCall: number
  ): {
    templates: TemplateRulesSnapshot[];
    groups: TemplateGroupRulesSnapshot[];
  } {
    const groupTemplates = new Map<string, TemplateDto[]>();
    const groupDisplayNames = new Map<string, string>();

    for (const template of templates) {
      const groupId =
        strategy === "one-template-per-group"
          ? createTemplateGroupId("template", template.id)
          : createTemplateGroupId("output", path.basename(template.fileName, path.extname(template.fileName)));
      const groupDisplayName =
        strategy === "one-template-per-group" ? template.name : toReportDisplayName(template.fileName);

      groupTemplates.set(groupId, [...(groupTemplates.get(groupId) ?? []), template]);
      groupDisplayNames.set(groupId, groupDisplayName);
    }

    const snapshotTemplates: TemplateRulesSnapshot[] = templates.map((template) => {
      const groupId =
        strategy === "one-template-per-group"
          ? createTemplateGroupId("template", template.id)
          : createTemplateGroupId("output", path.basename(template.fileName, path.extname(template.fileName)));

      return {
        templateId: template.id,
        templateName: template.name,
        templateBody: template.body,
        outputFileName: template.fileName,
        routeDescription: "按模板名称、输出文件名和模板正文判断当前窗口是否相关。",
        groupId,
        templateHash: createTemplateHash(template)
      };
    });
    const groups: TemplateGroupRulesSnapshot[] = [...groupTemplates.entries()].map(
      ([groupId, groupedTemplates]) => ({
        groupId,
        groupDisplayName: groupDisplayNames.get(groupId) ?? groupId,
        templateIds: groupedTemplates.map((template) => template.id),
        maxFullTemplatesPerCall,
        groupHash: createGroupHash({
          groupDisplayName: groupDisplayNames.get(groupId) ?? groupId,
          groupId,
          maxFullTemplatesPerCall,
          templates: groupedTemplates
        })
      })
    );

    return {
      templates: snapshotTemplates,
      groups
    };
  }

  async function preparePreRunArtifacts(job: P0JobRecord): Promise<PreparedPreRunArtifacts> {
    const book = requireBook(job.bookId);
    const project = await ensureProject(book.projectId);
    const extractionRuleDefaults = getDefaultConfig().extractionRuleDefaults;
    const templates = await resolveJobTemplates(job);
    const ruleSnapshots = buildRuleSnapshots(
      templates,
      extractionRuleDefaults.templateGroupFallbackStrategy,
      extractionRuleDefaults.maxFullTemplatesPerCall
    );

    const runtimeWindows = await generateRuntimeWindows({
      projectRoot: project.rootPath,
      jobId: job.id,
      bookId: book.id,
      sourceTextPath: book.sourceTextPath,
      singleRunChapterCount: job.input.singleRunChapterCount,
      overlapChapterCount: job.input.overlapChapterCount,
      extractionChapterCount: job.input.extractionChapterCount,
      generatedAt: clock.now()
    });

    const createArtifacts = (
      windowsResult: GenerateRuntimeWindowsResult,
      rulesResult: Pick<GenerateExtractionRulesResult, "rulesLatestPath" | "rulesSnapshotPath">
    ): PreparedPreRunArtifacts => ({
      book,
      project,
      runtimeWindowManifest: windowsResult.manifest,
      rulesLatestPath: rulesResult.rulesLatestPath,
      rulesSnapshotPath: rulesResult.rulesSnapshotPath,
      rulesSnapshotAbsolutePath: path.join(project.rootPath, rulesResult.rulesSnapshotPath),
      rulesLatestAbsolutePath: path.join(project.rootPath, rulesResult.rulesLatestPath),
      templates,
      windowsManifestPath: windowsResult.manifestPath,
      windowsRoot: windowsResult.windowsRoot
    });

    try {
      const rulesResult = await generateExtractionRules({
        projectRoot: project.rootPath,
        jobId: job.id,
        bookId: book.id,
        bookDisplayName: book.displayName,
        templates: ruleSnapshots.templates,
        groups: ruleSnapshots.groups,
        routeFailurePolicy: { ...extractionRuleDefaults.routeFailurePolicy },
        ruleSections: {
          commonExtractionRules: [...extractionRuleDefaults.ruleSections.commonExtractionRules],
          writeRules: [...extractionRuleDefaults.ruleSections.writeRules],
          skipAlreadyExtractedRules: [...extractionRuleDefaults.ruleSections.skipAlreadyExtractedRules]
        },
        generatedAt: clock.now()
      });
      return createArtifacts(runtimeWindows, rulesResult);
    } catch (error) {
      if (error instanceof ExtractionRulesError && error.code === "SNAPSHOT_ALREADY_EXISTS") {
        const rulesSnapshotPath = ["runs", job.id, "rules", RULES_FILE_NAME].join("/");
        const rulesLatestPath = ["rules", RULES_FILE_NAME].join("/");
        const snapshotRulesPath = path.join(project.rootPath, "runs", job.id, "rules", RULES_FILE_NAME);
        const latestRulesPath = path.join(project.rootPath, "rules", RULES_FILE_NAME);
        const snapshotRules = await fs.readFile(snapshotRulesPath, "utf8");

        await fs.mkdir(path.dirname(latestRulesPath), { recursive: true });
        await fs.writeFile(latestRulesPath, snapshotRules, "utf8");
        return createArtifacts(runtimeWindows, {
          rulesLatestPath,
          rulesSnapshotPath
        });
      }
      throw error;
    }
  }

  function requireBook(bookId: string): Book {
    const book = booksById.get(bookId);
    if (!book) {
      throw new Error(`Book not found: ${bookId}`);
    }
    return book;
  }

  function requireJob(jobId: string): P0JobRecord {
    const job = jobsById.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }
    return job;
  }

  function getFailureReason(error: unknown): string {
    return error instanceof Error ? error.message : "任务失败";
  }

  function getRuntimeErrorReason(error: JobRuntimeError): string {
    return error.code === "job_failed" ? error.message : `任务运行失败：${error.code}`;
  }

  function estimateRuntimeWindowCount(book: Book, input: CreateJobDto): number {
    return planChapterWindows({
      chapterIds: Array.from({ length: book.chapterCount }, (_, index) => String(index + 1)),
      chaptersPerWindow: input.singleRunChapterCount,
      maxChapters: input.extractionChapterCount,
      overlapChapterCount: input.overlapChapterCount
    }).length;
  }

  function estimateRuntimeTemplateWindowTargetCount(book: Book, input: CreateJobDto): number {
    return estimateRuntimeWindowCount(book, input) * Math.max(1, input.templateIds.length);
  }

  async function notifyJobUpdated(job: P0JobRecord): Promise<void> {
    try {
      options.onJobUpdated?.(await buildJobDto(job));
    } catch {
      // Renderer notification must not fail the underlying extraction run.
    }
  }

  function buildTaskInfo(job: P0JobRecord, book: Book): string {
    return [
      `任务 ${job.id}`,
      `书籍 ${book.displayName}`,
      `模型 ${job.input.modelId}`,
      `模板 ${job.input.templateIds.length} 个`,
      `单次章节 ${job.input.singleRunChapterCount}`,
      `提取章节 ${job.input.extractionChapterCount}`,
      `重叠章节 ${job.input.overlapChapterCount}`,
      `单批次模板 ${job.input.templateBatchSize}`
    ].join("，");
  }

  async function createTaskLoggerForJob(job: P0JobRecord): Promise<TaskTextLogger> {
    const book = requireBook(job.bookId);
    const project = await ensureProject(book.projectId);
    return createTaskTextLogger({
      clock,
      jobId: job.id,
      projectRoot: project.rootPath,
      appVersion: options.getAppVersion?.(),
      taskInfo: buildTaskInfo(job, book)
    });
  }

  async function readJobLog(job: P0JobRecord): Promise<string> {
    if (!job.logFilePath) {
      return "任务尚未开始，运行流程还没有生成。";
    }

    const book = requireBook(job.bookId);
    const project = await ensureProject(book.projectId);
    const logPath = path.join(project.rootPath, deriveSimpleLogFilePath(job.logFilePath));

    try {
      return await fs.readFile(logPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "运行流程文件不存在，可打开完整日志查看详情。";
      }
      throw error;
    }
  }

  function formatFailureRetryInterval(ms: number): string {
    if (ms > 0 && ms % 60000 === 0) {
      return `${ms / 60000} 分钟`;
    }
    if (ms > 0 && ms % 1000 === 0) {
      return `${ms / 1000} 秒`;
    }
    return `${ms}ms`;
  }

  async function appendExistingJobLogEntry(
    job: P0JobRecord,
    tags: readonly string[],
    value: unknown
  ): Promise<void> {
    if (!job.logFilePath) {
      return;
    }

    const book = requireBook(job.bookId);
    const project = await ensureProject(book.projectId);
    await appendTaskTextLogEntry({
      absolutePath: path.join(project.rootPath, job.logFilePath),
      simpleAbsolutePath: path.join(project.rootPath, deriveSimpleLogFilePath(job.logFilePath)),
      simpleStartedAt: job.timing?.startedAt,
      clock,
      tags,
      value
    });
  }

  async function appendAutoRetryLog(job: P0JobRecord, value: Record<string, unknown>): Promise<void> {
    try {
      await appendExistingJobLogEntry(job, ["自动续跑", "调度"], {
        任务ID: job.id,
        ...value
      });
    } catch {
      // Auto-retry logging is diagnostic only; it must not break the retry loop.
    }
  }

  async function openJobLog(job: P0JobRecord): Promise<void> {
    if (!job.logFilePath) {
      throw new Error("任务尚未开始，完整日志文件还没有生成。");
    }

    const book = requireBook(job.bookId);
    const project = await ensureProject(book.projectId);
    const result = await shellApi.openPath(path.join(project.rootPath, job.logFilePath));
    if (result) {
      throw new Error(result);
    }
  }

  async function openJobOutputDirectory(job: P0JobRecord): Promise<void> {
    const book = requireBook(job.bookId);
    const project = await ensureProject(book.projectId);
    const result = await shellApi.openPath(
      path.join(project.rootPath, "assets", "books", book.id, "reports")
    );
    if (result) {
      throw new Error(result);
    }
  }

  async function persistJob(job: P0JobRecord): Promise<void> {
    const book = requireBook(job.bookId);
    const project = await ensureProject(book.projectId);
    await getProjectRuntimeStore(project).saveJob(job);
  }

  async function deletePersistedJob(job: P0JobRecord): Promise<void> {
    const book = requireBook(job.bookId);
    const project = await ensureProject(book.projectId);
    await getProjectRuntimeStore(project).deleteJob(job.id);
  }

  async function persistReport(report: ReportAsset, reportPath: string): Promise<void> {
    const book = requireBook(report.bookId);
    const project = await ensureProject(book.projectId);
    await getProjectRuntimeStore(project).saveReport({ report, path: reportPath });
  }

  async function hasRunDirectory(projectRoot: string, jobId: string): Promise<boolean> {
    try {
      const stats = await fs.stat(path.join(projectRoot, "runs", jobId));
      return stats.isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  async function createUniqueJobId(projectRoot: string): Promise<string> {
    for (let attempt = 0; attempt < JOB_ID_COLLISION_RETRY_LIMIT; attempt += 1) {
      const jobId = idGenerator.createId("job");
      if (!jobsById.has(jobId) && !(await hasRunDirectory(projectRoot, jobId))) {
        return jobId;
      }
    }

    throw new Error("任务 ID 已存在，请重试");
  }

  function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  function requireStringField(input: Record<string, unknown>, fieldName: string, label: string): string {
    const value = input[fieldName];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`${label}不能为空`);
    }
    return value;
  }

  function requireStringArrayField(
    input: Record<string, unknown>,
    fieldName: string,
    label: string
  ): string[] {
    const value = input[fieldName];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
      throw new Error(`${label}不能为空`);
    }
    return [...value];
  }

  function requirePositiveIntegerField(
    input: Record<string, unknown>,
    fieldName: string,
    label: string
  ): number {
    const value = input[fieldName];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw new Error(`${label}必须是正整数`);
    }
    return value;
  }

  function requireNonNegativeIntegerField(
    input: Record<string, unknown>,
    fieldName: string,
    label: string
  ): number {
    const value = input[fieldName];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new Error(`${label}必须是非负整数`);
    }
    return value;
  }

  function requireBooleanField(input: Record<string, unknown>, fieldName: string, label: string): boolean {
    const value = input[fieldName];
    if (typeof value !== "boolean") {
      throw new Error(`${label}必须是布尔值`);
    }
    return value;
  }

  function normalizeCreateJobInput(input: CreateJobDto): CreateJobDto {
    if (!isPlainRecord(input)) {
      throw new Error("任务参数不能为空");
    }

    const singleRunChapterCount = requirePositiveIntegerField(
      input,
      "singleRunChapterCount",
      "单次窗口章节数"
    );
    const extractionChapterCount = requirePositiveIntegerField(
      input,
      "extractionChapterCount",
      "提取章节数"
    );
    const overlapChapterCount = requireNonNegativeIntegerField(
      input,
      "overlapChapterCount",
      "重叠章节数"
    );
    const templateBatchSize = requirePositiveIntegerField(
      input,
      "templateBatchSize",
      "单批次模板数"
    );

    if (extractionChapterCount < singleRunChapterCount) {
      throw new Error("提取章节数必须大于或等于单次窗口章节数");
    }

    if (overlapChapterCount >= singleRunChapterCount) {
      throw new Error("重叠章节数必须小于单次窗口章节数");
    }

    const modelSelectionMode = input.modelSelectionMode ?? "explicit";
    if (modelSelectionMode !== "explicit" && modelSelectionMode !== "auto") {
      throw new Error("模型选择模式无效");
    }

    return {
      bookId: requireStringField(input, "bookId", "小说"),
      templateIds: requireStringArrayField(input, "templateIds", "模板"),
      providerConfigId: requireStringField(input, "providerConfigId", "模型供应商"),
      modelId: requireStringField(input, "modelId", "模型"),
      modelSelectionMode,
      autoRetryOnFailure: input.autoRetryOnFailure ?? false,
      singleRunChapterCount,
      extractionChapterCount,
      overlapChapterCount,
      templateBatchSize,
      skipAlreadyExtracted: requireBooleanField(input, "skipAlreadyExtracted", "跳过已提取")
    };
  }

  interface RunModelBackedJobOptions {
    autoRetryLog?: {
      intervalText: string;
    };
    skipAlreadyExtracted?: boolean;
  }

  function withRunOptions(
    job: P0JobRecord,
    runOptions: RunModelBackedJobOptions | undefined
  ): P0JobRecord {
    if (runOptions?.skipAlreadyExtracted === undefined) {
      return job;
    }

    return {
      ...job,
      input: {
        ...job.input,
        templateIds: [...job.input.templateIds],
        skipAlreadyExtracted: runOptions.skipAlreadyExtracted
      }
    };
  }

  function getRunOptionsForScheduledJob(
    scheduledJob: P0JobRecord,
    latestJob: P0JobRecord
  ): RunModelBackedJobOptions | undefined {
    const runOptions: RunModelBackedJobOptions = {};
    const autoRetryLog = pendingAutoRetryRunLogsByJobId.get(scheduledJob.id);
    if (autoRetryLog) {
      runOptions.autoRetryLog = autoRetryLog;
    }
    if (scheduledJob.input.skipAlreadyExtracted !== latestJob.input.skipAlreadyExtracted) {
      runOptions.skipAlreadyExtracted = scheduledJob.input.skipAlreadyExtracted;
    }

    return runOptions.autoRetryLog || runOptions.skipAlreadyExtracted !== undefined
      ? runOptions
      : undefined;
  }

  function toTerminalFailurePatch(
    job: P0JobRecord,
    failureReason: string
  ): Partial<P0JobRecord> {
    return {
      status: "failed",
      failureReason,
      timing: {
        ...job.timing,
        completedAt: job.timing?.completedAt ?? clock.now(),
        estimatedTotalMs: undefined,
        estimatedRemainingMs: undefined,
        estimateFrozenAt: undefined
      }
    };
  }

  function toInitialRunningPatch(
    job: P0JobRecord,
    input: {
      initialTotalWindowCount: number;
      logFilePath?: string;
      runOptions?: RunModelBackedJobOptions;
    }
  ): Partial<P0JobRecord> {
    const shouldRestartFromScratch = input.runOptions?.skipAlreadyExtracted === false;
    const shouldContinuePreviousRun =
      !shouldRestartFromScratch && (job.status === "paused" || job.status === "failed");
    const shouldStartNewVisibleTimer =
      shouldRestartFromScratch || job.status === "paused" || job.status === "failed";
    const runningStartedAt =
      shouldStartNewVisibleTimer
        ? clock.now()
        : (job.timing?.startedAt ?? clock.now());
    const initialWindowEstimateMs = createInitialWindowEstimateMs();
    const previouslyCompletedWindowCount = shouldContinuePreviousRun
      ? clampWindowCount(
          job.progress?.completedWindowCount ?? 0,
          0,
          input.initialTotalWindowCount
        )
      : 0;
    const estimateWindowCount = input.initialTotalWindowCount - previouslyCompletedWindowCount;

    return {
      status: "running",
      progressText: `进度：0/${input.initialTotalWindowCount} 模板窗口`,
      tokenText: formatTokenText(null),
      failureReason: undefined,
      logFilePath: input.logFilePath ?? job.logFilePath,
      progress: {
        completedWindowCount: 0,
        totalWindowCount: input.initialTotalWindowCount,
        skippedWindowCount: 0,
        executedWindowCount: 0
      },
      timing: {
        ...job.timing,
        startedAt: runningStartedAt,
        completedAt: undefined,
        tokenPlanWaitStartedAt: undefined,
        tokenPlanWaitElapsedMs: shouldStartNewVisibleTimer
          ? 0
          : (job.timing?.tokenPlanWaitElapsedMs ?? 0),
        initialWindowEstimateMs,
        effectiveTotalWindowCount: estimateWindowCount,
        executedWindowElapsedMs: 0,
        estimateBaselineExecutedWindowCount: 0,
        estimateBaselineExecutedWindowElapsedMs: 0,
        estimatedTotalMs: initialWindowEstimateMs * estimateWindowCount,
        estimatedRemainingMs: undefined,
        estimateFrozenAt: undefined
      }
    };
  }

  async function markJobRunning(
    job: P0JobRecord,
    input: {
      logFilePath?: string;
      runOptions?: RunModelBackedJobOptions;
    } = {}
  ): Promise<P0JobRecord> {
    return updateJob(
      job,
      toInitialRunningPatch(job, {
        ...input,
        initialTotalWindowCount: estimateRuntimeTemplateWindowTargetCount(requireBook(job.bookId), job.input)
      })
    );
  }

  async function runModelBackedJob(
    job: P0JobRecord,
    runOptions?: RunModelBackedJobOptions
  ): Promise<JobDto> {
    const initialRunJob = withRunOptions(job, runOptions);
    let runningJob = initialRunJob;
    let taskLogger: TaskTextLogger | undefined;

    try {
      taskLogger = await createTaskLoggerForJob(initialRunJob);
      runningJob = await markJobRunning(initialRunJob, {
        logFilePath: taskLogger.relativePath,
        runOptions
      });
      if (runOptions?.autoRetryLog) {
        await taskLogger.append(["自动续跑", "调度"], {
          任务ID: runningJob.id,
          事件: "触发",
          下次间隔: runOptions.autoRetryLog.intervalText
        });
        await taskLogger.append(["自动续跑", "调度"], {
          任务ID: runningJob.id,
          事件: "已接收",
          状态: "已进入运行",
          下次间隔: runOptions.autoRetryLog.intervalText
        });
      }
      const artifacts = await preparePreRunArtifacts(withRunOptions(runningJob, runOptions));
      await taskLogger.append(["上下文", "任务"], {
        任务ID: runningJob.id,
        书籍ID: artifacts.book.id,
        书籍名称: artifacts.book.displayName,
        模型: runningJob.input.modelId,
        模板: artifacts.templates.map((template) => ({
          模板ID: template.id,
          模板名称: template.name,
          输出文件: template.fileName
        })),
        窗口数量: artifacts.runtimeWindowManifest.windows.length,
        规则快照: artifacts.rulesSnapshotPath,
        报告目录: ["reports", artifacts.book.id].join("/")
      });
      const totalTemplateWindowCount =
        artifacts.runtimeWindowManifest.windows.length * Math.max(1, artifacts.templates.length);
      const initialWindowEstimateMs = runningJob.timing?.initialWindowEstimateMs ?? createInitialWindowEstimateMs();
      runningJob = await updateJob(runningJob, {
        progressText: `进度：0/${totalTemplateWindowCount} 模板窗口`,
        progress: {
          completedWindowCount: 0,
          totalWindowCount: totalTemplateWindowCount,
          skippedWindowCount: 0,
          executedWindowCount: 0
        },
        timing: {
          ...runningJob.timing,
          initialWindowEstimateMs,
          effectiveTotalWindowCount: totalTemplateWindowCount,
          executedWindowElapsedMs: 0,
          estimatedTotalMs: initialWindowEstimateMs * totalTemplateWindowCount,
          estimatedRemainingMs: undefined,
          estimateFrozenAt: undefined
        }
      });

      const windowRunService = createWindowRunService({
        clock,
        credentialStore,
        fetch: options.fetch,
        findExistingReport({ bookId, fileName }) {
          return [...reportsById.values()].find(
            (report) => report.bookId === bookId && report.fileName === fileName
          );
        },
        idGenerator,
        onRuntimeCreated({ jobId, runtime }) {
          activeWindowRuntimes.set(jobId, runtime);
        },
        onRuntimeSettled({ jobId, runtime }) {
          if (activeWindowRuntimes.get(jobId) === runtime) {
            activeWindowRuntimes.delete(jobId);
          }
        },
        async onModelCandidateChanged({ jobId, candidate }) {
          const currentJob = requireJob(jobId);
          runningJob = await updateJob(currentJob, {
            input: {
              ...currentJob.input,
              providerConfigId: candidate.providerConfigId,
              modelId: candidate.modelId
            }
          });
        },
        async onTokenPlanWaitStarted({ jobId }) {
          const currentJob = jobsById.get(jobId);
          if (!currentJob || currentJob.timing?.tokenPlanWaitStartedAt) {
            return;
          }
          await updateJob(currentJob, {
            timing: {
              ...currentJob.timing,
              tokenPlanWaitStartedAt: clock.now()
            }
          });
        },
        async onTokenPlanWaitEnded({ jobId }) {
          const currentJob = jobsById.get(jobId);
          const waitStartedAt = currentJob?.timing?.tokenPlanWaitStartedAt;
          if (!currentJob || !waitStartedAt) {
            return;
          }
          const waitEndedAt = clock.now();
          const waitElapsedMs = calculateElapsedMs(waitStartedAt, waitEndedAt) ?? 0;
          await updateJob(currentJob, {
            timing: {
              ...currentJob.timing,
              tokenPlanWaitStartedAt: undefined,
              tokenPlanWaitElapsedMs:
                Math.max(0, currentJob.timing?.tokenPlanWaitElapsedMs ?? 0) + waitElapsedMs
            }
          });
        },
        async onRuntimeState(state) {
          const currentJob = jobsById.get(state.jobId);
          if (!currentJob) {
            return;
          }
          await updateJob(
            currentJob,
            toJobPatchFromRuntimeState(state, currentJob, clock, { createInitialWindowEstimateMs })
          );
        },
        providerStore,
        enabledToolNames: options.enabledToolNames,
        templateBatchFailureRetryIntervalMs,
        tokenPlanWaitGate,
        taskLogger,
        async registerReport({ path: reportPath, report }) {
          reportsById.set(report.id, report);
          reportPathById.set(report.id, reportPath);
          await persistReport(report, reportPath);
        }
      });
      const result = await windowRunService.runJobWindows({
        artifacts,
        job: withRunOptions(runningJob, runOptions)
      });

      const latestJob = jobsById.get(runningJob.id);
      if (!latestJob) {
        return await buildJobDto(runningJob);
      }

      if (!result.ok) {
        const failedJob = await updateJob(
          latestJob,
          toTerminalFailurePatch(latestJob, getRuntimeErrorReason(result.error))
        );
        return await buildJobDto(failedJob);
      }

      return await buildJobDto(latestJob);
    } catch (error) {
      if (taskLogger) {
        try {
          await taskLogger.append(["错误", "任务"], getFailureReason(error));
        } catch {
          // The job status is the source of truth; logging must not keep it running forever.
        }
      }
      const latestJob = jobsById.get(runningJob.id);
      if (!latestJob) {
        return await buildJobDto(runningJob);
      }
      return await buildJobDto(
        await updateJob(latestJob, {
          ...toTerminalFailurePatch(latestJob, getFailureReason(error)),
          progressText: "任务失败"
        })
      );
    }
  }

  const jobScheduler = createJobScheduler<P0JobRecord>({
    maxConcurrentJobs: schedulerDefaults.maxConcurrentJobs,
    maxConcurrentJobsPerBook: schedulerDefaults.maxConcurrentJobsPerBook,
    async onStarted(job) {
      const latestJob = requireJob(job.id);
      const runOptions = getRunOptionsForScheduledJob(job, latestJob);

      await markJobRunning(withRunOptions(latestJob, runOptions), { runOptions });
    },
    async run(job) {
      const latestJob = requireJob(job.id);
      const runOptions = getRunOptionsForScheduledJob(job, latestJob);
      pendingAutoRetryRunLogsByJobId.delete(job.id);

      await runModelBackedJob(latestJob, runOptions);
    },
    async onQueued(job, reason) {
      const latestJob = requireJob(job.id);
      await updateJob(latestJob, {
        progressText:
          reason === "book_limit"
            ? schedulerDefaults.queuedByBookLimitText
            : schedulerDefaults.queuedByGlobalLimitText
      });
    }
  });

  const failureRetryScheduler = createFailureRetryScheduler({
    intervalMs: failureRetryIntervalMs,
    async enqueue(jobId) {
      const latestJob = jobsById.get(jobId);
      if (!latestJob || latestJob.status !== "failed" || !latestJob.input.autoRetryOnFailure) {
        return "accepted";
      }
      const retryIntervalText = formatFailureRetryInterval(failureRetryIntervalMs);
      if (jobScheduler.isRunning(jobId)) {
        await appendAutoRetryLog(latestJob, {
          事件: "等待下次",
          原因: "任务仍在运行",
          下次间隔: retryIntervalText
        });
        return "failed";
      }
      if (jobScheduler.isQueued(jobId)) {
        await appendAutoRetryLog(latestJob, {
          事件: "已接收",
          状态: "已在队列",
          下次间隔: retryIntervalText
        });
        return "accepted";
      }

      try {
        pendingAutoRetryRunLogsByJobId.set(jobId, {
          intervalText: retryIntervalText
        });
        const updatedJob = await enqueueModelBackedJob(latestJob, {
          skipAlreadyExtracted: true
        });
        const nextJob = jobsById.get(jobId) ?? latestJob;
        if (jobScheduler.isQueued(jobId)) {
          await appendAutoRetryLog(nextJob, {
            事件: "已接收",
            状态: "已进入队列",
            下次间隔: retryIntervalText
          });
          return "accepted";
        }
        if (updatedJob.status === "failed") {
          pendingAutoRetryRunLogsByJobId.delete(jobId);
          await appendAutoRetryLog(nextJob, {
            事件: "等待下次",
            原因: "本次续跑仍失败",
            下次间隔: retryIntervalText
          });
          return "failed";
        }
        await appendAutoRetryLog(nextJob, {
          事件: "已接收",
          状态: updatedJob.status,
          下次间隔: retryIntervalText
        });
        return "accepted";
      } catch (error) {
        pendingAutoRetryRunLogsByJobId.delete(jobId);
        await appendAutoRetryLog(latestJob, {
          事件: "等待下次",
          原因: getFailureReason(error),
          下次间隔: retryIntervalText
        });
        return "failed";
      }
    }
  });

  function syncFailureRetrySchedule(job: P0JobRecord): void {
    if (job.status === "failed") {
      if (jobScheduler.isQueued(job.id)) {
        failureRetryScheduler.cancel(job.id);
        return;
      }
      failureRetryScheduler.onJobFailed({
        jobId: job.id,
        autoRetryOnFailure: Boolean(job.input.autoRetryOnFailure)
      });
      return;
    }

    failureRetryScheduler.cancel(job.id);
  }

  async function enqueueModelBackedJob(
    job: P0JobRecord,
    runOptions?: RunModelBackedJobOptions
  ): Promise<JobDto> {
    const scheduledJob = withRunOptions(job, runOptions);
    try {
      await jobScheduler.enqueue(scheduledJob);
      return await buildJobDto(requireJob(job.id));
    } catch (error) {
      const existingJob = jobsById.get(job.id);
      if (!existingJob) {
        throw error;
      }
      const latestJob = withRunOptions(existingJob, runOptions);
      const failedJob = await updateJob(latestJob, {
        ...toTerminalFailurePatch(latestJob, getFailureReason(error)),
        progressText: "任务失败"
      });
      return await buildJobDto(failedJob);
    }
  }

  function assertJobNotQueuedForAction(jobId: string, actionLabel: string): void {
    if (jobScheduler.isQueued(jobId)) {
      throw new Error(`排队中的任务暂不支持${actionLabel}；可删除排队任务或等待运行。`);
    }
  }

  function formatRuntimeControlFailure(actionLabel: string, error: JobRuntimeError): string {
    if (error.code === "invalid_job_state") {
      return `当前任务状态不支持${actionLabel}。`;
    }
    if (error.code === "job_not_found") {
      return `运行中的任务暂时无法${actionLabel}；请稍后再试。`;
    }
    if (error.code === "job_failed") {
      return error.message;
    }
    return `任务${actionLabel}失败。`;
  }

  async function updateJob(
    job: P0JobRecord,
    patch: Partial<P0JobRecord>
  ): Promise<P0JobRecord> {
    const nextJob = {
      ...job,
      ...patch,
      updatedAt: clock.now()
    };
    const previousJob = jobsById.get(nextJob.id);
    jobsById.set(nextJob.id, nextJob);
    try {
      await persistJob(nextJob);
    } catch (error) {
      if (jobsById.get(nextJob.id) === nextJob) {
        if (previousJob) {
          jobsById.set(previousJob.id, previousJob);
        } else {
          jobsById.delete(nextJob.id);
        }
      }
      throw error;
    }
    if (!jobsById.has(nextJob.id)) {
      await deletePersistedJob(nextJob);
      throw new Error(`Job not found: ${nextJob.id}`);
    }
    await notifyJobUpdated(nextJob);
    syncFailureRetrySchedule(nextJob);
    return nextJob;
  }

  return {
    "project:create": async (input) => {
      const project = await projectStore.createProject(input);
      return {
        id: project.id,
        displayName: project.displayName,
        slug: project.slug,
        createdAt: project.createdAt
      };
    },
    "project:list": async () =>
      (await projectStore.listProjects()).map((project) => ({
        id: project.id,
        displayName: project.displayName,
        slug: project.slug,
        createdAt: project.createdAt
      })),
    "books:uploadTxt": async (input) => {
      const project = await ensureProject(input.projectId);
      const sourceStat = await fs.stat(input.filePath);
      const upload = await uploadBook({
        project,
        sourcePath: input.filePath,
        repository: uploadedBookRepository,
        displayName: input.displayName,
        clock,
        idGenerator
      });
      const result = {
        bookId: upload.book.id,
        displayName: upload.book.displayName,
        sourceAssetId: upload.book.sourceAssetId,
        sourceTextPath: upload.book.sourceTextPath,
        fileName: path.basename(input.filePath),
        byteSize: sourceStat.size,
        encoding: upload.encoding,
        chapterCount: upload.book.chapterCount
      };
      await getProjectRuntimeStore(project).saveUploadedBook({
        book: upload.book,
        upload: result
      });
      return result;
    },
    "books:listReports": async (input) =>
      [...reportsById.values()]
        .filter((report) => report.bookId === input.bookId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map(toReportDto),
    "projectRuntime:get": async (input) => loadProjectRuntime(input.projectId),
    "templates:list": async (input) => ({
      templates: await listTemplatesForProject(input.projectId)
    }),
    "templates:save": async (input: SaveTemplateDto) => {
      assertSupportedTemplateFile(input.fileName);

      const store = await loadTemplateStore();
      const now = clock.now();
      const existingTemplate = input.templateId
        ? store.templates.find((template) => template.id === input.templateId)
        : undefined;
      const usedTemplateIds = new Set(store.templates.map((template) => template.id));
      const savedTemplate: TemplateDto = {
        id: existingTemplate?.id ?? createUniqueTemplateId(usedTemplateIds),
        scope: input.scope,
        projectId: input.scope === "project" ? input.projectId : undefined,
        name: normalizeTemplateName(input.name),
        fileName: input.fileName.trim(),
        body: normalizeTemplateBody(input.body),
        createdAt: existingTemplate?.createdAt ?? now,
        updatedAt: now
      };

      store.templates = existingTemplate
        ? store.templates.map((template) =>
            template.id === existingTemplate.id ? savedTemplate : template
          )
        : [...store.templates, savedTemplate];

      for (const [projectId, templateIds] of Object.entries(store.selectionsByProjectId)) {
        store.selectionsByProjectId[projectId] = await filterTemplateIdsForProject(projectId, templateIds);
      }

      await saveTemplateStore(store);
      return savedTemplate;
    },
    "templates:delete": async (input) => {
      const store = await loadTemplateStore();
      store.templates = store.templates.filter((template) => template.id !== input.templateId);

      for (const [projectId, templateIds] of Object.entries(store.selectionsByProjectId)) {
        store.selectionsByProjectId[projectId] = templateIds.filter(
          (templateId) => templateId !== input.templateId
        );
      }

      await saveTemplateStore(store);
    },
    "templateSelection:get": async (input) => getTemplateSelection(input.projectId),
    "templateSelection:save": async (input) => {
      const store = await loadTemplateStore();
      const templateIds = await filterTemplateIdsForProject(input.projectId, input.templateIds);
      store.selectionsByProjectId[input.projectId] = templateIds;
      await saveTemplateStore(store);
      return { projectId: input.projectId, templateIds };
    },
    "jobs:create": async (input) => {
      const normalizedInput = normalizeCreateJobInput(input);
      const book = requireBook(normalizedInput.bookId);
      const project = await ensureProject(book.projectId);
      await resolveTemplatesForProject(book.projectId, normalizedInput.templateIds);
      const now = clock.now();
      const totalWindowCount = estimateRuntimeTemplateWindowTargetCount(book, normalizedInput);
      const job: P0JobRecord = {
        id: await createUniqueJobId(project.rootPath),
        bookId: book.id,
        status: "created",
        progressText: `进度：0/${totalWindowCount} 模板窗口`,
        progress: {
          completedWindowCount: 0,
          totalWindowCount
        },
        tokenText: formatTokenText(null),
        input: normalizedInput,
        createdAt: now,
        updatedAt: now
      };
      jobsById.set(job.id, job);
      await persistJob(job);
      return await buildJobDto(job);
    },
    "jobs:start": async (input) => {
      const job = requireJob(input.jobId);
      return enqueueModelBackedJob(job);
    },
    "jobs:pause": async (input) => {
      const job = requireJob(input.jobId);
      if (jobScheduler.isRunning(job.id)) {
        const runtime = activeWindowRuntimes.get(job.id);
        if (!runtime) {
          throw new Error("运行中的任务正在初始化暂停控制，请稍后再试。");
        }
        const result = await runtime.pauseJob(job.id);
        if (!result.ok) {
          if (
            result.error.code === "invalid_job_state" &&
            (result.error.currentStatus === "pause_requested" || result.error.currentStatus === "paused")
          ) {
            return await buildJobDto(requireJob(job.id));
          }
          throw new Error(formatRuntimeControlFailure("暂停", result.error));
        }
        return await buildJobDto(requireJob(job.id));
      }
      if (jobScheduler.isQueued(job.id)) {
        throw new Error("排队中的任务暂不支持暂停；可删除排队任务或等待运行。");
      }
      if (job.status === "paused") {
        return await buildJobDto(job);
      }
      throw new Error("当前任务状态不支持暂停。");
    },
    "jobs:resume": async (input) => {
      const job = requireJob(input.jobId);
      const runtime = activeWindowRuntimes.get(job.id);
      if (runtime) {
        const result = await runtime.resumeJob(job.id);
        if (!result.ok) {
          throw new Error(formatRuntimeControlFailure("继续", result.error));
        }
        return await buildJobDto(requireJob(job.id));
      }
      assertJobNotQueuedForAction(job.id, "继续");
      return enqueueModelBackedJob(job, { skipAlreadyExtracted: true });
    },
    "jobs:restart": async (input) => {
      const job = requireJob(input.jobId);
      assertJobNotQueuedForAction(job.id, "重新开始");
      return enqueueModelBackedJob(job, { skipAlreadyExtracted: false });
    },
    "jobs:updateRetryPolicy": async (input) => {
      const job = requireJob(input.jobId);
      if (!input.autoRetryOnFailure) {
        pendingAutoRetryRunLogsByJobId.delete(job.id);
      }
      const updatedJob = await updateJob(job, {
        input: {
          ...job.input,
          templateIds: [...job.input.templateIds],
          autoRetryOnFailure: input.autoRetryOnFailure
        }
      });
      return await buildJobDto(updatedJob);
    },
    "jobs:delete": async (input) => {
      if (!input.confirm) {
        throw new Error("Delete confirmation is required");
      }
      const jobId = input.jobId;
      failureRetryScheduler.cancel(jobId);
      pendingAutoRetryRunLogsByJobId.delete(jobId);
      jobScheduler.remove(jobId);
      const runtime = activeWindowRuntimes.get(jobId);
      if (runtime) {
        const result = await runtime.deleteJob(jobId);
        if (!result.ok && result.error.code !== "job_not_found") {
          throw new Error(formatRuntimeControlFailure("删除", result.error));
        }
      }
      const job = jobsById.get(jobId);
      jobsById.delete(jobId);
      if (job) {
        await deletePersistedJob(job);
      }
    },
    "jobs:readLog": async (input) => {
      const job = requireJob(input.jobId);
      return {
        jobId: job.id,
        logFilePath: job.logFilePath,
        content: await readJobLog(job)
      };
    },
    "jobs:openLog": async (input) => {
      const job = requireJob(input.jobId);
      await openJobLog(job);
    },
    "jobs:openOutputDirectory": async (input) => {
      const job = requireJob(input.jobId);
      await openJobOutputDirectory(job);
    },
    "reports:preview": async (input) => {
      const report = reportsById.get(input.reportId);
      const reportPath = reportPathById.get(input.reportId);
      if (!report || !reportPath) {
        throw new Error(`Report not found: ${input.reportId}`);
      }
      const markdown = await fs.readFile(reportPath, "utf8");
      const preview = renderSafeMarkdown(markdown);
      return {
        reportId: report.id,
        html: preview.html,
        headings: preview.headings,
        generatedAt: clock.now()
      };
    }
  };
}
