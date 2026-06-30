import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import iconv from "iconv-lite";
import type { Book, Chapter, Project } from "@novel-extractor/domain";
import { ChapterParseError } from "./chapterParser";
import { TextDecodingError } from "./textEncoding";
import {
  type SaveUploadedBookInput,
  type UploadedBookRepository,
  UploadBookError,
  uploadBook
} from "./uploadBook";

const createdTempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(createdTempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("uploadBook", () => {
  it("copies the source txt, creates book metadata, and writes chapter text files", async () => {
    const { project, sourcePath } = await createProjectWithSource(
      "novel.txt",
      "第一章 起始\n第一段\n第2章 转折\n第二段"
    );
    const repository = createFakeUploadedBookRepository();

    const result = await uploadBook({
      project,
      sourcePath,
      displayName: "测试小说",
      repository,
      clock: { now: () => "2026-06-27T00:00:00.000Z" },
      idGenerator: createSequentialIdGenerator(["book-1", "source-1", "chapter-1", "chapter-2"])
    });

    const bookRoot = path.join(project.rootPath, "assets", "books", "book-1");
    await expect(fs.readFile(path.join(bookRoot, "source", "original.txt"), "utf8")).resolves.toBe(
      "第一章 起始\n第一段\n第2章 转折\n第二段"
    );
    await expect(fs.readFile(path.join(bookRoot, "chapters", "0000.txt"), "utf8")).resolves.toBe("第一段");
    await expect(fs.readFile(path.join(bookRoot, "chapters", "0001.txt"), "utf8")).resolves.toBe("第二段");

    expect(repository.savedUploads).toHaveLength(1);
    expect(repository.savedUploads[0].book).toMatchObject({
      id: "book-1",
      projectId: project.id,
      displayName: "测试小说",
      sourceAssetId: "source-1",
      sourceTextPath: "assets/books/book-1/source/original.txt",
      chapterCount: 2
    });
    expect(repository.savedUploads[0].chapters).toEqual([
      {
        id: "chapter-1",
        bookId: "book-1",
        index: 0,
        title: "第一章 起始",
        textPath: "assets/books/book-1/chapters/0000.txt"
      },
      {
        id: "chapter-2",
        bookId: "book-1",
        index: 1,
        title: "第2章 转折",
        textPath: "assets/books/book-1/chapters/0001.txt"
      }
    ]);
    expect(result.book.id).toBe("book-1");
    expect(result.sourceRelativePath).toBe(result.book.sourceTextPath);
    expect(result.chapters).toHaveLength(2);
  });

  it("does not create book metadata or assets when decoding fails", async () => {
    const { project, sourcePath } = await createProjectWithSource(
      "broken.txt",
      Buffer.from([0xff, 0x00, 0x80, 0x00, 0x1f, 0x00])
    );
    const repository = createFakeUploadedBookRepository();

    await expect(
      uploadBook({
        project,
        sourcePath,
        repository,
        idGenerator: createSequentialIdGenerator(["book-1", "source-1"])
      })
    ).rejects.toBeInstanceOf(TextDecodingError);

    expect(repository.savedUploads).toHaveLength(0);
    await expect(pathExists(path.join(project.rootPath, "assets", "books", "book-1"))).resolves.toBe(false);
  });

  it("does not create book metadata or assets when chapter parsing fails", async () => {
    const { project, sourcePath } = await createProjectWithSource("flat.txt", "只有正文，没有章节标题");
    const repository = createFakeUploadedBookRepository();

    await expect(
      uploadBook({
        project,
        sourcePath,
        repository,
        idGenerator: createSequentialIdGenerator(["book-1", "source-1"])
      })
    ).rejects.toBeInstanceOf(ChapterParseError);

    expect(repository.savedUploads).toHaveLength(0);
    await expect(pathExists(path.join(project.rootPath, "assets", "books", "book-1"))).resolves.toBe(false);
  });

  it("does not create book metadata or assets when GBK short text has no chapter headings", async () => {
    const { project, sourcePath } = await createProjectWithSource(
      "flat-gbk.txt",
      iconv.encode("只有正文，没有章节标题", "gbk")
    );
    const repository = createFakeUploadedBookRepository();

    await expect(
      uploadBook({
        project,
        sourcePath,
        repository,
        idGenerator: createSequentialIdGenerator(["book-1", "source-1"])
      })
    ).rejects.toBeInstanceOf(ChapterParseError);

    expect(repository.savedUploads).toHaveLength(0);
    await expect(pathExists(path.join(project.rootPath, "assets", "books", "book-1"))).resolves.toBe(false);
  });

  it("does not create book metadata or assets for GBK rare-character noise with a chapter heading", async () => {
    const { project, sourcePath } = await createProjectWithSource(
      "noise-gbk.txt",
      iconv.encode(`第一章\n${"龠".repeat(80)}`, "gbk")
    );
    const repository = createFakeUploadedBookRepository();

    await expect(
      uploadBook({
        project,
        sourcePath,
        repository,
        idGenerator: createSequentialIdGenerator(["book-1", "source-1", "chapter-1"])
      })
    ).rejects.toBeInstanceOf(TextDecodingError);

    expect(repository.savedUploads).toHaveLength(0);
    await expect(pathExists(path.join(project.rootPath, "assets", "books", "book-1"))).resolves.toBe(false);
  });

  it("rejects non-txt sources with a typed error and no side effects", async () => {
    const { project, sourcePath } = await createProjectWithSource("novel.md", "第一章 起始\n正文");
    const repository = createFakeUploadedBookRepository();

    await expect(
      uploadBook({
        project,
        sourcePath,
        repository,
        idGenerator: createSequentialIdGenerator(["book-1", "source-1"])
      })
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FILE_EXTENSION" });
    await expect(
      uploadBook({
        project,
        sourcePath,
        repository,
        idGenerator: createSequentialIdGenerator(["book-1", "source-1"])
      })
    ).rejects.toBeInstanceOf(UploadBookError);

    expect(repository.savedUploads).toHaveLength(0);
    await expect(pathExists(path.join(project.rootPath, "assets", "books", "book-1"))).resolves.toBe(false);
  });

  it("rejects asset layouts where source and chapter files resolve to the same destination", async () => {
    const { project, sourcePath } = await createProjectWithSource("novel.txt", "第一章 起始\n章节正文");
    const repository = createFakeUploadedBookRepository();

    await expect(
      uploadBook({
        project,
        sourcePath,
        repository,
        idGenerator: createSequentialIdGenerator(["book-1", "source-1", "chapter-1"]),
        assetLayout: {
          sourceDirectoryName: "same",
          chapterDirectoryName: "same",
          sourceFileName: "shared.txt",
          chapterFileName: () => "shared.txt"
        }
      })
    ).rejects.toMatchObject({ code: "BOOK_ASSET_PATH_COLLISION" });

    expect(repository.savedUploads).toHaveLength(0);
    await expect(pathExists(path.join(project.rootPath, "assets", "books", "book-1"))).resolves.toBe(false);
  });

  it("rejects duplicate chapter asset destinations before writing chapter files", async () => {
    const { project, sourcePath } = await createProjectWithSource(
      "novel.txt",
      "第一章 起始\n第一段\n第二章 转折\n第二段"
    );
    const repository = createFakeUploadedBookRepository();

    await expect(
      uploadBook({
        project,
        sourcePath,
        repository,
        idGenerator: createSequentialIdGenerator(["book-1", "source-1", "chapter-1", "chapter-2"]),
        assetLayout: {
          chapterFileName: () => "duplicate.txt"
        }
      })
    ).rejects.toMatchObject({ code: "BOOK_ASSET_PATH_COLLISION" });

    expect(repository.savedUploads).toHaveLength(0);
    await expect(pathExists(path.join(project.rootPath, "assets", "books", "book-1"))).resolves.toBe(false);
  });
});

async function createProjectWithSource(fileName: string, content: string | Buffer) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-upload-"));
  createdTempDirs.push(tempRoot);
  const projectRoot = path.join(tempRoot, "project");
  await fs.mkdir(projectRoot, { recursive: true });

  const sourcePath = path.join(tempRoot, fileName);
  await fs.writeFile(sourcePath, content);

  const project: Project = {
    id: "project-1",
    displayName: "测试项目",
    slug: "project-test",
    rootPath: projectRoot,
    createdAt: "2026-06-27T00:00:00.000Z"
  };

  return { project, sourcePath };
}

function createFakeUploadedBookRepository(): UploadedBookRepository & {
  savedUploads: SaveUploadedBookInput[];
} {
  const savedUploads: SaveUploadedBookInput[] = [];

  return {
    savedUploads,
    async saveUploadedBook(input) {
      savedUploads.push(input);
      return { book: input.book as Book, chapters: input.chapters as Chapter[] };
    }
  };
}

function createSequentialIdGenerator(ids: string[]) {
  return {
    createId() {
      const id = ids.shift();
      if (!id) {
        throw new Error("No test id left");
      }
      return id;
    }
  };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
