import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileAssetRepository } from "./fileAssetRepository";
import { SqliteProjectRepository } from "./sqliteProjectRepository";

function makeWorkspaceRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "novel-assets-"));
}

function makeClock() {
  return { now: () => "2026-06-27T00:00:00.000Z" };
}

function makeIdGenerator() {
  let next = 0;
  return {
    createId(prefix = "id") {
      next += 1;
      return `${prefix}-${next}`;
    }
  };
}

function detectDirectoryLinkType(): "junction" | "dir" | null {
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novel-assets-link-probe-"));
  const target = path.join(probeRoot, "target");
  const link = path.join(probeRoot, "link");
  fs.mkdirSync(target);

  for (const type of ["junction", "dir"] as const) {
    try {
      fs.symlinkSync(target, link, type);
      fs.rmSync(probeRoot, { recursive: true, force: true });
      return type;
    } catch {
      fs.rmSync(link, { recursive: true, force: true });
    }
  }

  fs.rmSync(probeRoot, { recursive: true, force: true });
  return null;
}

const directoryLinkType = detectDirectoryLinkType();

function detectFileSymlinkSupport(): boolean {
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novel-assets-file-link-probe-"));
  const target = path.join(probeRoot, "target.md");
  const link = path.join(probeRoot, "link.md");
  fs.writeFileSync(target, "probe");

  try {
    fs.symlinkSync(target, link, "file");
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
}

const canCreateFileSymlink = detectFileSymlinkSupport();

async function makeProjectWithBook() {
  const repository = await SqliteProjectRepository.open({
    workspaceRoot: makeWorkspaceRoot(),
    clock: makeClock(),
    idGenerator: makeIdGenerator()
  });
  const project = await repository.createProject({ displayName: "丹药分析" });
  const book = await repository.createBook({
    projectId: project.id,
    displayName: "第一卷",
    sourceAssetId: "source-1",
    sourceTextPath: "assets/books/book-2/source/original.txt",
    chapterCount: 0
  });
  return { repository, project, book };
}

describe("file asset repository", () => {
  it("writes reports through safe paths and lists relative report assets", async () => {
    const { repository, project, book } = await makeProjectWithBook();
    const assets = new FileAssetRepository({
      projectRepository: repository,
      clock: makeClock(),
      idGenerator: makeIdGenerator()
    });

    const report = await assets.writeReport({
      projectId: project.id,
      bookId: book.id,
      fileName: "丹药分析.md",
      displayName: "丹药分析",
      content: "# 丹药分析"
    });

    expect(report.relativePath).toBe(
      `assets/books/${book.id}/reports/丹药分析.md`.replace(/\\/g, "/")
    );
    expect(path.isAbsolute(report.relativePath)).toBe(false);
    expect(fs.readFileSync(path.join(project.rootPath, report.relativePath), "utf8")).toBe(
      "# 丹药分析"
    );
    await expect(assets.listReports(book.id)).resolves.toEqual([report]);
  });

  it.skipIf(directoryLinkType === null)(
    "rejects writes when the reports directory itself escapes through a link",
    async () => {
      const { repository, project, book } = await makeProjectWithBook();
      const assets = new FileAssetRepository({
        projectRepository: repository,
        clock: makeClock(),
        idGenerator: makeIdGenerator()
      });
      const reportsRoot = path.join(project.rootPath, "assets", "books", book.id, "reports");
      const outsideRoot = path.join(path.dirname(project.rootPath), "outside-reports");
      fs.rmSync(reportsRoot, { recursive: true, force: true });
      fs.mkdirSync(outsideRoot);
      fs.symlinkSync(outsideRoot, reportsRoot, directoryLinkType ?? "dir");

      await expect(
        assets.writeReport({
          projectId: project.id,
          bookId: book.id,
          fileName: "escape.md",
          displayName: "escape",
          content: "bad"
        })
      ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
      expect(fs.existsSync(path.join(outsideRoot, "escape.md"))).toBe(false);
    }
  );

  it.each([
    "../secret.md",
    "..\\secret.md",
    "C:/Users/me/token.txt",
    "\\\\server\\share\\x.md",
    "nested/report.md",
    "nested\\report.md"
  ])("rejects report writes outside the reports directory: %s", async (fileName) => {
    const { repository, project, book } = await makeProjectWithBook();
    const assets = new FileAssetRepository({
      projectRepository: repository,
      clock: makeClock(),
      idGenerator: makeIdGenerator()
    });

    await expect(
      assets.writeReport({
        projectId: project.id,
        bookId: book.id,
        fileName,
        displayName: "bad",
        content: "bad"
      })
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    expect(fs.existsSync(path.join(project.rootPath, "secret.md"))).toBe(false);
  });

  it("rejects report writes when the final report file already exists", async () => {
    const { repository, project, book } = await makeProjectWithBook();
    const assets = new FileAssetRepository({
      projectRepository: repository,
      clock: makeClock(),
      idGenerator: makeIdGenerator()
    });
    const reportsRoot = path.join(project.rootPath, "assets", "books", book.id, "reports");
    const reportPath = path.join(reportsRoot, "existing.md");
    fs.mkdirSync(reportsRoot, { recursive: true });
    fs.writeFileSync(reportPath, "ORIGINAL");

    await expect(
      assets.writeReport({
        projectId: project.id,
        bookId: book.id,
        fileName: "existing.md",
        displayName: "existing",
        content: "MUTATED"
      })
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    expect(fs.readFileSync(reportPath, "utf8")).toBe("ORIGINAL");
  });

  it.skipIf(!canCreateFileSymlink)(
    "rejects report writes when the final report file is a symlink",
    async () => {
      const { repository, project, book } = await makeProjectWithBook();
      const assets = new FileAssetRepository({
        projectRepository: repository,
        clock: makeClock(),
        idGenerator: makeIdGenerator()
      });
      const reportsRoot = path.join(project.rootPath, "assets", "books", book.id, "reports");
      const reportPath = path.join(reportsRoot, "final-link.md");
      const outsideFile = path.join(path.dirname(project.rootPath), "outside-final-link.md");
      fs.mkdirSync(reportsRoot, { recursive: true });
      fs.writeFileSync(outsideFile, "ORIGINAL");
      fs.symlinkSync(outsideFile, reportPath, "file");

      await expect(
        assets.writeReport({
          projectId: project.id,
          bookId: book.id,
          fileName: "final-link.md",
          displayName: "final link",
          content: "MUTATED"
        })
      ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
      expect(fs.readFileSync(outsideFile, "utf8")).toBe("ORIGINAL");
      expect(fs.lstatSync(reportPath).isSymbolicLink()).toBe(true);
    }
  );

  it("rejects report writes when the final report file is a hard link", async () => {
    const { repository, project, book } = await makeProjectWithBook();
    const assets = new FileAssetRepository({
      projectRepository: repository,
      clock: makeClock(),
      idGenerator: makeIdGenerator()
    });
    const reportsRoot = path.join(project.rootPath, "assets", "books", book.id, "reports");
    const reportPath = path.join(reportsRoot, "final-hardlink.md");
    const outsideFile = path.join(path.dirname(project.rootPath), "outside-final-hardlink.md");
    fs.mkdirSync(reportsRoot, { recursive: true });
    fs.writeFileSync(outsideFile, "ORIGINAL");
    fs.linkSync(outsideFile, reportPath);

    await expect(
      assets.writeReport({
        projectId: project.id,
        bookId: book.id,
        fileName: "final-hardlink.md",
        displayName: "final hardlink",
        content: "MUTATED"
      })
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    expect(fs.readFileSync(outsideFile, "utf8")).toBe("ORIGINAL");
    expect(fs.statSync(reportPath).nlink).toBeGreaterThanOrEqual(2);
  });
});
