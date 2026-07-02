import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  getBuiltInTemplates,
  getDefaultConfig,
  getTaskStatusConfig,
  type TaskAction,
  type TemplateGroupFallbackStrategy
} from "@novel-extractor/config";
import type { Book, Chapter, Clock, IdGenerator, Project, ReportAsset } from "@novel-extractor/domain";
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
import type { JobRuntimeError, JobRuntimeState, TokenUsage } from "@novel-extractor/jobs";
import type { FetchLike } from "@novel-extractor/llm";
import { renderSafeMarkdown } from "@novel-extractor/markdown/preview";
import { createMemoryCredentialStore, type MemoryCredentialStore } from "./credentials";
import type { DesktopIpcHandlers } from "./ipc";
import {
  createFileProjectRuntimeStore,
  type ProjectRuntimeJobRecord,
  type ProjectRuntimeState,
  type ProjectRuntimeStore
} from "./projectRuntimeStore";
import { createFileProjectStore, type MainProjectStore } from "./projectStore";
import { createMemoryProviderStore, type MainProviderStore } from "./providerStore";
import { createTaskTextLogger, type TaskTextLogger } from "./taskTextLogger";
import { createWindowRunService, type WindowRunArtifacts } from "./windowRunService";
import type {
  CreateJobDto,
  JobDto,
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
  | "jobs:delete"
  | "jobs:readLog"
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
  onJobUpdated?: (job: JobDto) => void;
}

const TASK_STATUS_CONFIG = getTaskStatusConfig();
const RULES_FILE_NAME = "提取规则.md";
const JOB_ID_COLLISION_RETRY_LIMIT = 50;

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

function toJobDto(job: P0JobRecord): JobDto {
  return {
    id: job.id,
    bookId: job.bookId,
    status: job.status,
    progressText: job.progressText,
    tokenText: job.tokenText,
    failureReason: job.failureReason,
    logFilePath: job.logFilePath,
    allowedActions: getAllowedActions(job.status),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
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
  const idGenerator = options.idGenerator ?? createSequentialIdGenerator();
  const workspaceRoot =
    options.workspaceRoot ??
    process.env.NOVEL_EXTRACTOR_E2E_DATA_DIR ??
    path.join(process.cwd(), ".novel-extractor-data");

  const booksById = new Map<string, Book>();
  const chaptersByBookId = new Map<string, Chapter[]>();
  const jobsById = new Map<string, P0JobRecord>();
  const activeJobRuns = new Map<string, Promise<JobDto>>();
  const reportsById = new Map<string, ReportAsset>();
  const reportPathById = new Map<string, string>();
  const projectRuntimeStoresByRoot = new Map<string, ProjectRuntimeStore>();
  const providerStore = options.providerStore ?? createMemoryProviderStore();
  const credentialStore = options.credentialStore ?? createMemoryCredentialStore();
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
      chaptersByBookId.set(input.book.id, input.chapters);
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
      chaptersByBookId.set(book.id, state.chaptersByBookId[book.id] ?? []);
    }

    for (const job of state.jobs) {
      jobsById.set(job.id, job);
    }

    for (const report of state.reports) {
      reportsById.set(report.id, report);
      const reportPath = state.reportPathById[report.id];
      if (reportPath) {
        reportPathById.set(report.id, reportPath);
      }
    }
  }

  async function loadProjectRuntime(projectId: string): Promise<ProjectRuntimeDto> {
    const project = await ensureProject(projectId);
    const state = await getProjectRuntimeStore(project).load();
    hydrateProjectRuntimeState(state);

    return {
      books: state.books.map((record) => record.upload),
      jobs: state.jobs.filter((job) => job.status !== "deleted").map(toJobDto)
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
    return `进度：${state.completedWindowCount}/${state.totalWindowCount}`;
  }

  function estimateRuntimeWindowCount(book: Book, input: CreateJobDto): number {
    return planChapterWindows({
      chapterIds: Array.from({ length: book.chapterCount }, (_, index) => String(index + 1)),
      chaptersPerWindow: input.singleRunChapterCount,
      maxChapters: input.extractionChapterCount,
      overlapChapterCount: input.overlapChapterCount
    }).length;
  }

  function toJobStatusFromRuntime(status: JobRuntimeState["status"]): JobStatus {
    return status === "cancelled" ? "failed" : status;
  }

  function toJobPatchFromRuntimeState(state: JobRuntimeState): Partial<P0JobRecord> {
    return {
      status: toJobStatusFromRuntime(state.status),
      progressText: formatRuntimeProgress(state),
      tokenText: formatTokenText(state.usage),
      failureReason: state.failureReason
    };
  }

  function notifyJobUpdated(job: P0JobRecord): void {
    try {
      options.onJobUpdated?.(toJobDto(job));
    } catch {
      // Renderer notification must not fail the underlying extraction run.
    }
  }

  function buildTaskInfo(job: P0JobRecord, book: Book): string {
    return [
      `任务 ${job.id}`,
      `书籍 ${book.id}`,
      `模型 ${job.input.modelId}`,
      `模板 ${job.input.templateIds.length} 个`,
      `单次章节 ${job.input.singleRunChapterCount}`,
      `提取章节 ${job.input.extractionChapterCount}`,
      `重叠章节 ${job.input.overlapChapterCount}`
    ].join("，");
  }

  async function createTaskLoggerForJob(job: P0JobRecord): Promise<TaskTextLogger> {
    const book = requireBook(job.bookId);
    const project = await ensureProject(book.projectId);
    return createTaskTextLogger({
      clock,
      jobId: job.id,
      projectRoot: project.rootPath,
      taskInfo: buildTaskInfo(job, book)
    });
  }

  async function readJobLog(job: P0JobRecord): Promise<string> {
    if (!job.logFilePath) {
      return "任务尚未开始，日志文件还没有生成。";
    }

    const book = requireBook(job.bookId);
    const project = await ensureProject(book.projectId);
    const logPath = path.join(project.rootPath, job.logFilePath);

    try {
      return await fs.readFile(logPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "日志文件不存在，可能任务还没有真正开始或文件已被移动。";
      }
      throw error;
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

    if (extractionChapterCount < singleRunChapterCount) {
      throw new Error("提取章节数必须大于或等于单次窗口章节数");
    }

    if (overlapChapterCount >= singleRunChapterCount) {
      throw new Error("重叠章节数必须小于单次窗口章节数");
    }

    return {
      bookId: requireStringField(input, "bookId", "小说"),
      templateIds: requireStringArrayField(input, "templateIds", "模板"),
      providerConfigId: requireStringField(input, "providerConfigId", "模型供应商"),
      modelId: requireStringField(input, "modelId", "模型"),
      singleRunChapterCount,
      extractionChapterCount,
      overlapChapterCount,
      skipAlreadyExtracted: requireBooleanField(input, "skipAlreadyExtracted", "跳过已提取")
    };
  }

  interface RunModelBackedJobOptions {
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

  async function runModelBackedJob(
    job: P0JobRecord,
    runOptions?: RunModelBackedJobOptions
  ): Promise<JobDto> {
    const taskLogger = await createTaskLoggerForJob(job);
    let runningJob = await updateJob(job, {
      status: "running",
      progressText: "正在准备运行窗口",
      tokenText: formatTokenText(null),
      failureReason: undefined,
      logFilePath: taskLogger.relativePath
    });

    try {
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
      runningJob = await updateJob(runningJob, {
        progressText: `进度：0/${artifacts.runtimeWindowManifest.windows.length}`
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
        async onRuntimeState(state) {
          const currentJob = requireJob(state.jobId);
          await updateJob(currentJob, toJobPatchFromRuntimeState(state));
        },
        providerStore,
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

      if (!result.ok) {
        const latestJob = requireJob(runningJob.id);
        const failedJob =
          latestJob.status === "failed"
            ? latestJob
            : await updateJob(latestJob, {
                status: "failed",
                failureReason: getRuntimeErrorReason(result.error)
              });
        return toJobDto(failedJob);
      }

      return toJobDto(requireJob(runningJob.id));
    } catch (error) {
      await taskLogger.append(["错误", "任务"], getFailureReason(error));
      return toJobDto(
        await updateJob(runningJob, {
          status: "failed",
          progressText: "任务失败",
          failureReason: getFailureReason(error)
        })
      );
    }
  }

  function runOrReuseModelBackedJob(
    job: P0JobRecord,
    runOptions?: RunModelBackedJobOptions
  ): Promise<JobDto> {
    const activeRun = activeJobRuns.get(job.id);
    if (activeRun) {
      return activeRun;
    }

    const runPromise = runModelBackedJob(job, runOptions).finally(() => {
      activeJobRuns.delete(job.id);
    });
    activeJobRuns.set(job.id, runPromise);
    return runPromise;
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
    jobsById.set(nextJob.id, nextJob);
    await persistJob(nextJob);
    notifyJobUpdated(nextJob);
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
        chapters: upload.chapters,
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
      const job: P0JobRecord = {
        id: await createUniqueJobId(project.rootPath),
        bookId: book.id,
        status: "created",
        progressText: `进度：0/${estimateRuntimeWindowCount(book, normalizedInput)}`,
        tokenText: formatTokenText(null),
        input: normalizedInput,
        createdAt: now,
        updatedAt: now
      };
      jobsById.set(job.id, job);
      await persistJob(job);
      return toJobDto(job);
    },
    "jobs:start": async (input) => {
      const job = requireJob(input.jobId);
      return runOrReuseModelBackedJob(job);
    },
    "jobs:pause": async (input) => {
      const job = requireJob(input.jobId);
      return toJobDto(await updateJob(job, { status: "paused", progressText: "已暂停" }));
    },
    "jobs:resume": async (input) => {
      const job = requireJob(input.jobId);
      return runOrReuseModelBackedJob(job);
    },
    "jobs:restart": async (input) => {
      const job = requireJob(input.jobId);
      return runOrReuseModelBackedJob(job, { skipAlreadyExtracted: false });
    },
    "jobs:delete": async (input) => {
      if (!input.confirm) {
        throw new Error("Delete confirmation is required");
      }
      const job = jobsById.get(input.jobId);
      jobsById.delete(input.jobId);
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
