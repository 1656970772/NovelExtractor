import { describe, expect, it } from "vitest";
import type { BookUploadResultDto, JobDto } from "../../../shared/ipcTypes";
import {
  buildCreateJobDto,
  createExtractionFormState,
  formatByteSize,
  mapJobDtoToExtractionJob,
  reconcileExtractionFormState,
  sortExtractionJobsByCreatedAtDesc
} from "./extractionViewModel";
import {
  AUTO_PROVIDER_OPTION_ID,
  type ExtractionProviderOption
} from "../providers/providerViewModel";

const book: BookUploadResultDto = {
  bookId: "book-1",
  displayName: "凡人修仙传",
  sourceAssetId: "asset-1",
  sourceTextPath: "assets/books/book-1/source/original.txt",
  fileName: "凡人修仙传.txt",
  byteSize: 2048,
  encoding: "utf-8",
  chapterCount: 3
};

const autoProviderOption: ExtractionProviderOption = {
  id: AUTO_PROVIDER_OPTION_ID,
  kind: "auto",
  displayName: "自动",
  models: []
};

const deepSeekProviderOption: ExtractionProviderOption = {
  id: "provider-1",
  kind: "provider",
  displayName: "DeepSeek",
  providerConfigId: "provider-1",
  defaultModelId: "model-a",
  models: [
    { id: "model-a", displayName: "模型 A", isDefault: true },
    { id: "model-b", displayName: "模型 B", isDefault: false }
  ]
};

const providerOptions: ExtractionProviderOption[] = [
  autoProviderOption,
  deepSeekProviderOption
];

describe("extractionViewModel", () => {
  it("creates default form state from configured templates, books, models, and defaults", () => {
    const state = createExtractionFormState({
      books: [book],
      providerOptions,
      templates: [
        {
          id: "pill-analysis",
          scope: "global",
          name: "丹药分析模板",
          fileName: "丹药分析.md",
          body: "提取丹药信息。",
          createdAt: "2026-06-27T00:00:00.000Z",
          updatedAt: "2026-06-27T00:00:00.000Z"
        }
      ],
      defaults: {
        singleRunChapterCount: 2,
        extractionChapterCount: 8,
        overlapChapterCount: 1
      }
    });

    expect(state.bookId).toBe("book-1");
    expect(state.modelProviderOptionId).toBe(AUTO_PROVIDER_OPTION_ID);
    expect(state.modelModelId).toBe("model-a");
    expect(state.modelSelectionMode).toBe("auto");
    expect(state.templateIds).toEqual(["pill-analysis"]);
    expect(state.singleRunChapterCount).toBe(2);
    expect(state.extractionChapterCount).toBe(8);
    expect(state.overlapChapterCount).toBe(1);
    expect(state.skipAlreadyExtracted).toBe(true);
  });

  it("uses configured extraction parameter defaults when none are passed", () => {
    const state = createExtractionFormState({ books: [book], providerOptions });

    expect(state.singleRunChapterCount).toBe(3);
    expect(state.extractionChapterCount).toBe(9);
    expect(state.overlapChapterCount).toBe(1);
    expect(state.skipAlreadyExtracted).toBe(true);
  });

  it("keeps explicit provider and repairs unavailable child models during reconcile", () => {
    const state = createExtractionFormState({ books: [book], providerOptions });
    const explicitState = {
      ...state,
      modelProviderOptionId: "provider-1",
      modelModelId: "model-b",
      modelSelectionMode: "explicit" as const
    };

    const kept = reconcileExtractionFormState(explicitState, {
      books: [book],
      providerOptions
    });

    expect(kept.modelProviderOptionId).toBe("provider-1");
    expect(kept.modelModelId).toBe("model-b");
    expect(kept.modelSelectionMode).toBe("explicit");

    const repaired = reconcileExtractionFormState(explicitState, {
      books: [book],
      providerOptions: [
        autoProviderOption,
        {
          ...deepSeekProviderOption,
          models: [{ id: "model-a", displayName: "模型 A", isDefault: true }]
        }
      ]
    });

    expect(repaired.modelProviderOptionId).toBe("provider-1");
    expect(repaired.modelModelId).toBe("model-a");
    expect(repaired.modelSelectionMode).toBe("explicit");
  });

  it("falls back to auto selection when an explicit provider is no longer available", () => {
    const state = createExtractionFormState({ books: [book], providerOptions });

    const reconciled = reconcileExtractionFormState(
      {
        ...state,
        modelProviderOptionId: "missing-provider",
        modelModelId: "missing-model",
        modelSelectionMode: "explicit"
      },
      { books: [book], providerOptions }
    );

    expect(reconciled.modelProviderOptionId).toBe(AUTO_PROVIDER_OPTION_ID);
    expect(reconciled.modelModelId).toBe("model-a");
    expect(reconciled.modelSelectionMode).toBe("auto");
  });

  it("builds an auto CreateJobDto with the first provider default model", () => {
    const dto = buildCreateJobDto(
      {
        bookId: "book-1",
        templateIds: ["pill-analysis"],
        modelProviderOptionId: AUTO_PROVIDER_OPTION_ID,
        modelModelId: "model-a",
        modelSelectionMode: "auto",
        singleRunChapterCount: 4,
        extractionChapterCount: 12,
        overlapChapterCount: 0,
        skipAlreadyExtracted: false
      },
      { providerOptions }
    );

    expect(dto).toEqual({
      bookId: "book-1",
      templateIds: ["pill-analysis"],
      providerConfigId: "provider-1",
      modelId: "model-a",
      modelSelectionMode: "auto",
      singleRunChapterCount: 4,
      extractionChapterCount: 12,
      overlapChapterCount: 0,
      skipAlreadyExtracted: false
    });
  });

  it("builds an explicit CreateJobDto with extraction window and ledger strategy parameters", () => {
    const dto = buildCreateJobDto(
      {
        bookId: "book-1",
        templateIds: ["pill-analysis"],
        modelProviderOptionId: "provider-1",
        modelModelId: "model-b",
        modelSelectionMode: "explicit",
        singleRunChapterCount: 4,
        extractionChapterCount: 12,
        overlapChapterCount: 0,
        skipAlreadyExtracted: false
      },
      { providerOptions }
    );

    expect(dto).toEqual({
      bookId: "book-1",
      templateIds: ["pill-analysis"],
      providerConfigId: "provider-1",
      modelId: "model-b",
      modelSelectionMode: "explicit",
      singleRunChapterCount: 4,
      extractionChapterCount: 12,
      overlapChapterCount: 0,
      skipAlreadyExtracted: false
    });
  });

  it("normalizes cross-field extraction parameters when building a CreateJobDto", () => {
    const equalOverlapDto = buildCreateJobDto(
      {
        bookId: "book-1",
        templateIds: ["pill-analysis"],
        modelProviderOptionId: AUTO_PROVIDER_OPTION_ID,
        modelModelId: "model-a",
        modelSelectionMode: "auto",
        singleRunChapterCount: 3,
        extractionChapterCount: 9,
        overlapChapterCount: 3,
        skipAlreadyExtracted: true
      },
      { providerOptions }
    );
    const shortExtractionDto = buildCreateJobDto(
      {
        bookId: "book-1",
        templateIds: ["pill-analysis"],
        modelProviderOptionId: AUTO_PROVIDER_OPTION_ID,
        modelModelId: "model-a",
        modelSelectionMode: "auto",
        singleRunChapterCount: 5,
        extractionChapterCount: 3,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      },
      { providerOptions }
    );

    expect(equalOverlapDto.overlapChapterCount).toBe(2);
    expect(shortExtractionDto.extractionChapterCount).toBe(5);
  });

  it("formats uploaded byte size for compact metadata rows", () => {
    expect(formatByteSize(2048)).toBe("2 KB");
    expect(formatByteSize(1536)).toBe("1.5 KB");
  });

  it("maps domain job status to configured task status for the UI", () => {
    const job: JobDto = {
      id: "job-1",
      bookId: "book-1",
      status: "created",
      progressText: "进度：0/3",
      progress: {
        completedWindowCount: 0,
        totalWindowCount: 3,
        percent: 0
      },
      timing: {
        startedAt: "2026-06-27T00:00:00.000Z",
        elapsedMs: 1200,
        estimatedTotalMs: 3600,
        estimateState: "available"
      },
      output: {
        outputDirectoryLabel: "凡人修仙传",
        canOpenOutputDirectory: false
      },
      inputSummary: {
        bookDisplayName: "凡人修仙传",
        templateNames: ["丹药分析模板"],
        modelId: "mock-model"
      },
      tokenText: "Token 0 / 缓存命中率 0.00%",
      logFilePath: "runs/job-1/logs/20260630-153012.txt",
      allowedActions: ["start", "delete"],
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:00:00.000Z"
    };

    expect(mapJobDtoToExtractionJob(job)).toMatchObject({
      id: "job-1",
      bookId: "book-1",
      status: "pending",
      progressText: "进度：0/3",
      progress: {
        completedWindowCount: 0,
        totalWindowCount: 3,
        percent: 0
      },
      timing: {
        startedAt: "2026-06-27T00:00:00.000Z",
        elapsedMs: 1200,
        estimatedTotalMs: 3600,
        estimateState: "available"
      },
      output: {
        outputDirectoryLabel: "凡人修仙传",
        canOpenOutputDirectory: false
      },
      inputSummary: {
        bookDisplayName: "凡人修仙传",
        templateNames: ["丹药分析模板"],
        modelId: "mock-model"
      },
      tokenText: "Token 0 / 缓存命中率 0.00%",
      logFilePath: "runs/job-1/logs/20260630-153012.txt",
      createdAt: "2026-06-27T00:00:00.000Z"
    });
  });

  it("sorts extraction jobs by creation time with undated jobs kept last", () => {
    const sortedJobs = sortExtractionJobsByCreatedAtDesc([
      { id: "undated-a", status: "pending" },
      { id: "old", status: "completed", createdAt: "2026-06-27T09:00:00.000Z" },
      { id: "new", status: "failed", createdAt: "2026-07-02T09:00:00.000Z" },
      { id: "undated-b", status: "running" },
      { id: "middle", status: "running", createdAt: "2026-06-30T09:00:00.000Z" }
    ]);

    expect(sortedJobs.map((job) => job.id)).toEqual([
      "new",
      "middle",
      "old",
      "undated-a",
      "undated-b"
    ]);
  });
});
