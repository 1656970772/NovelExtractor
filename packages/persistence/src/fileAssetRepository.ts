import crypto from "node:crypto";
import fs from "node:fs";
import {
  type Book,
  type Clock,
  type IdGenerator,
  type Project,
  type ReportAsset
} from "@novel-extractor/domain";
import { createSafeProjectPath, SafePathError, toSafeRelativePath } from "./safePaths";

export interface WriteReportInput {
  projectId: string;
  bookId: string;
  fileName: string;
  displayName: string;
  content: string | Uint8Array;
}

export interface FileAssetRepositoryOptions {
  projectRepository: {
    findProjectById(projectId: string): Promise<Project | null>;
    findBookById(bookId: string): Promise<Book | null>;
    saveReport(report: ReportAsset): Promise<ReportAsset>;
    listReports(bookId: string): Promise<ReportAsset[]>;
  };
  clock?: Clock;
  idGenerator?: IdGenerator;
}

export class FileAssetRepository {
  private readonly projectRepository: FileAssetRepositoryOptions["projectRepository"];
  private readonly clock: Clock;
  private readonly idGenerator: IdGenerator;

  constructor(options: FileAssetRepositoryOptions) {
    this.projectRepository = options.projectRepository;
    this.clock = options.clock ?? { now: () => new Date().toISOString() };
    this.idGenerator =
      options.idGenerator ??
      {
        createId(prefix = "id") {
          return `${prefix}-${crypto.randomUUID()}`;
        }
      };
  }

  async writeReport(input: WriteReportInput): Promise<ReportAsset> {
    const project = await this.projectRepository.findProjectById(input.projectId);
    if (!project) {
      throw new Error(`Project not found: ${input.projectId}`);
    }

    const book = await this.projectRepository.findBookById(input.bookId);
    if (!book || book.projectId !== project.id) {
      throw new Error(`Book not found in project: ${input.bookId}`);
    }

    const reportsRoot = createSafeProjectPath(
      project.rootPath,
      "assets",
      "books",
      book.id,
      "reports"
    );
    fs.mkdirSync(reportsRoot, { recursive: true });

    const reportPath = createSafeProjectPath(
      project.rootPath,
      "assets",
      "books",
      book.id,
      "reports",
      input.fileName
    );
    const content = typeof input.content === "string" ? Buffer.from(input.content, "utf8") : input.content;
    writeNewReportFile(reportPath, content);

    const now = this.clock.now();
    const report: ReportAsset = {
      id: this.idGenerator.createId("report"),
      bookId: book.id,
      fileName: input.fileName.normalize("NFC"),
      displayName: normalizeDisplayName(input.displayName),
      relativePath: toSafeRelativePath(project.rootPath, reportPath),
      byteSize: content.byteLength,
      createdAt: now,
      updatedAt: now
    };

    return this.projectRepository.saveReport(report);
  }

  async listReports(bookId: string): Promise<ReportAsset[]> {
    return this.projectRepository.listReports(bookId);
  }
}

function normalizeDisplayName(displayName: string): string {
  const normalized = displayName.trim().normalize("NFC");
  if (!normalized) {
    throw new Error("Report display name must not be blank");
  }
  return normalized;
}

function writeNewReportFile(reportPath: string, content: Buffer | Uint8Array): void {
  let fd: number | null = null;

  try {
    fd = fs.openSync(reportPath, "wx");
    fs.writeFileSync(fd, content);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new SafePathError("Report file already exists");
    }
    throw error;
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
