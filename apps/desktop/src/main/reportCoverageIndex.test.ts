import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadReportCoverageIndex } from "./reportCoverageIndex";

const coverageTarget = {
  bookId: "book-1",
  templateId: "template-1",
  outputFileName: "人物关系.md",
  templateHash: "template-hash",
  windowHash: "window-hash",
  rulesSemanticHash: "rules-hash",
  submittedChapterRange: "1-2"
};

describe("report coverage index", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-coverage-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it("treats a missing index as empty", async () => {
    const index = await loadReportCoverageIndex({
      projectRoot: tempRoot,
      relativePath: "metadata/coverage/coverage-index.json",
      corruptionStrategy: "fail"
    });

    expect(index.isCovered(coverageTarget)).toBe(false);
  });

  it("persists coverage records and matches all key fields", async () => {
    const index = await loadReportCoverageIndex({
      projectRoot: tempRoot,
      relativePath: "metadata/coverage/coverage-index.json",
      corruptionStrategy: "fail"
    });

    index.recordCovered({
      ...coverageTarget,
      status: "written",
      updatedAt: "2026-06-30T00:00:00.000Z"
    });
    await index.save();

    const reloaded = await loadReportCoverageIndex({
      projectRoot: tempRoot,
      relativePath: "metadata/coverage/coverage-index.json",
      corruptionStrategy: "fail"
    });
    expect(reloaded.isCovered(coverageTarget)).toBe(true);
    expect(
      reloaded.isCovered({
        ...coverageTarget,
        windowHash: "changed-window-hash"
      })
    ).toBe(false);
  });

  it("merges records saved by concurrent stores for the same index path", async () => {
    const firstStore = await loadReportCoverageIndex({
      projectRoot: tempRoot,
      relativePath: "metadata/coverage/coverage-index.json",
      corruptionStrategy: "fail"
    });
    const secondStore = await loadReportCoverageIndex({
      projectRoot: tempRoot,
      relativePath: "metadata/coverage/coverage-index.json",
      corruptionStrategy: "fail"
    });
    const secondTarget = {
      ...coverageTarget,
      bookId: "book-2",
      windowHash: "window-hash-2"
    };

    firstStore.recordCovered({
      ...coverageTarget,
      status: "written",
      updatedAt: "2026-06-30T00:00:00.000Z"
    });
    secondStore.recordCovered({
      ...secondTarget,
      status: "no_update",
      updatedAt: "2026-06-30T00:01:00.000Z"
    });

    await firstStore.save();
    await secondStore.save();

    const reloaded = await loadReportCoverageIndex({
      projectRoot: tempRoot,
      relativePath: "metadata/coverage/coverage-index.json",
      corruptionStrategy: "fail"
    });

    expect(reloaded.isCovered(coverageTarget)).toBe(true);
    expect(reloaded.isCovered(secondTarget)).toBe(true);
    expect(reloaded.records()).toHaveLength(2);
  });

  it("fails closed when the index is damaged and the corruption strategy is fail", async () => {
    const coveragePath = path.join(tempRoot, "metadata", "coverage", "coverage-index.json");
    await fs.mkdir(path.dirname(coveragePath), { recursive: true });
    await fs.writeFile(coveragePath, "{ damaged", "utf8");

    await expect(
      loadReportCoverageIndex({
        projectRoot: tempRoot,
        relativePath: "metadata/coverage/coverage-index.json",
        corruptionStrategy: "fail"
      })
    ).rejects.toThrow(/coverage index is damaged/i);
  });

  it("rebuilds a damaged index on save when conservative rerun is configured", async () => {
    const coveragePath = path.join(tempRoot, "metadata", "coverage", "coverage-index.json");
    await fs.mkdir(path.dirname(coveragePath), { recursive: true });
    await fs.writeFile(coveragePath, "{ damaged", "utf8");

    const index = await loadReportCoverageIndex({
      projectRoot: tempRoot,
      relativePath: "metadata/coverage/coverage-index.json",
      corruptionStrategy: "conservative-rerun"
    });

    index.recordCovered({
      ...coverageTarget,
      status: "written",
      updatedAt: "2026-06-30T00:00:00.000Z"
    });
    await expect(index.save()).resolves.toBeUndefined();

    const reloaded = await loadReportCoverageIndex({
      projectRoot: tempRoot,
      relativePath: "metadata/coverage/coverage-index.json",
      corruptionStrategy: "fail"
    });
    expect(reloaded.isCovered(coverageTarget)).toBe(true);
    expect(reloaded.records()).toHaveLength(1);
  });
});
