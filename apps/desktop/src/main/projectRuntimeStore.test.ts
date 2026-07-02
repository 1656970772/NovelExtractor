import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Book, Chapter, ReportAsset } from "@novel-extractor/domain";
import type { BookUploadResultDto } from "../shared/ipcTypes";
import { createFileProjectRuntimeStore, type ProjectRuntimeJobRecord } from "./projectRuntimeStore";

const fixedNow = "2026-07-02T11:30:00.000Z";

function createBookRecord(): { book: Book; chapters: Chapter[]; upload: BookUploadResultDto } {
  const book: Book = {
    id: "book-1",
    projectId: "project-a",
    displayName: "凡人修仙传",
    sourceAssetId: "source-1",
    sourceTextPath: "assets/books/book-1/source/original.txt",
    chapterCount: 2,
    createdAt: fixedNow
  };
  const chapters: Chapter[] = [
    {
      id: "chapter-1",
      bookId: "book-1",
      index: 1,
      title: "第一章 初入仙途",
      textPath: "assets/books/book-1/chapters/0001.txt"
    },
    {
      id: "chapter-2",
      bookId: "book-1",
      index: 2,
      title: "第二章 丹药",
      textPath: "assets/books/book-1/chapters/0002.txt"
    }
  ];
  const upload: BookUploadResultDto = {
    bookId: book.id,
    displayName: book.displayName,
    sourceAssetId: book.sourceAssetId,
    sourceTextPath: book.sourceTextPath,
    fileName: "凡人修仙传.txt",
    byteSize: 2048,
    encoding: "utf-8",
    chapterCount: book.chapterCount
  };
  return { book, chapters, upload };
}

function createRunningJob(): ProjectRuntimeJobRecord {
  return {
    id: "job-1",
    bookId: "book-1",
    status: "running",
    progressText: "进度：1/4",
    tokenText: "Token 100 / 缓存命中率 75.00%",
    logFilePath: "runs/job-1/logs/live.txt",
    createdAt: fixedNow,
    updatedAt: fixedNow,
    input: {
      bookId: "book-1",
      templateIds: ["pill-analysis"],
      providerConfigId: "provider-1",
      modelId: "mock-model",
      singleRunChapterCount: 3,
      extractionChapterCount: 9,
      overlapChapterCount: 1,
      skipAlreadyExtracted: true
    }
  };
}

describe("project runtime store", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-runtime-store-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it("persists uploaded books, chapters, jobs, and reports across store instances", async () => {
    const store = createFileProjectRuntimeStore({ projectRoot: tempRoot });
    const { book, chapters, upload } = createBookRecord();
    const job = createRunningJob();
    const report: ReportAsset = {
      id: "report-1",
      bookId: "book-1",
      fileName: "丹药分析.md",
      displayName: "丹药分析",
      reportKind: "template-output",
      relativePath: "assets/books/book-1/reports/丹药分析.md",
      byteSize: 128,
      createdAt: fixedNow,
      updatedAt: fixedNow
    };

    await store.saveUploadedBook({ book, chapters, upload });
    await store.saveJob(job);
    await store.saveReport({ report, path: path.join(tempRoot, report.relativePath) });

    const reopened = createFileProjectRuntimeStore({ projectRoot: tempRoot });
    const state = await reopened.load();

    expect(state.schemaVersion).toBe(1);
    expect(state.books).toEqual([{ book, upload }]);
    expect(state.chaptersByBookId).toEqual({ "book-1": chapters });
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]).toMatchObject({
      id: "job-1",
      status: "paused",
      progressText: "进度：1/4",
      tokenText: "Token 100 / 缓存命中率 75.00%"
    });
    expect(state.reports).toEqual([report]);
    expect(state.reportPathById).toEqual({
      "report-1": path.join(tempRoot, report.relativePath)
    });
  });

  it("returns an empty runtime state when the file is missing or corrupted", async () => {
    const missingStore = createFileProjectRuntimeStore({ projectRoot: tempRoot });
    await expect(missingStore.load()).resolves.toMatchObject({
      schemaVersion: 1,
      books: [],
      jobs: [],
      reports: []
    });

    const filePath = path.join(tempRoot, "state", "project-runtime.json");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "{not-json", "utf8");

    const corruptedStore = createFileProjectRuntimeStore({ projectRoot: tempRoot });
    await expect(corruptedStore.load()).resolves.toMatchObject({
      schemaVersion: 1,
      books: [],
      jobs: [],
      reports: []
    });
  });
});
