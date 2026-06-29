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
  });
});
