import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import initSqlJs from "sql.js";
import {
  createProjectSlug,
  type Book,
  type Chapter,
  type Project,
  type ReportAsset
} from "@novel-extractor/domain";
import type { Clock, IdGenerator, ProjectRepository, BookRepository } from "@novel-extractor/domain";
import { createSafeProjectPath } from "./safePaths";

export class DuplicateProjectError extends Error {
  readonly code = "DUPLICATE_PROJECT";

  constructor(message: string) {
    super(message);
    this.name = "DuplicateProjectError";
  }
}

export interface SqliteProjectRepositoryOptions {
  workspaceRoot: string;
  clock?: Clock;
  idGenerator?: IdGenerator;
}

type SqlJsStatic = initSqlJs.SqlJsStatic;
type SqliteDatabase = initSqlJs.Database;
type SqlValue = string | number | Uint8Array | null;
type SqlRow = Record<string, SqlValue>;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  root_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  source_asset_id TEXT NOT NULL,
  chapter_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS chapters (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  chapter_index INTEGER NOT NULL,
  title TEXT NOT NULL,
  text_path TEXT NOT NULL,
  FOREIGN KEY (book_id) REFERENCES books(id)
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (book_id) REFERENCES books(id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  template_ids TEXT NOT NULL,
  provider_config_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL,
  progress_text TEXT NOT NULL,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (book_id) REFERENCES books(id)
);

CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);

CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  provider_config_id TEXT,
  model_id TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);
`;

let sqlModulePromise: Promise<SqlJsStatic> | null = null;

export class SqliteProjectRepository implements ProjectRepository, BookRepository {
  private constructor(
    private readonly sqlModule: SqlJsStatic,
    private readonly workspaceRoot: string,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator
  ) {}

  static async open(options: SqliteProjectRepositoryOptions): Promise<SqliteProjectRepository> {
    fs.mkdirSync(options.workspaceRoot, { recursive: true });
    const workspaceRoot = fs.realpathSync.native(options.workspaceRoot);
    const sqlModule = await getSqlModule();

    return new SqliteProjectRepository(
      sqlModule,
      workspaceRoot,
      options.clock ?? systemClock,
      options.idGenerator ?? randomIdGenerator
    );
  }

  async createProject(input: { displayName: string }): Promise<Project> {
    const displayName = normalizeDisplayName(input.displayName);
    const slug = createProjectSlug(displayName);
    const existingProject = await this.findByDisplayName(displayName);

    if (existingProject) {
      throw new DuplicateProjectError(`Project already exists: ${displayName}`);
    }

    const projectRoot = createSafeProjectPath(this.workspaceRoot, slug);
    if (fs.existsSync(projectRoot)) {
      throw new DuplicateProjectError(`Project path already exists: ${slug}`);
    }

    fs.mkdirSync(projectRoot);
    fs.mkdirSync(createSafeProjectPath(projectRoot, ".novel-studio"));
    fs.mkdirSync(createSafeProjectPath(projectRoot, ".novel-studio", "logs"));
    fs.mkdirSync(createSafeProjectPath(projectRoot, "assets"));
    fs.mkdirSync(createSafeProjectPath(projectRoot, "assets", "books"), { recursive: true });

    const project: Project = {
      id: this.idGenerator.createId("project"),
      displayName,
      slug,
      rootPath: fs.realpathSync.native(projectRoot),
      createdAt: this.clock.now()
    };

    const databasePath = getProjectDatabasePath(project.rootPath);
    const database = this.createDatabase();
    try {
      database.run(
        `INSERT INTO projects (id, display_name, slug, root_path, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [project.id, project.displayName, project.slug, project.rootPath, project.createdAt]
      );
      this.writeDatabase(databasePath, database);
    } finally {
      database.close();
    }

    return project;
  }

  async findByDisplayName(displayName: string): Promise<Project | null> {
    const normalizedDisplayName = normalizeDisplayName(displayName);

    for (const databasePath of this.listProjectDatabasePaths()) {
      const project = this.readSingleProject(databasePath);
      if (project?.displayName === normalizedDisplayName) {
        return project;
      }
    }

    return null;
  }

  async listProjects(): Promise<Project[]> {
    return this.listProjectDatabasePaths()
      .map((databasePath) => this.readSingleProject(databasePath))
      .filter((project): project is Project => project !== null)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async createBook(
    input: Pick<Book, "projectId" | "displayName" | "sourceAssetId" | "chapterCount">
  ): Promise<Book> {
    const projectRecord = this.findProjectRecordById(input.projectId);
    if (!projectRecord) {
      throw new Error(`Project not found: ${input.projectId}`);
    }

    const book: Book = {
      id: this.idGenerator.createId("book"),
      projectId: input.projectId,
      displayName: normalizeDisplayName(input.displayName),
      sourceAssetId: input.sourceAssetId,
      chapterCount: input.chapterCount,
      createdAt: this.clock.now()
    };

    const bookRoot = createSafeProjectPath(projectRecord.project.rootPath, "assets", "books", book.id);
    fs.mkdirSync(bookRoot);
    fs.mkdirSync(createSafeProjectPath(bookRoot, "source"), { recursive: true });
    fs.mkdirSync(createSafeProjectPath(bookRoot, "reports"), { recursive: true });
    fs.mkdirSync(createSafeProjectPath(bookRoot, "templates"), { recursive: true });

    this.mutateDatabase(projectRecord.databasePath, (database) => {
      database.run(
        `INSERT INTO books (id, project_id, display_name, source_asset_id, chapter_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          book.id,
          book.projectId,
          book.displayName,
          book.sourceAssetId,
          book.chapterCount,
          book.createdAt
        ]
      );
    });

    return book;
  }

  async listBooks(projectId: string): Promise<Book[]> {
    const projectRecord = this.findProjectRecordById(projectId);
    if (!projectRecord) {
      return [];
    }

    return this.readRows(
      projectRecord.databasePath,
      `SELECT id, project_id, display_name, source_asset_id, chapter_count, created_at
       FROM books
       WHERE project_id = ?
       ORDER BY created_at`,
      [projectId]
    ).map(rowToBook);
  }

  async listChapters(bookId: string): Promise<Chapter[]> {
    const bookRecord = this.findBookRecordById(bookId);
    if (!bookRecord) {
      return [];
    }

    return this.readRows(
      bookRecord.databasePath,
      `SELECT id, book_id, chapter_index, title, text_path
       FROM chapters
       WHERE book_id = ?
       ORDER BY chapter_index`,
      [bookId]
    ).map(rowToChapter);
  }

  async listReports(bookId: string): Promise<ReportAsset[]> {
    const bookRecord = this.findBookRecordById(bookId);
    if (!bookRecord) {
      return [];
    }

    return this.readRows(
      bookRecord.databasePath,
      `SELECT id, book_id, file_name, display_name, relative_path, byte_size, created_at, updated_at
       FROM reports
       WHERE book_id = ?
       ORDER BY created_at`,
      [bookId]
    ).map(rowToReportAsset);
  }

  async findProjectById(projectId: string): Promise<Project | null> {
    return this.findProjectRecordById(projectId)?.project ?? null;
  }

  async findBookById(bookId: string): Promise<Book | null> {
    return this.findBookRecordById(bookId)?.book ?? null;
  }

  async saveReport(report: ReportAsset): Promise<ReportAsset> {
    const bookRecord = this.findBookRecordById(report.bookId);
    if (!bookRecord) {
      throw new Error(`Book not found: ${report.bookId}`);
    }

    this.mutateDatabase(bookRecord.databasePath, (database) => {
      database.run(
        `INSERT INTO reports
           (id, book_id, file_name, display_name, relative_path, byte_size, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          report.id,
          report.bookId,
          report.fileName,
          report.displayName,
          report.relativePath,
          report.byteSize,
          report.createdAt,
          report.updatedAt
        ]
      );
    });

    return report;
  }

  private createDatabase(): SqliteDatabase {
    const database = new this.sqlModule.Database();
    database.run("PRAGMA foreign_keys = ON");
    database.run(SCHEMA_SQL);
    return database;
  }

  private openDatabase(databasePath: string): SqliteDatabase {
    const database = fs.existsSync(databasePath)
      ? new this.sqlModule.Database(fs.readFileSync(databasePath))
      : new this.sqlModule.Database();
    database.run("PRAGMA foreign_keys = ON");
    database.run(SCHEMA_SQL);
    return database;
  }

  private writeDatabase(databasePath: string, database: SqliteDatabase): void {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.writeFileSync(databasePath, Buffer.from(database.export()));
  }

  private mutateDatabase(databasePath: string, mutator: (database: SqliteDatabase) => void): void {
    const database = this.openDatabase(databasePath);
    try {
      database.run("BEGIN");
      mutator(database);
      database.run("COMMIT");
      this.writeDatabase(databasePath, database);
    } catch (error) {
      database.run("ROLLBACK");
      throw error;
    } finally {
      database.close();
    }
  }

  private readRows(databasePath: string, sql: string, params: SqlValue[] = []): SqlRow[] {
    const database = this.openDatabase(databasePath);
    try {
      const statement = database.prepare(sql);
      try {
        statement.bind(params);
        const rows: SqlRow[] = [];
        while (statement.step()) {
          rows.push(statement.getAsObject() as SqlRow);
        }
        return rows;
      } finally {
        statement.free();
      }
    } finally {
      database.close();
    }
  }

  private readSingleProject(databasePath: string): Project | null {
    const rows = this.readRows(
      databasePath,
      `SELECT id, display_name, slug, root_path, created_at
       FROM projects
       ORDER BY created_at
       LIMIT 1`
    );
    return rows[0] ? rowToProject(rows[0]) : null;
  }

  private findProjectRecordById(
    projectId: string
  ): { project: Project; databasePath: string } | null {
    for (const databasePath of this.listProjectDatabasePaths()) {
      const rows = this.readRows(
        databasePath,
        `SELECT id, display_name, slug, root_path, created_at
         FROM projects
         WHERE id = ?
         LIMIT 1`,
        [projectId]
      );
      if (rows[0]) {
        return { project: rowToProject(rows[0]), databasePath };
      }
    }

    return null;
  }

  private findBookRecordById(bookId: string): { book: Book; databasePath: string } | null {
    for (const databasePath of this.listProjectDatabasePaths()) {
      const rows = this.readRows(
        databasePath,
        `SELECT id, project_id, display_name, source_asset_id, chapter_count, created_at
         FROM books
         WHERE id = ?
         LIMIT 1`,
        [bookId]
      );
      if (rows[0]) {
        return { book: rowToBook(rows[0]), databasePath };
      }
    }

    return null;
  }

  private listProjectDatabasePaths(): string[] {
    return fs
      .readdirSync(this.workspaceRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        createSafeProjectPath(this.workspaceRoot, entry.name, ".novel-studio", "project.sqlite")
      )
      .filter((databasePath) => fs.existsSync(databasePath));
  }
}

function getProjectDatabasePath(projectRoot: string): string {
  return createSafeProjectPath(projectRoot, ".novel-studio", "project.sqlite");
}

async function getSqlModule(): Promise<SqlJsStatic> {
  sqlModulePromise ??= initSqlJs();
  return sqlModulePromise;
}

const systemClock: Clock = {
  now: () => new Date().toISOString()
};

const randomIdGenerator: IdGenerator = {
  createId(prefix = "id") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
};

function normalizeDisplayName(displayName: string): string {
  const normalized = displayName.trim().normalize("NFC");
  if (!normalized) {
    throw new Error("Display name must not be blank");
  }
  return normalized;
}

function rowToProject(row: SqlRow): Project {
  return {
    id: requireString(row, "id"),
    displayName: requireString(row, "display_name"),
    slug: requireString(row, "slug"),
    rootPath: requireString(row, "root_path"),
    createdAt: requireString(row, "created_at")
  };
}

function rowToBook(row: SqlRow): Book {
  return {
    id: requireString(row, "id"),
    projectId: requireString(row, "project_id"),
    displayName: requireString(row, "display_name"),
    sourceAssetId: requireString(row, "source_asset_id"),
    chapterCount: requireNumber(row, "chapter_count"),
    createdAt: requireString(row, "created_at")
  };
}

function rowToChapter(row: SqlRow): Chapter {
  return {
    id: requireString(row, "id"),
    bookId: requireString(row, "book_id"),
    index: requireNumber(row, "chapter_index"),
    title: requireString(row, "title"),
    textPath: requireString(row, "text_path")
  };
}

function rowToReportAsset(row: SqlRow): ReportAsset {
  return {
    id: requireString(row, "id"),
    bookId: requireString(row, "book_id"),
    fileName: requireString(row, "file_name"),
    displayName: requireString(row, "display_name"),
    relativePath: requireString(row, "relative_path"),
    byteSize: requireNumber(row, "byte_size"),
    createdAt: requireString(row, "created_at"),
    updatedAt: requireString(row, "updated_at")
  };
}

function requireString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Expected SQLite column ${key} to be a string`);
  }
  return value;
}

function requireNumber(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number") {
    throw new Error(`Expected SQLite column ${key} to be a number`);
  }
  return value;
}
