import { describe, expect, it } from "vitest";
import type { BookUploadResultDto, JobDto } from "../../../shared/ipcTypes";
import {
  buildCreateJobDto,
  createExtractionFormState,
  formatByteSize,
  mapJobDtoToExtractionJob
} from "./extractionViewModel";

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

const model = {
  id: "provider-1:model-a",
  providerConfigId: "provider-1",
  modelId: "model-a",
  displayName: "DeepSeek / 模型 A"
};

describe("extractionViewModel", () => {
  it("creates default form state from configured templates, books, models, and defaults", () => {
    const state = createExtractionFormState({
      books: [book],
      models: [model],
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
    expect(state.modelOptionId).toBe("provider-1:model-a");
    expect(state.templateIds).toEqual(["pill-analysis"]);
    expect(state.singleRunChapterCount).toBe(2);
    expect(state.extractionChapterCount).toBe(8);
    expect(state.overlapChapterCount).toBe(1);
    expect(state.skipAlreadyExtracted).toBe(true);
  });

  it("uses configured extraction parameter defaults when none are passed", () => {
    const state = createExtractionFormState({ books: [book], models: [model] });

    expect(state.singleRunChapterCount).toBe(3);
    expect(state.extractionChapterCount).toBe(9);
    expect(state.overlapChapterCount).toBe(1);
    expect(state.skipAlreadyExtracted).toBe(true);
  });

  it("builds a CreateJobDto with extraction window and ledger strategy parameters", () => {
    const dto = buildCreateJobDto(
      {
        bookId: "book-1",
        templateIds: ["pill-analysis"],
        modelOptionId: "provider-1:model-a",
        singleRunChapterCount: 4,
        extractionChapterCount: 12,
        overlapChapterCount: 0,
        skipAlreadyExtracted: false
      },
      { models: [model] }
    );

    expect(dto).toEqual({
      bookId: "book-1",
      templateIds: ["pill-analysis"],
      providerConfigId: "provider-1",
      modelId: "model-a",
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
        modelOptionId: "provider-1:model-a",
        singleRunChapterCount: 3,
        extractionChapterCount: 9,
        overlapChapterCount: 3,
        skipAlreadyExtracted: true
      },
      { models: [model] }
    );
    const shortExtractionDto = buildCreateJobDto(
      {
        bookId: "book-1",
        templateIds: ["pill-analysis"],
        modelOptionId: "provider-1:model-a",
        singleRunChapterCount: 5,
        extractionChapterCount: 3,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      },
      { models: [model] }
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
      progressText: "窗口 0/3",
      tokenText: "Token 0 / 费用 0",
      allowedActions: ["start", "delete"],
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:00:00.000Z"
    };

    expect(mapJobDtoToExtractionJob(job)).toMatchObject({
      id: "job-1",
      bookId: "book-1",
      status: "pending",
      progressText: "窗口 0/3",
      tokenText: "Token 0 / 费用 0"
    });
  });
});
