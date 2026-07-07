import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Book, Clock, IdGenerator, Project } from "@novel-extractor/domain";
import { createSafeProjectPath, toSafeRelativePath } from "@novel-extractor/persistence/safePaths";
import { parseChapters } from "./chapterParser";
import { decodeNovelText, type NovelTextEncoding } from "./textEncoding";

export interface SaveUploadedBookInput {
  book: Book;
}

export interface UploadedBookRepository {
  saveUploadedBook(input: SaveUploadedBookInput): Promise<{ book: Book }>;
}

export interface UploadBookAssetLayout {
  sourceDirectoryName?: string;
  sourceFileName?: string;
}

export interface UploadBookInput {
  project: Project;
  sourcePath: string;
  repository: UploadedBookRepository;
  displayName?: string;
  clock?: Clock;
  idGenerator?: IdGenerator;
  bookIdCollisionRetryLimit?: number;
  assetLayout?: UploadBookAssetLayout;
}

export interface UploadBookResult {
  book: Book;
  sourceRelativePath: string;
  encoding: NovelTextEncoding;
}

export type UploadBookErrorCode =
  | "UNSUPPORTED_FILE_EXTENSION"
  | "BOOK_ASSET_ALREADY_EXISTS"
  | "BOOK_ASSET_PATH_COLLISION";

export class UploadBookError extends Error {
  readonly code: UploadBookErrorCode;

  constructor(code: UploadBookErrorCode, message: string) {
    super(message);
    this.name = "UploadBookError";
    this.code = code;
  }
}

const DEFAULT_ASSET_LAYOUT = {
  sourceDirectoryName: "source",
  sourceFileName: "original.txt"
} satisfies Required<UploadBookAssetLayout>;

const DEFAULT_BOOK_ID_COLLISION_RETRY_LIMIT = 20;
const SUPPORTED_NOVEL_SOURCE_EXTENSIONS = new Set([".txt", ".md"]);

const systemClock: Clock = {
  now: () => new Date().toISOString()
};

const randomIdGenerator: IdGenerator = {
  createId(prefix = "id") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
};

export async function uploadBook(input: UploadBookInput): Promise<UploadBookResult> {
  assertSupportedNovelSource(input.sourcePath);

  const sourceBuffer = await fs.readFile(input.sourcePath);
  const decoded = decodeNovelText(sourceBuffer);
  const parsedChapters = parseChapters(decoded.text);

  const clock = input.clock ?? systemClock;
  const idGenerator = input.idGenerator ?? randomIdGenerator;
  const assetLayout = { ...DEFAULT_ASSET_LAYOUT, ...input.assetLayout };
  const now = clock.now();

  const booksRoot = createSafeProjectPath(input.project.rootPath, "assets", "books");

  let createdBookRoot = false;
  let bookRoot = "";

  try {
    await fs.mkdir(booksRoot, { recursive: true });
    const bookAssetRoot = await createAvailableBookAssetRoot({
      projectRoot: input.project.rootPath,
      booksRoot,
      idGenerator,
      retryLimit: input.bookIdCollisionRetryLimit ?? DEFAULT_BOOK_ID_COLLISION_RETRY_LIMIT
    });
    const bookId = bookAssetRoot.bookId;
    bookRoot = bookAssetRoot.bookRoot;
    createdBookRoot = true;

    const sourceDestination = createSafeProjectPath(
      input.project.rootPath,
      "assets",
      "books",
      bookId,
      assetLayout.sourceDirectoryName,
      assetLayout.sourceFileName
    );

    const sourceDirectory = createSafeProjectPath(
      input.project.rootPath,
      "assets",
      "books",
      bookId,
      assetLayout.sourceDirectoryName
    );
    const sourceAssetId = idGenerator.createId("source");

    await fs.mkdir(sourceDirectory, { recursive: true });

    await copyFileExclusively(input.sourcePath, sourceDestination);
    const sourceRelativePath = toSafeRelativePath(input.project.rootPath, sourceDestination);

    const book: Book = {
      id: bookId,
      projectId: input.project.id,
      displayName: normalizeDisplayName(
        input.displayName ?? path.basename(input.sourcePath, path.extname(input.sourcePath))
      ),
      sourceAssetId,
      sourceTextPath: sourceRelativePath,
      chapterCount: parsedChapters.length,
      createdAt: now
    };

    const saved = await input.repository.saveUploadedBook({ book });

    return {
      ...saved,
      sourceRelativePath,
      encoding: decoded.encoding
    };
  } catch (error) {
    if (createdBookRoot) {
      await fs.rm(bookRoot, { recursive: true, force: true });
    }
    throw error;
  }
}

async function createAvailableBookAssetRoot(input: {
  projectRoot: string;
  booksRoot: string;
  idGenerator: IdGenerator;
  retryLimit: number;
}): Promise<{ bookId: string; bookRoot: string }> {
  const retryLimit = Math.max(1, Math.floor(input.retryLimit));

  for (let attempt = 0; attempt < retryLimit; attempt += 1) {
    const bookId = input.idGenerator.createId("book");
    const bookRoot = createSafeProjectPath(input.projectRoot, "assets", "books", bookId);

    try {
      await createNewDirectory(bookRoot);
      return { bookId, bookRoot };
    } catch (error) {
      if (error instanceof UploadBookError && error.code === "BOOK_ASSET_ALREADY_EXISTS") {
        continue;
      }
      throw error;
    }
  }

  throw new UploadBookError(
    "BOOK_ASSET_ALREADY_EXISTS",
    `Book asset directory already exists after ${retryLimit} attempts under ${input.booksRoot}`
  );
}

async function copyFileExclusively(sourcePath: string, destinationPath: string): Promise<void> {
  try {
    await fs.copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    throwIfAssetAlreadyExists(error, destinationPath);
    throw error;
  }
}

function throwIfAssetAlreadyExists(error: unknown, destinationPath: string): void {
  if (isNodeError(error) && error.code === "EEXIST") {
    throw new UploadBookError("BOOK_ASSET_PATH_COLLISION", `Book asset already exists: ${destinationPath}`);
  }
}

function assertSupportedNovelSource(sourcePath: string): void {
  const extension = path.extname(sourcePath).toLowerCase();

  if (!SUPPORTED_NOVEL_SOURCE_EXTENSIONS.has(extension)) {
    throw new UploadBookError("UNSUPPORTED_FILE_EXTENSION", "Only .txt or .md novel sources can be uploaded");
  }
}

async function createNewDirectory(directory: string): Promise<void> {
  try {
    await fs.mkdir(directory);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new UploadBookError("BOOK_ASSET_ALREADY_EXISTS", `Book asset directory already exists: ${directory}`);
    }
    throw error;
  }
}

function normalizeDisplayName(displayName: string): string {
  const normalized = displayName.trim().normalize("NFC");
  if (!normalized) {
    throw new UploadBookError("UNSUPPORTED_FILE_EXTENSION", "Book display name must not be blank");
  }
  return normalized;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
