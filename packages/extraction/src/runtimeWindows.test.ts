import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateRuntimeWindows, RuntimeWindowGenerationError } from "./runtimeWindows";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { force: true, recursive: true })));
  tempRoots.length = 0;
});

describe("generateRuntimeWindows", () => {
  it("writes CLI-aligned runtime windows and a manifest for an 81 chapter source", async () => {
    const projectRoot = await createTempProject();
    const sourceTextPath = await writeSource(projectRoot, "books/source.txt", buildChapters(81));

    const result = await generateRuntimeWindows({
      projectRoot,
      jobId: "job-81",
      bookId: "book-a",
      sourceTextPath,
      singleRunChapterCount: 5,
      overlapChapterCount: 1,
      extractionChapterCount: 81,
      generatedAt: "2026-06-30T00:00:00.000Z"
    });

    expect(result.windowsRoot).toBe(path.join(projectRoot, "runs", "job-81", "windows"));
    expect(result.manifestPath).toBe(path.join(result.windowsRoot, "manifest.json"));
    expect(result.manifest).toMatchObject({
      jobId: "job-81",
      bookId: "book-a",
      sourceTextPath: "books/source.txt",
      splitterVersion: "ts-window-planner-v1",
      generatedAt: "2026-06-30T00:00:00.000Z",
      totalDetectedChapterCount: 81
    });
    expect(result.manifest.windows).toHaveLength(20);
    expect(result.manifest.windows[0]).toMatchObject({
      windowId: "1-5",
      index: 0,
      fileName: "window-0001.txt",
      textPath: "runs/job-81/windows/window-0001.txt",
      contextChapterRange: "1-5",
      submittedChapterRange: "1-5",
      contextChapterTitles: ["第1章 标题1", "第2章 标题2", "第3章 标题3", "第4章 标题4", "第5章 标题5"],
      submittedChapterTitles: ["第1章 标题1", "第2章 标题2", "第3章 标题3", "第4章 标题4", "第5章 标题5"]
    });
    expect(result.manifest.windows[1]).toMatchObject({
      windowId: "5-9",
      contextChapterRange: "5-9",
      submittedChapterRange: "6-9",
      contextChapterTitles: ["第5章 标题5", "第6章 标题6", "第7章 标题7", "第8章 标题8", "第9章 标题9"],
      submittedChapterTitles: ["第6章 标题6", "第7章 标题7", "第8章 标题8", "第9章 标题9"]
    });
    expect(result.manifest.windows[19]).toMatchObject({
      windowId: "77-81",
      contextChapterRange: "77-81",
      submittedChapterRange: "78-81"
    });

    const firstWindowText = await readFile(path.join(projectRoot, result.manifest.windows[0].textPath), "utf8");
    expect(firstWindowText).toContain("# 第1章 标题1\n\n正文 1");
    expect(firstWindowText).toContain("# 第5章 标题5\n\n正文 5");
    expect(firstWindowText).not.toContain("# 第6章 标题6");
    expect(result.manifest.windows[0].characterCount).toBe(firstWindowText.length);
    expect(result.manifest.windows[0].windowHash).toMatch(/^[a-f0-9]{64}$/);

    const persistedManifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    expect(persistedManifest).toEqual(result.manifest);
    expect(JSON.stringify(persistedManifest)).not.toContain("正文 1");
  });

  it("reuses existing windows when source, split config, and splitter version hashes match", async () => {
    const projectRoot = await createTempProject();
    await writeSource(projectRoot, "books/source.txt", buildChapters(6));
    const input = {
      projectRoot,
      jobId: "job-reuse",
      bookId: "book-a",
      sourceTextPath: "books/source.txt",
      singleRunChapterCount: 3,
      overlapChapterCount: 1,
      extractionChapterCount: 6,
      generatedAt: "2026-06-30T00:00:00.000Z"
    };

    const first = await generateRuntimeWindows(input);
    const firstWindowPath = path.join(projectRoot, first.manifest.windows[0].textPath);
    const oldTime = new Date("2000-01-01T00:00:00.000Z");
    await utimes(firstWindowPath, oldTime, oldTime);

    const second = await generateRuntimeWindows({
      ...input,
      generatedAt: "2099-01-01T00:00:00.000Z"
    });
    const reusedWindowStat = await stat(firstWindowPath);

    expect(second.manifestPath).toBe(first.manifestPath);
    expect(second.windowsRoot).toBe(first.windowsRoot);
    expect(second.manifest).toEqual(first.manifest);
    expect(reusedWindowStat.mtime.getUTCFullYear()).toBe(2000);
  });

  it("rebuilds instead of reusing a manifest when job, book, or source identity does not match", async () => {
    const projectRoot = await createTempProject();
    await writeSource(projectRoot, "books/source.txt", buildChapters(6));
    const input = {
      projectRoot,
      jobId: "job-identity",
      bookId: "book-a",
      sourceTextPath: "books/source.txt",
      singleRunChapterCount: 3,
      overlapChapterCount: 1,
      extractionChapterCount: 6,
      generatedAt: "2026-06-30T00:00:00.000Z"
    };

    const first = await generateRuntimeWindows(input);
    await writeFile(
      first.manifestPath,
      `${JSON.stringify(
        {
          ...first.manifest,
          jobId: "job-old",
          bookId: "book-old",
          sourceTextPath: "books/old-source.txt"
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const rebuilt = await generateRuntimeWindows({
      ...input,
      generatedAt: "2026-06-30T00:01:00.000Z"
    });

    expect(rebuilt.manifest).toMatchObject({
      jobId: "job-identity",
      bookId: "book-a",
      sourceTextPath: "books/source.txt",
      generatedAt: "2026-06-30T00:01:00.000Z"
    });
  });

  it("rebuilds instead of reusing a manifest when a listed window file is missing", async () => {
    const projectRoot = await createTempProject();
    await writeSource(projectRoot, "books/source.txt", buildChapters(6));
    const input = {
      projectRoot,
      jobId: "job-missing-window",
      bookId: "book-a",
      sourceTextPath: "books/source.txt",
      singleRunChapterCount: 3,
      overlapChapterCount: 1,
      extractionChapterCount: 6,
      generatedAt: "2026-06-30T00:00:00.000Z"
    };

    const first = await generateRuntimeWindows(input);
    const firstWindowPath = path.join(projectRoot, first.manifest.windows[0].textPath);
    await rm(firstWindowPath, { force: true });

    const rebuilt = await generateRuntimeWindows({
      ...input,
      generatedAt: "2026-06-30T00:01:00.000Z"
    });

    const restoredText = await readFile(firstWindowPath, "utf8");
    expect(restoredText).toContain("# 第1章 标题1");
    expect(rebuilt.manifest.generatedAt).toBe("2026-06-30T00:01:00.000Z");
  });

  it("rebuilds instead of reusing a manifest when a listed window file hash changed", async () => {
    const projectRoot = await createTempProject();
    await writeSource(projectRoot, "books/source.txt", buildChapters(6));
    const input = {
      projectRoot,
      jobId: "job-tampered-window",
      bookId: "book-a",
      sourceTextPath: "books/source.txt",
      singleRunChapterCount: 3,
      overlapChapterCount: 1,
      extractionChapterCount: 6,
      generatedAt: "2026-06-30T00:00:00.000Z"
    };

    const first = await generateRuntimeWindows(input);
    const firstWindowPath = path.join(projectRoot, first.manifest.windows[0].textPath);
    await writeFile(firstWindowPath, "tampered window text", "utf8");

    const rebuilt = await generateRuntimeWindows({
      ...input,
      generatedAt: "2026-06-30T00:01:00.000Z"
    });
    const rebuiltText = await readFile(firstWindowPath, "utf8");

    expect(rebuiltText).not.toContain("tampered window text");
    expect(sha256(rebuiltText)).toBe(rebuilt.manifest.windows[0].windowHash);
  });

  it("rebuilds the job windows directory when source or split config changes", async () => {
    const projectRoot = await createTempProject();
    const sourceTextPath = await writeSource(projectRoot, "books/source.txt", buildChapters(6));

    const first = await generateRuntimeWindows({
      projectRoot,
      jobId: "job-rebuild",
      bookId: "book-a",
      sourceTextPath,
      singleRunChapterCount: 3,
      overlapChapterCount: 1,
      extractionChapterCount: 6,
      generatedAt: "2026-06-30T00:00:00.000Z"
    });
    const stalePath = path.join(first.windowsRoot, "window-9999.txt");
    await writeFile(stalePath, "stale", "utf8");

    await writeFile(sourceTextPath, `${buildChapters(7)}\n`, "utf8");
    const rebuilt = await generateRuntimeWindows({
      projectRoot,
      jobId: "job-rebuild",
      bookId: "book-a",
      sourceTextPath,
      singleRunChapterCount: 4,
      overlapChapterCount: 1,
      extractionChapterCount: 7,
      generatedAt: "2026-06-30T00:01:00.000Z"
    });

    await expect(stat(stalePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(rebuilt.manifest.sourceTextHash).not.toBe(first.manifest.sourceTextHash);
    expect(rebuilt.manifest.splitConfigHash).not.toBe(first.manifest.splitConfigHash);
    expect(rebuilt.manifest.windows.map((window) => window.fileName)).toEqual(["window-0001.txt", "window-0002.txt"]);
  });

  it("throws typed errors for invalid parameters and sources without chapters", async () => {
    const projectRoot = await createTempProject();
    const sourceTextPath = await writeSource(projectRoot, "books/source.txt", "只有正文，没有章节标题");

    await expect(
      generateRuntimeWindows({
        projectRoot,
        jobId: "job-invalid",
        bookId: "book-a",
        sourceTextPath,
        singleRunChapterCount: 0,
        overlapChapterCount: 0,
        extractionChapterCount: 1
      })
    ).rejects.toMatchObject({
      name: "RuntimeWindowGenerationError",
      code: "INVALID_INPUT"
    });

    await expect(
      generateRuntimeWindows({
        projectRoot,
        jobId: "job-empty",
        bookId: "book-a",
        sourceTextPath,
        singleRunChapterCount: 2,
        overlapChapterCount: 0,
        extractionChapterCount: 2
      })
    ).rejects.toBeInstanceOf(RuntimeWindowGenerationError);
    await expect(
      generateRuntimeWindows({
        projectRoot,
        jobId: "job-empty",
        bookId: "book-a",
        sourceTextPath,
        singleRunChapterCount: 2,
        overlapChapterCount: 0,
        extractionChapterCount: 2
      })
    ).rejects.toMatchObject({ code: "NO_CHAPTERS" });
  });

  it("rejects absolute source paths outside projectRoot before reading them", async () => {
    const projectRoot = await createTempProject();
    const outsideSourceTextPath = getOtherDriveAbsolutePath(projectRoot);

    await expect(
      generateRuntimeWindows({
        projectRoot,
        jobId: "job-outside-source",
        bookId: "book-a",
        sourceTextPath: outsideSourceTextPath,
        singleRunChapterCount: 2,
        overlapChapterCount: 0,
        extractionChapterCount: 2
      })
    ).rejects.toMatchObject({
      name: "RuntimeWindowGenerationError",
      code: "SOURCE_OUTSIDE_PROJECT"
    });
  });
});

async function createTempProject(): Promise<string> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "runtime-windows-"));
  tempRoots.push(projectRoot);
  return projectRoot;
}

async function writeSource(projectRoot: string, relativePath: string, text: string): Promise<string> {
  const sourceTextPath = path.join(projectRoot, relativePath);
  await mkdir(path.dirname(sourceTextPath), { recursive: true });
  await writeFile(sourceTextPath, text, "utf8");
  return sourceTextPath;
}

function buildChapters(count: number): string {
  return Array.from({ length: count }, (_, index) => {
    const chapterNumber = index + 1;
    return `第${chapterNumber}章 标题${chapterNumber}\n正文 ${chapterNumber}`;
  }).join("\n\n");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function getOtherDriveAbsolutePath(projectRoot: string): string {
  if (process.platform !== "win32") {
    return path.resolve(projectRoot, "..", "outside-source.txt");
  }

  const projectDrive = path.parse(projectRoot).root.slice(0, 1).toUpperCase();
  const otherDrive = projectDrive === "Z" ? "Y" : "Z";
  const outsideSourceTextPath = `${otherDrive}:\\outside-source.txt`;
  const relativePath = path.relative(projectRoot, outsideSourceTextPath);

  expect(path.isAbsolute(relativePath)).toBe(true);

  return outsideSourceTextPath;
}
