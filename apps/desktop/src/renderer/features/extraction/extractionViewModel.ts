import {
  getDefaultConfig,
  getExtractionParameterDefaults,
  type ExtractionParameterDefaults,
  type TaskAction,
  type TaskStatus
} from "@novel-extractor/config";
import { toTaskStatus } from "@novel-extractor/domain/job";
import type { BookUploadResultDto, CreateJobDto, JobDto } from "../../../shared/ipcTypes";
import {
  AUTO_PROVIDER_OPTION_ID,
  type ExtractionModelSelectionMode,
  type ExtractionProviderOption
} from "../providers/providerViewModel";
import { getDefaultTemplateViews, type TemplateView } from "../templates/templateViewModel";

export interface ExtractionBook {
  id: string;
  displayName: string;
  fileName: string;
  byteSize: number;
  encoding: BookUploadResultDto["encoding"];
  chapterCount: number;
  sourceAssetId?: string;
}

export interface ExtractionJobProgress {
  completedWindowCount: number;
  totalWindowCount: number;
  percent: number;
}

export interface ExtractionJobTiming {
  startedAt?: string;
  completedAt?: string;
  elapsedMs?: number;
  estimatedTotalMs?: number;
  estimatedRemainingMs?: number;
  estimateState: "unknown" | "calculating" | "available" | "frozen";
}

export interface ExtractionJobOutput {
  outputDirectoryLabel?: string;
  canOpenOutputDirectory: boolean;
}

export interface ExtractionJobInputSummary {
  bookDisplayName: string;
  templateNames: string[];
  modelId: string;
  modelSelectionMode?: "explicit" | "auto";
}

export interface ExtractionJob {
  id: string;
  bookId?: string;
  status: TaskStatus;
  progressText?: string;
  progress?: ExtractionJobProgress;
  timing?: ExtractionJobTiming;
  output?: ExtractionJobOutput;
  inputSummary?: ExtractionJobInputSummary;
  tokenText?: string;
  failureReason?: string;
  logFilePath?: string;
  createdAt?: string;
  autoRetryOnFailure?: boolean;
}

export interface ExtractionFormState {
  bookId: string;
  templateIds: string[];
  modelProviderOptionId: string;
  modelModelId: string;
  modelSelectionMode: ExtractionModelSelectionMode;
  singleRunChapterCount: number;
  extractionChapterCount: number;
  overlapChapterCount: number;
  templateBatchSize: number;
  skipAlreadyExtracted: boolean;
}

export interface ExtractionFormStateInput {
  books: readonly (ExtractionBook | BookUploadResultDto)[];
  providerOptions: readonly ExtractionProviderOption[];
  templates?: readonly TemplateView[];
  defaults?: ExtractionParameterDefaults;
  selectedTemplateIds?: readonly string[];
}

export interface BuildCreateJobDtoContext {
  providerOptions: readonly ExtractionProviderOption[];
}

type ProviderOption = Extract<ExtractionProviderOption, { kind: "provider" }>;
type FormModelSelection = Pick<
  ExtractionFormState,
  "modelProviderOptionId" | "modelModelId" | "modelSelectionMode"
>;

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

function isProviderOption(option: ExtractionProviderOption): option is ProviderOption {
  return option.kind === "provider";
}

function getProviderOptions(
  providerOptions: readonly ExtractionProviderOption[]
): ProviderOption[] {
  return providerOptions.filter(isProviderOption);
}

function createAutoModelSelection(
  providerOptions: readonly ExtractionProviderOption[]
): FormModelSelection {
  const firstProviderOption = getProviderOptions(providerOptions)[0];

  return {
    modelProviderOptionId: firstProviderOption ? AUTO_PROVIDER_OPTION_ID : "",
    modelModelId: firstProviderOption?.defaultModelId ?? "",
    modelSelectionMode: "auto"
  };
}

function reconcileModelSelection(
  state: ExtractionFormState,
  providerOptions: readonly ExtractionProviderOption[]
): FormModelSelection {
  const providerOnlyOptions = getProviderOptions(providerOptions);

  if (providerOnlyOptions.length === 0) {
    return {
      modelProviderOptionId: "",
      modelModelId: "",
      modelSelectionMode: "auto"
    };
  }

  if (state.modelSelectionMode === "explicit") {
    const selectedProvider = providerOnlyOptions.find(
      (providerOption) => providerOption.id === state.modelProviderOptionId
    );

    if (selectedProvider) {
      return {
        modelProviderOptionId: selectedProvider.id,
        modelModelId: selectedProvider.models.some((model) => model.id === state.modelModelId)
          ? state.modelModelId
          : selectedProvider.defaultModelId,
        modelSelectionMode: "explicit"
      };
    }
  }

  return createAutoModelSelection(providerOptions);
}

export function createExtractionFormState({
  books,
  providerOptions,
  templates = getDefaultTemplateViews(),
  defaults = getExtractionParameterDefaults(),
  selectedTemplateIds
}: ExtractionFormStateInput): ExtractionFormState {
  const modelSelection = createAutoModelSelection(providerOptions);
  const templateBatchSize =
    getDefaultConfig().extractionRuleDefaults.templateBatching.maxTemplatesPerCall;

  return {
    bookId: firstBookId(books),
    templateIds: getInitialTemplateIds(templates, selectedTemplateIds),
    ...modelSelection,
    singleRunChapterCount: defaults.singleRunChapterCount,
    extractionChapterCount: defaults.extractionChapterCount,
    overlapChapterCount: defaults.overlapChapterCount,
    templateBatchSize,
    skipAlreadyExtracted: true
  };
}

export function reconcileExtractionFormState(
  state: ExtractionFormState,
  {
    books,
    providerOptions,
    templates = getDefaultTemplateViews(),
    selectedTemplateIds
  }: ExtractionFormStateInput
): ExtractionFormState {
  const bookIds = new Set(books.map(getBookId));
  const modelSelection = reconcileModelSelection(state, providerOptions);
  const templateIds = new Set(getTemplateIds(templates));
  const nextTemplateIds = selectedTemplateIds
    ? selectedTemplateIds.filter((templateId) => templateIds.has(templateId))
    : state.templateIds.filter((templateId) => templateIds.has(templateId));

  return {
    ...state,
    bookId: bookIds.has(state.bookId) ? state.bookId : firstBookId(books),
    ...modelSelection,
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
  const providerOptions = getProviderOptions(context.providerOptions);
  const modelSelectionMode: ExtractionModelSelectionMode =
    state.modelSelectionMode === "explicit" ? "explicit" : "auto";
  const selectedProvider =
    modelSelectionMode === "auto"
      ? providerOptions[0]
      : providerOptions.find((providerOption) => providerOption.id === state.modelProviderOptionId);
  const selectedModelId =
    modelSelectionMode === "auto"
      ? selectedProvider?.defaultModelId
      : selectedProvider?.models.find((model) => model.id === state.modelModelId)?.id;

  if (!selectedProvider || !selectedModelId) {
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
  const templateBatchSize = toPositiveInteger(state.templateBatchSize);

  return {
    bookId: state.bookId,
    templateIds: state.templateIds,
    providerConfigId: selectedProvider.providerConfigId,
    modelId: selectedModelId,
    modelSelectionMode,
    singleRunChapterCount,
    extractionChapterCount,
    overlapChapterCount,
    templateBatchSize,
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

export function mapJobDtoToExtractionJob(job: JobDto): ExtractionJob | null {
  const status = toTaskStatus(job.status);

  if (status === null) {
    return null;
  }

  return {
    id: job.id,
    bookId: job.bookId,
    status,
    progressText: job.progressText,
    progress: job.progress,
    timing: job.timing,
    output: job.output,
    inputSummary: job.inputSummary,
    tokenText: job.tokenText,
    failureReason: job.failureReason,
    logFilePath: job.logFilePath,
    createdAt: job.createdAt,
    autoRetryOnFailure: job.autoRetryOnFailure
  };
}

function toSortableCreatedAt(job: ExtractionJob): number {
  if (!job.createdAt) {
    return Number.NEGATIVE_INFINITY;
  }

  const timestamp = Date.parse(job.createdAt);
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
}

export function sortExtractionJobsByCreatedAtDesc(
  jobs: readonly ExtractionJob[]
): ExtractionJob[] {
  return jobs
    .map((job, index) => ({ job, index }))
    .sort((left, right) => {
      const createdAtDifference = toSortableCreatedAt(right.job) - toSortableCreatedAt(left.job);
      return createdAtDifference || left.index - right.index;
    })
    .map(({ job }) => job);
}

export function getNextTaskStatusForAction(action: TaskAction): TaskStatus | null {
  switch (action) {
    case "start":
    case "resume":
    case "restart":
      return "running";
    case "pause":
      return "pause_requested";
    case "delete":
      return null;
    default:
      return null;
  }
}
