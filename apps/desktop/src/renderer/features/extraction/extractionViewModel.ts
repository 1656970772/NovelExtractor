import {
  getExtractionParameterDefaults,
  type ExtractionParameterDefaults,
  type TaskAction,
  type TaskStatus
} from "@novel-extractor/config";
import { toTaskStatus } from "@novel-extractor/domain/job";
import type { BookUploadResultDto, CreateJobDto, JobDto } from "../../../shared/ipcTypes";
import { getDefaultTemplateViews, type TemplateView } from "../templates/templateViewModel";

export interface ExtractionModel {
  id: string;
  providerConfigId: string;
  modelId: string;
  displayName: string;
}

export interface ExtractionBook {
  id: string;
  displayName: string;
  fileName: string;
  byteSize: number;
  encoding: BookUploadResultDto["encoding"];
  chapterCount: number;
  sourceAssetId?: string;
}

export interface ExtractionJob {
  id: string;
  bookId?: string;
  status: TaskStatus;
  progressText?: string;
  tokenText?: string;
  failureReason?: string;
  logs?: string[];
}

export interface ExtractionFormState {
  bookId: string;
  templateIds: string[];
  modelOptionId: string;
  singleRunChapterCount: number;
  extractionChapterCount: number;
  overlapChapterCount: number;
  skipAlreadyExtracted: boolean;
}

export interface ExtractionFormStateInput {
  books: readonly (ExtractionBook | BookUploadResultDto)[];
  models: readonly ExtractionModel[];
  templates?: readonly TemplateView[];
  defaults?: ExtractionParameterDefaults;
  selectedTemplateIds?: readonly string[];
}

export interface BuildCreateJobDtoContext {
  models: readonly ExtractionModel[];
}

function getBookId(book: ExtractionBook | BookUploadResultDto): string {
  return "bookId" in book ? book.bookId : book.id;
}

function getTemplateIds(templates: readonly TemplateView[]): string[] {
  return templates.map((template) => template.id);
}

function getInitialTemplateIds(
  templates: readonly TemplateView[],
  selectedTemplateIds?: readonly string[]
): string[] {
  const availableTemplateIds = new Set(getTemplateIds(templates));

  if (selectedTemplateIds) {
    return selectedTemplateIds.filter((templateId) => availableTemplateIds.has(templateId));
  }

  return getTemplateIds(templates);
}

function firstBookId(books: readonly (ExtractionBook | BookUploadResultDto)[]): string {
  return books[0] ? getBookId(books[0]) : "";
}

export function createExtractionFormState({
  books,
  models,
  templates = getDefaultTemplateViews(),
  defaults = getExtractionParameterDefaults(),
  selectedTemplateIds
}: ExtractionFormStateInput): ExtractionFormState {
  return {
    bookId: firstBookId(books),
    templateIds: getInitialTemplateIds(templates, selectedTemplateIds),
    modelOptionId: models[0]?.id ?? "",
    singleRunChapterCount: defaults.singleRunChapterCount,
    extractionChapterCount: defaults.extractionChapterCount,
    overlapChapterCount: defaults.overlapChapterCount,
    skipAlreadyExtracted: true
  };
}

export function reconcileExtractionFormState(
  state: ExtractionFormState,
  { books, models, templates = getDefaultTemplateViews(), selectedTemplateIds }: ExtractionFormStateInput
): ExtractionFormState {
  const bookIds = new Set(books.map(getBookId));
  const modelIds = new Set(models.map((model) => model.id));
  const templateIds = new Set(getTemplateIds(templates));
  const nextTemplateIds = selectedTemplateIds
    ? selectedTemplateIds.filter((templateId) => templateIds.has(templateId))
    : state.templateIds.filter((templateId) => templateIds.has(templateId));

  return {
    ...state,
    bookId: bookIds.has(state.bookId) ? state.bookId : firstBookId(books),
    modelOptionId: modelIds.has(state.modelOptionId) ? state.modelOptionId : models[0]?.id ?? "",
    templateIds: selectedTemplateIds
      ? nextTemplateIds
      : nextTemplateIds.length > 0
        ? nextTemplateIds
        : getTemplateIds(templates)
  };
}

function toPositiveInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : 1;
}

function toNonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function buildCreateJobDto(
  state: ExtractionFormState,
  context: BuildCreateJobDtoContext
): CreateJobDto {
  const selectedModel = context.models.find((model) => model.id === state.modelOptionId);

  if (!selectedModel) {
    throw new Error("请选择模型");
  }

  if (!state.bookId) {
    throw new Error("请先上传小说");
  }

  if (state.templateIds.length === 0) {
    throw new Error("请选择模板");
  }

  const singleRunChapterCount = toPositiveInteger(state.singleRunChapterCount);
  const extractionChapterCount = Math.max(
    singleRunChapterCount,
    toPositiveInteger(state.extractionChapterCount)
  );
  const overlapChapterCount = Math.min(
    singleRunChapterCount - 1,
    toNonNegativeInteger(state.overlapChapterCount)
  );

  return {
    bookId: state.bookId,
    templateIds: state.templateIds,
    providerConfigId: selectedModel.providerConfigId,
    modelId: selectedModel.modelId,
    singleRunChapterCount,
    extractionChapterCount,
    overlapChapterCount,
    skipAlreadyExtracted: state.skipAlreadyExtracted
  };
}

export function formatByteSize(byteSize: number): string {
  if (byteSize < 1024) {
    return `${byteSize} B`;
  }

  const kilobytes = byteSize / 1024;
  const rounded = Number.isInteger(kilobytes) ? kilobytes.toString() : kilobytes.toFixed(1);
  return `${rounded} KB`;
}

export function mapUploadResultToBook(result: BookUploadResultDto): ExtractionBook {
  return {
    id: result.bookId,
    displayName: result.displayName,
    fileName: result.fileName,
    byteSize: result.byteSize,
    encoding: result.encoding,
    chapterCount: result.chapterCount,
    sourceAssetId: result.sourceAssetId
  };
}

export function mapJobDtoToExtractionJob(
  job: JobDto,
  logs: readonly string[] = []
): ExtractionJob | null {
  const status = toTaskStatus(job.status);

  if (status === null) {
    return null;
  }

  return {
    id: job.id,
    bookId: job.bookId,
    status,
    progressText: job.progressText,
    tokenText: job.tokenText,
    failureReason: job.failureReason,
    logs: [...logs]
  };
}

export function getNextTaskStatusForAction(action: TaskAction): TaskStatus | null {
  switch (action) {
    case "start":
    case "resume":
      return "running";
    case "pause":
      return "paused";
    case "delete":
      return null;
    default:
      return null;
  }
}
