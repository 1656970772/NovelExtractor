import fs from "node:fs/promises";
import path from "node:path";
import { getDefaultConfig } from "@novel-extractor/config";
import type { Book, ReportAsset } from "@novel-extractor/domain";
import type { JobStatus } from "@novel-extractor/domain/job";
import type { BookUploadResultDto, CreateJobDto } from "../shared/ipcTypes";

export const PROJECT_RUNTIME_SCHEMA_VERSION = 1;

export interface ProjectRuntimeBookRecord {
  book: Book;
  upload: BookUploadResultDto;
}

export interface ProjectRuntimeJobProgressRecord {
  completedWindowCount: number;
  totalWindowCount: number;
  skippedWindowCount?: number;
  executedWindowCount?: number;
}

export interface ProjectRuntimeJobTimingRecord {
  startedAt?: string;
  completedAt?: string;
  tokenPlanWaitStartedAt?: string;
  tokenPlanWaitElapsedMs?: number;
  tokenPlanWaitFrozenElapsedMs?: number;
  initialWindowEstimateMs?: number;
  effectiveTotalWindowCount?: number;
  executedWindowElapsedMs?: number;
  estimateBaselineExecutedWindowCount?: number;
  estimateBaselineExecutedWindowElapsedMs?: number;
  estimatedTotalMs?: number;
  estimatedRemainingMs?: number;
  estimateFrozenAt?: string;
}

export interface ProjectRuntimeJobRecord {
  id: string;
  bookId: string;
  status: JobStatus;
  progressText: string;
  progress?: ProjectRuntimeJobProgressRecord;
  timing?: ProjectRuntimeJobTimingRecord;
  tokenText?: string;
  failureReason?: string;
  logFilePath?: string;
  input: CreateJobDto;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRuntimeState {
  schemaVersion: 1;
  books: ProjectRuntimeBookRecord[];
  jobs: ProjectRuntimeJobRecord[];
  reports: ReportAsset[];
  reportPathById: Record<string, string>;
}

export interface SaveProjectRuntimeReportInput {
  report: ReportAsset;
  path: string;
}

export interface ProjectRuntimeStore {
  load(): Promise<ProjectRuntimeState>;
  saveUploadedBook(input: {
    book: Book;
    upload: BookUploadResultDto;
  }): Promise<void>;
  saveJob(job: ProjectRuntimeJobRecord): Promise<void>;
  deleteJob(jobId: string): Promise<void>;
  saveReport(input: SaveProjectRuntimeReportInput): Promise<void>;
}

export interface FileProjectRuntimeStoreOptions {
  projectRoot: string;
  filePath?: string;
}

function createEmptyState(): ProjectRuntimeState {
  return {
    schemaVersion: PROJECT_RUNTIME_SCHEMA_VERSION,
    books: [],
    jobs: [],
    reports: [],
    reportPathById: {}
  };
}

function cloneBook(book: Book): Book {
  return { ...book };
}

function cloneUpload(upload: BookUploadResultDto): BookUploadResultDto {
  return { ...upload };
}

function cloneJob(job: ProjectRuntimeJobRecord): ProjectRuntimeJobRecord {
  return {
    ...job,
    progress: job.progress ? { ...job.progress } : undefined,
    timing: job.timing ? { ...job.timing } : undefined,
    input: {
      ...job.input,
      templateIds: [...job.input.templateIds]
    }
  };
}

function cloneReport(report: ReportAsset): ReportAsset {
  return { ...report };
}

function cloneState(state: ProjectRuntimeState): ProjectRuntimeState {
  return {
    schemaVersion: PROJECT_RUNTIME_SCHEMA_VERSION,
    books: state.books.map((record) => ({
      book: cloneBook(record.book),
      upload: cloneUpload(record.upload)
    })),
    jobs: state.jobs.map(cloneJob),
    reports: state.reports.map(cloneReport),
    reportPathById: { ...state.reportPathById }
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBook(value: unknown): value is Book {
  return (
    isPlainRecord(value) &&
    typeof value.id === "string" &&
    typeof value.projectId === "string" &&
    typeof value.displayName === "string" &&
    typeof value.sourceAssetId === "string" &&
    typeof value.sourceTextPath === "string" &&
    typeof value.chapterCount === "number" &&
    typeof value.createdAt === "string"
  );
}

function isUpload(value: unknown): value is BookUploadResultDto {
  return (
    isPlainRecord(value) &&
    typeof value.bookId === "string" &&
    typeof value.displayName === "string" &&
    typeof value.sourceAssetId === "string" &&
    typeof value.sourceTextPath === "string" &&
    typeof value.fileName === "string" &&
    typeof value.byteSize === "number" &&
    typeof value.encoding === "string" &&
    typeof value.chapterCount === "number"
  );
}

function isJobStatus(value: unknown): value is JobStatus {
  return (
    value === "created" ||
    value === "running" ||
    value === "pause_requested" ||
    value === "paused" ||
    value === "failed" ||
    value === "completed" ||
    value === "deleted"
  );
}

function isCreateJobDto(value: unknown): value is CreateJobDto {
  return (
    isPlainRecord(value) &&
    typeof value.bookId === "string" &&
    Array.isArray(value.templateIds) &&
    value.templateIds.every((templateId) => typeof templateId === "string") &&
    typeof value.providerConfigId === "string" &&
    typeof value.modelId === "string" &&
    typeof value.singleRunChapterCount === "number" &&
    typeof value.extractionChapterCount === "number" &&
    typeof value.overlapChapterCount === "number" &&
    (value.templateBatchSize === undefined || typeof value.templateBatchSize === "number") &&
    typeof value.skipAlreadyExtracted === "boolean"
  );
}

function isJobProgress(value: unknown): value is ProjectRuntimeJobProgressRecord {
  return (
    isPlainRecord(value) &&
    typeof value.completedWindowCount === "number" &&
    typeof value.totalWindowCount === "number" &&
    (value.skippedWindowCount === undefined || typeof value.skippedWindowCount === "number") &&
    (value.executedWindowCount === undefined || typeof value.executedWindowCount === "number")
  );
}

function isJobTiming(value: unknown): value is ProjectRuntimeJobTimingRecord {
  return (
    isPlainRecord(value) &&
    (value.startedAt === undefined || typeof value.startedAt === "string") &&
    (value.completedAt === undefined || typeof value.completedAt === "string") &&
    (value.tokenPlanWaitStartedAt === undefined || typeof value.tokenPlanWaitStartedAt === "string") &&
    (value.tokenPlanWaitElapsedMs === undefined || typeof value.tokenPlanWaitElapsedMs === "number") &&
    (value.tokenPlanWaitFrozenElapsedMs === undefined ||
      typeof value.tokenPlanWaitFrozenElapsedMs === "number") &&
    (value.initialWindowEstimateMs === undefined || typeof value.initialWindowEstimateMs === "number") &&
    (value.effectiveTotalWindowCount === undefined || typeof value.effectiveTotalWindowCount === "number") &&
    (value.executedWindowElapsedMs === undefined || typeof value.executedWindowElapsedMs === "number") &&
    (value.estimateBaselineExecutedWindowCount === undefined ||
      typeof value.estimateBaselineExecutedWindowCount === "number") &&
    (value.estimateBaselineExecutedWindowElapsedMs === undefined ||
      typeof value.estimateBaselineExecutedWindowElapsedMs === "number") &&
    (value.estimatedTotalMs === undefined || typeof value.estimatedTotalMs === "number") &&
    (value.estimatedRemainingMs === undefined || typeof value.estimatedRemainingMs === "number") &&
    (value.estimateFrozenAt === undefined || typeof value.estimateFrozenAt === "string")
  );
}

function isJob(value: unknown): value is ProjectRuntimeJobRecord {
  return (
    isPlainRecord(value) &&
    typeof value.id === "string" &&
    typeof value.bookId === "string" &&
    isJobStatus(value.status) &&
    typeof value.progressText === "string" &&
    (value.progress === undefined || isJobProgress(value.progress)) &&
    (value.timing === undefined || isJobTiming(value.timing)) &&
    isCreateJobDto(value.input) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isReport(value: unknown): value is ReportAsset {
  return (
    isPlainRecord(value) &&
    typeof value.id === "string" &&
    typeof value.bookId === "string" &&
    typeof value.fileName === "string" &&
    typeof value.displayName === "string" &&
    typeof value.relativePath === "string" &&
    typeof value.byteSize === "number" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function normalizeInterruptedJob(job: ProjectRuntimeJobRecord): ProjectRuntimeJobRecord {
  const input = normalizeJobInput(job.input);
  const baseJob =
    input === job.input
      ? job
      : {
          ...job,
          input
        };

  if (baseJob.status !== "running" && baseJob.status !== "pause_requested") {
    return baseJob;
  }

  return {
    ...baseJob,
    status: "paused",
    failureReason: undefined
  };
}

function normalizeJobInput(input: CreateJobDto): CreateJobDto {
  const modelSelectionMode =
    input.modelSelectionMode === "auto" || input.modelSelectionMode === "explicit"
      ? input.modelSelectionMode
      : "explicit";
  const autoRetryOnFailure =
    typeof input.autoRetryOnFailure === "boolean" ? input.autoRetryOnFailure : false;
  const defaultTemplateBatchSize =
    getDefaultConfig().extractionRuleDefaults.templateBatching.maxTemplatesPerCall;
  const templateBatchSize =
    Number.isSafeInteger(input.templateBatchSize) && input.templateBatchSize > 0
      ? input.templateBatchSize
      : defaultTemplateBatchSize;

  if (
    modelSelectionMode === input.modelSelectionMode &&
    autoRetryOnFailure === input.autoRetryOnFailure &&
    templateBatchSize === input.templateBatchSize
  ) {
    return input;
  }

  return {
    ...input,
    modelSelectionMode,
    autoRetryOnFailure,
    templateBatchSize
  };
}

function normalizeState(value: unknown): { changed: boolean; state: ProjectRuntimeState } {
  if (!isPlainRecord(value)) {
    return { changed: false, state: createEmptyState() };
  }

  const books = Array.isArray(value.books)
    ? value.books.filter(
        (record): record is ProjectRuntimeBookRecord =>
          isPlainRecord(record) && isBook(record.book) && isUpload(record.upload)
      )
    : [];
  const sourceJobs = Array.isArray(value.jobs) ? value.jobs.filter(isJob) : [];
  const jobs = sourceJobs.map(normalizeInterruptedJob);
  const reports = Array.isArray(value.reports) ? value.reports.filter(isReport) : [];
  const reportPathById = isPlainRecord(value.reportPathById)
    ? Object.fromEntries(
        Object.entries(value.reportPathById).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string"
        )
      )
    : {};

  return {
    changed:
      value.schemaVersion !== PROJECT_RUNTIME_SCHEMA_VERSION ||
      jobs.some((job, index) => {
        const sourceJob = sourceJobs[index];
        return (
          job.status !== sourceJob?.status ||
          job.input.modelSelectionMode !== sourceJob.input.modelSelectionMode ||
          job.input.autoRetryOnFailure !== sourceJob.input.autoRetryOnFailure ||
          job.input.templateBatchSize !== sourceJob.input.templateBatchSize
        );
      }) ||
      Object.prototype.hasOwnProperty.call(value, "chaptersByBookId"),
    state: {
      schemaVersion: PROJECT_RUNTIME_SCHEMA_VERSION,
      books: books.map((record) => ({
        book: cloneBook(record.book),
        upload: cloneUpload(record.upload)
      })),
      jobs,
      reports: reports.map(cloneReport),
      reportPathById
    }
  };
}

export function createFileProjectRuntimeStore(
  options: FileProjectRuntimeStoreOptions
): ProjectRuntimeStore {
  const filePath = options.filePath ?? path.join(options.projectRoot, "state", "project-runtime.json");
  let statePromise: Promise<ProjectRuntimeState> | null = null;

  async function saveState(state: ProjectRuntimeState): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(cloneState(state), null, 2)}\n`, "utf8");
  }

  async function loadState(): Promise<ProjectRuntimeState> {
    if (statePromise) {
      return statePromise;
    }

    statePromise = (async () => {
      let raw = "";
      try {
        raw = await fs.readFile(filePath, "utf8");
      } catch {
        return createEmptyState();
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return createEmptyState();
      }

      const normalized = normalizeState(parsed);
      if (normalized.changed) {
        try {
          await saveState(normalized.state);
        } catch {
          // The in-memory recovery is still useful even if the best-effort rewrite fails.
        }
      }
      return normalized.state;
    })();

    return statePromise;
  }

  async function mutate(mutator: (state: ProjectRuntimeState) => void): Promise<void> {
    const state = await loadState();
    mutator(state);
    await saveState(state);
  }

  return {
    async load() {
      return cloneState(await loadState());
    },

    async saveUploadedBook(input) {
      await mutate((state) => {
        state.books = [
          ...state.books.filter((record) => record.book.id !== input.book.id),
          {
            book: cloneBook(input.book),
            upload: cloneUpload(input.upload)
          }
        ];
      });
    },

    async saveJob(job) {
      await mutate((state) => {
        const nextJob = cloneJob(job);
        state.jobs = [
          ...state.jobs.filter((currentJob) => currentJob.id !== nextJob.id),
          nextJob
        ];
      });
    },

    async deleteJob(jobId) {
      await mutate((state) => {
        state.jobs = state.jobs.filter((job) => job.id !== jobId);
      });
    },

    async saveReport(input) {
      await mutate((state) => {
        const nextReport = cloneReport(input.report);
        state.reports = [
          ...state.reports.filter((report) => report.id !== nextReport.id),
          nextReport
        ];
        state.reportPathById[nextReport.id] = input.path;
      });
    }
  };
}
