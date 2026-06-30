import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import initSqlJs from "sql.js";
import { describe, expect, it } from "vitest";
import { DuplicateProjectError, SqliteProjectRepository } from "./sqliteProjectRepository";

function makeWorkspaceRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "novel-persistence-"));
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

async function readSqliteTableNames(databasePath: string): Promise<string[]> {
  const SQL = await initSqlJs();
  const database = new SQL.Database(fs.readFileSync(databasePath));
  const result = database.exec(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
  );
  database.close();
  return (result[0]?.values ?? []).map(([name]) => String(name));
}

async function readSqliteBookSourceTextRows(databasePath: string): Promise<[string, string][]> {
  const SQL = await initSqlJs();
  const database = new SQL.Database(fs.readFileSync(databasePath));
  const result = database.exec("SELECT id, source_text_path FROM books ORDER BY id");
  database.close();
  return (result[0]?.values ?? []).map(([id, sourceTextPath]) => [
    String(id),
    String(sourceTextPath)
  ]);
}

async function readSqliteColumnNames(databasePath: string, tableName: string): Promise<string[]> {
  const SQL = await initSqlJs();
  const database = new SQL.Database(fs.readFileSync(databasePath));
  const result = database.exec(`PRAGMA table_info(${tableName})`);
  database.close();
  return (result[0]?.values ?? []).map((row) => String(row[1]));
}

describe("sqlite project repository", () => {
  it("rejects duplicate display names without overwriting the existing project", async () => {
    const workspaceRoot = makeWorkspaceRoot();
    const repository = await SqliteProjectRepository.open({
      workspaceRoot,
      clock: makeClock(),
      idGenerator: makeIdGenerator()
    });
    const first = await repository.createProject({ displayName: "丹药分析" });

    await expect(repository.createProject({ displayName: "丹药分析" })).rejects.toThrow(
      DuplicateProjectError
    );

    expect(fs.existsSync(path.join(first.rootPath, ".novel-studio", "project.sqlite"))).toBe(true);
    expect(await repository.listProjects()).toEqual([first]);
  });

  it("creates the project database, book asset directories, schema tables, and reopens metadata", async () => {
    const workspaceRoot = makeWorkspaceRoot();
    const repository = await SqliteProjectRepository.open({
      workspaceRoot,
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

    const databasePath = path.join(project.rootPath, ".novel-studio", "project.sqlite");
    expect(fs.existsSync(databasePath)).toBe(true);
    expect(fs.statSync(path.join(project.rootPath, ".novel-studio", "logs")).isDirectory()).toBe(
      true
    );
    expect(
      fs.statSync(path.join(project.rootPath, "assets", "books", book.id, "source")).isDirectory()
    ).toBe(true);
    expect(
      fs.statSync(path.join(project.rootPath, "assets", "books", book.id, "reports")).isDirectory()
    ).toBe(true);
    expect(
      fs.statSync(path.join(project.rootPath, "assets", "books", book.id, "templates")).isDirectory()
    ).toBe(true);

    await expect(readSqliteTableNames(databasePath)).resolves.toEqual(
      expect.arrayContaining([
        "projects",
        "books",
        "chapters",
        "reports",
        "jobs",
        "job_events",
        "usage_records"
      ])
    );

    const reopened = await SqliteProjectRepository.open({ workspaceRoot });
    await expect(reopened.findByDisplayName("丹药分析")).resolves.toEqual(project);
    await expect(reopened.listBooks(project.id)).resolves.toEqual([
      {
        ...book,
        sourceTextPath: "assets/books/book-2/source/original.txt"
      }
    ]);
  });

  it("derives sourceTextPath from the generated book id instead of trusting input", async () => {
    const workspaceRoot = makeWorkspaceRoot();
    const repository = await SqliteProjectRepository.open({
      workspaceRoot,
      clock: makeClock(),
      idGenerator: makeIdGenerator()
    });
    const project = await repository.createProject({ displayName: "丹药分析" });

    const book = await repository.createBook({
      projectId: project.id,
      displayName: "第一卷",
      sourceAssetId: "source-1",
      sourceTextPath: "assets/books/wrong/source/original.txt",
      chapterCount: 0
    });

    expect(book.sourceTextPath).toBe(`assets/books/${book.id}/source/original.txt`);
    await expect(repository.listBooks(project.id)).resolves.toEqual([book]);
  });

  it("backfills sourceTextPath when reopening legacy books without the column", async () => {
    const workspaceRoot = makeWorkspaceRoot();
    const projectRoot = path.join(workspaceRoot, "legacy-project");
    const databasePath = path.join(projectRoot, ".novel-studio", "project.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const SQL = await initSqlJs();
    const database = new SQL.Database();

    database.run(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL UNIQUE,
        slug TEXT NOT NULL UNIQUE,
        root_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE books (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        source_asset_id TEXT NOT NULL,
        chapter_count INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    database.run(
      `INSERT INTO projects (id, display_name, slug, root_path, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      ["project-legacy", "旧项目", "legacy-project", projectRoot, "2026-06-26T00:00:00.000Z"]
    );
    database.run(
      `INSERT INTO books (id, project_id, display_name, source_asset_id, chapter_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["book-legacy", "project-legacy", "旧书", "source-legacy", 0, "2026-06-26T00:00:00.000Z"]
    );
    fs.writeFileSync(databasePath, Buffer.from(database.export()));
    database.close();

    const repository = await SqliteProjectRepository.open({ workspaceRoot });

    await expect(repository.listBooks("project-legacy")).resolves.toEqual([
      {
        id: "book-legacy",
        projectId: "project-legacy",
        displayName: "旧书",
        sourceAssetId: "source-legacy",
        sourceTextPath: "assets/books/book-legacy/source/original.txt",
        chapterCount: 0,
        createdAt: "2026-06-26T00:00:00.000Z"
      }
    ]);
    await expect(readSqliteTableNames(databasePath)).resolves.toEqual(
      expect.arrayContaining(["books"])
    );
    const bookColumns = new Set(await readSqliteColumnNames(databasePath, "books"));
    expect(bookColumns.has("source_text_path")).toBe(true);
    await expect(readSqliteBookSourceTextRows(databasePath)).resolves.toEqual([
      ["book-legacy", "assets/books/book-legacy/source/original.txt"]
    ]);
  });
});
