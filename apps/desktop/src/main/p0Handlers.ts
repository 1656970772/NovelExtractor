import fs from "node:fs/promises";
import path from "node:path";
import {
  getBuiltInTemplates,
  getProviderPresets,
  getTaskStatusConfig,
  type TaskAction
} from "@novel-extractor/config";
import type { Book, Chapter, Clock, IdGenerator, Project, ReportAsset } from "@novel-extractor/domain";
import { toTaskStatus, type JobStatus } from "@novel-extractor/domain/job";
import { uploadBook, type UploadedBookRepository } from "@novel-extractor/extraction/uploadBook";
import {
  createProviderRegistry,
  OpenAiCompatibleClient,
  type ChatCompletionResult,
  type CredentialStore as LlmCredentialStore,
  type FetchLike
} from "@novel-extractor/llm";
import { renderSafeMarkdown } from "@novel-extractor/markdown/preview";
import { createReportWriter } from "@novel-extractor/markdown/reportWriter";
import { createMemoryCredentialStore, redactSecrets, type MemoryCredentialStore } from "./credentials";
import type { DesktopIpcHandlers } from "./ipc";
import { createFileProjectStore, type MainProjectStore } from "./projectStore";
import { createMemoryProviderStore, type MainProviderStore } from "./providerStore";
import type {
  CreateJobDto,
  JobDto,
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
  | "templates:list"
  | "templates:save"
  | "templates:delete"
  | "templateSelection:get"
  | "templateSelection:save"
  | "jobs:create"
  | "jobs:start"
  | "jobs:pause"
  | "jobs:resume"
  | "jobs:delete"
  | "reports:preview"
>;

interface P0JobRecord {
  id: string;
  bookId: string;
  status: JobStatus;
  progressText: string;
  tokenText?: string;
  failureReason?: string;
  input: CreateJobDto;
  createdAt: string;
  updatedAt: string;
}

interface TemplateStoreState {
  templates: TemplateDto[];
  selectionsByProjectId: Record<string, string[]>;
}

export interface P0IpcHandlersOptions {
  workspaceRoot?: string;
  clock?: Clock;
  idGenerator?: IdGenerator;
  projectStore?: MainProjectStore;
  providerStore?: MainProviderStore;
  credentialStore?: MemoryCredentialStore;
  fetch?: FetchLike;
}

const TASK_STATUS_CONFIG = getTaskStatusConfig();
const PILL_TEMPLATE = getBuiltInTemplates().find((template) => template.id === "pill-analysis");
const DEFAULT_REPORT_FILE_NAME = PILL_TEMPLATE?.defaultOutputFileName ?? "丹药分析.md";

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
  const reportsById = new Map<string, ReportAsset>();
  const reportPathById = new Map<string, string>();
  const providerStore = options.providerStore ?? createMemoryProviderStore();
  const credentialStore = options.credentialStore ?? createMemoryCredentialStore();
  const projectStore =
    options.projectStore ??
    createFileProjectStore({
      workspaceRoot,
      clock,
      idGenerator
    });
  const llmCredentialStore: LlmCredentialStore = {
    async resolveApiKey(ref) {
      return credentialStore.readApiKey(ref) ?? null;
    }
  };
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

  async function resolveJobTemplates(job: P0JobRecord): Promise<TemplateDto[]> {
    const book = requireBook(job.bookId);
    const templatesById = new Map(
      (await listTemplatesForProject(book.projectId)).map((template) => [template.id, template])
    );
    const templates = job.input.templateIds
      .map((templateId) => templatesById.get(templateId))
      .filter((template): template is TemplateDto => Boolean(template));

    if (templates.length === 0) {
      throw new Error("请选择模板");
    }

    return templates;
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

  function getTotalTokens(usage: unknown): number {
    if (typeof usage !== "object" || usage === null) {
      return 0;
    }

    const usageRecord = usage as Record<string, unknown>;
    const totalTokens = usageRecord.total_tokens ?? usageRecord.totalTokens;
    return typeof totalTokens === "number" && Number.isFinite(totalTokens) ? totalTokens : 0;
  }

  function formatTokenText(usage: unknown): string {
    return `Token ${getTotalTokens(usage)} / 费用 0`;
  }

  async function readChapterText(project: Project, chapter: Chapter): Promise<string> {
    return fs.readFile(path.join(project.rootPath, chapter.textPath), "utf8");
  }

  async function buildExtractionPrompt(job: P0JobRecord): Promise<string> {
    const book = requireBook(job.bookId);
    const project = await ensureProject(book.projectId);
    const templates = await resolveJobTemplates(job);
    const chapters = chaptersByBookId.get(book.id) ?? [];
    const chapterLimit = Math.min(job.input.extractionChapterCount, chapters.length);
    const selectedChapters = chapters.slice(0, chapterLimit);
    const chapterTexts = await Promise.all(
      selectedChapters.map(async (chapter) => {
        const text = await readChapterText(project, chapter);
        return [`## ${chapter.title}`, text.trim()].join("\n");
      })
    );

    return [
      `小说：${book.displayName}`,
      `模板：${templates.map((template) => template.name).join("、")}`,
      `单次窗口章节数：${job.input.singleRunChapterCount}`,
      `提取章节数：${job.input.extractionChapterCount}`,
      "",
      "请按以下模板要求提取信息，使用 Markdown 返回。",
      "",
      templates
        .map((template) => [`### ${template.name}`, template.body.trim()].join("\n"))
        .join("\n\n"),
      "",
      chapterTexts.join("\n\n")
    ].join("\n");
  }

  async function requestModelReport(job: P0JobRecord): Promise<ChatCompletionResult> {
    const registry = createProviderRegistry({
      presets: getProviderPresets(),
      providerConfigs: await providerStore.listProviderConfigs()
    });
    const { provider, modelId } = registry.resolveModelRef(
      `${job.input.providerConfigId}/${job.input.modelId}`
    );
    const client = new OpenAiCompatibleClient(provider, llmCredentialStore, {
      fetch: options.fetch
    });

    return client.chatCompletion({
      providerId: provider.id,
      modelId,
      messages: [
        {
          role: "system",
          content: "你是小说资料抽取助手，只返回可写入报告的 Markdown 内容。"
        },
        {
          role: "user",
          content: await buildExtractionPrompt(job)
        }
      ]
    });
  }

  async function getReportRedactionSecrets(job: P0JobRecord): Promise<string[]> {
    const providerConfig = (await providerStore.listProviderConfigs()).find(
      (config) => config.id === job.input.providerConfigId
    );
    const apiKey = providerConfig?.apiKeyRef ? credentialStore.readApiKey(providerConfig.apiKeyRef) : undefined;
    return apiKey ? [apiKey] : [];
  }

  async function writeModelReport(job: P0JobRecord, modelContent: string): Promise<ReportAsset> {
    const trimmedModelContent = modelContent.trim();
    if (!trimmedModelContent) {
      throw new Error("模型返回内容为空");
    }
    const safeModelContent = redactSecrets(trimmedModelContent, await getReportRedactionSecrets(job));

    const book = requireBook(job.bookId);
    const project = await ensureProject(book.projectId);
    const chapters = chaptersByBookId.get(book.id) ?? [];
    const reportsRoot = path.join(project.rootPath, "assets", "books", book.id, "reports");
    await fs.mkdir(reportsRoot, { recursive: true });
    const templates = await resolveJobTemplates(job);
    const firstTemplate = templates[0];
    const reportFileName =
      firstTemplate.id === PILL_TEMPLATE?.id
        ? DEFAULT_REPORT_FILE_NAME
        : toTemplateFileName(firstTemplate.name);

    const writer = createReportWriter({ reportsRoot });
    const reportContent = [
      `小说：${book.displayName}`,
      "",
      safeModelContent,
      "",
      `已读取章节：${chapters.map((chapter) => chapter.title).join("、")}`
    ].join("\n");

    const writeResult = writer.writeReport({
      path: reportFileName,
      title: toReportDisplayName(reportFileName),
      content: reportContent
    });
    const stat = await fs.stat(writeResult.path);
    const existingReport = [...reportsById.values()].find(
      (report) => report.bookId === book.id && report.fileName === reportFileName
    );
    const now = clock.now();
    const report: ReportAsset = {
      id: existingReport?.id ?? idGenerator.createId("report"),
      bookId: book.id,
      fileName: reportFileName,
      displayName: toReportDisplayName(reportFileName),
      relativePath: path.relative(project.rootPath, writeResult.path),
      byteSize: stat.size,
      createdAt: existingReport?.createdAt ?? now,
      updatedAt: now
    };

    reportsById.set(report.id, report);
    reportPathById.set(report.id, writeResult.path);
    return report;
  }

  async function runModelBackedJob(job: P0JobRecord): Promise<JobDto> {
    const book = requireBook(job.bookId);
    const runningJob = updateJob(job, {
      status: "running",
      progressText: `正在请求模型 0/${book.chapterCount} 章`,
      failureReason: undefined
    });

    try {
      const completion = await requestModelReport(runningJob);
      await writeModelReport(runningJob, completion.content);
      return toJobDto(
        updateJob(runningJob, {
          status: "completed",
          progressText: `已完成 ${book.chapterCount}/${book.chapterCount} 章`,
          tokenText: formatTokenText(completion.usage)
        })
      );
    } catch (error) {
      return toJobDto(
        updateJob(runningJob, {
          status: "failed",
          progressText: "任务失败",
          failureReason: getFailureReason(error)
        })
      );
    }
  }

  function updateJob(job: P0JobRecord, patch: Partial<P0JobRecord>): P0JobRecord {
    const nextJob = {
      ...job,
      ...patch,
      updatedAt: clock.now()
    };
    jobsById.set(nextJob.id, nextJob);
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
      return {
        bookId: upload.book.id,
        displayName: upload.book.displayName,
        sourceAssetId: upload.book.sourceAssetId,
        fileName: path.basename(input.filePath),
        byteSize: sourceStat.size,
        encoding: upload.encoding,
        chapterCount: upload.book.chapterCount
      };
    },
    "books:listReports": async (input) =>
      [...reportsById.values()]
        .filter((report) => report.bookId === input.bookId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map(toReportDto),
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
      const book = requireBook(input.bookId);
      const now = clock.now();
      const job: P0JobRecord = {
        id: idGenerator.createId("job"),
        bookId: book.id,
        status: "created",
        progressText: `窗口 0/${book.chapterCount}`,
        tokenText: "Token 0 / 费用 0",
        input,
        createdAt: now,
        updatedAt: now
      };
      jobsById.set(job.id, job);
      return toJobDto(job);
    },
    "jobs:start": async (input) => {
      const job = requireJob(input.jobId);
      return runModelBackedJob(job);
    },
    "jobs:pause": async (input) => {
      const job = requireJob(input.jobId);
      return toJobDto(updateJob(job, { status: "paused", progressText: "已暂停" }));
    },
    "jobs:resume": async (input) => {
      const job = requireJob(input.jobId);
      return runModelBackedJob(job);
    },
    "jobs:delete": async (input) => {
      if (!input.confirm) {
        throw new Error("Delete confirmation is required");
      }
      jobsById.delete(input.jobId);
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
