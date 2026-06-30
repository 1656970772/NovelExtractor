import crypto from "node:crypto";
import { constants as fsConstants, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Book, Chapter, Clock, IdGenerator, Project } from "@novel-extractor/domain";
import { createSafeProjectPath, toSafeRelativePath } from "@novel-extractor/persistence/safePaths";
import { parseChapters } from "./chapterParser";
import { decodeNovelText, type NovelTextEncoding } from "./textEncoding";

export interface SaveUploadedBookInput {
  book: Book;
  chapters: Chapter[];
}

export interface UploadedBookRepository {
  saveUploadedBook(input: SaveUploadedBookInput): Promise<{ book: Book; chapters: Chapter[] }>;
}

export interface UploadBookAssetLayout {
  sourceDirectoryName?: string;
  sourceFileName?: string;
  chapterDirectoryName?: string;
  chapterFileName?: (chapter: { index: number; title: string }) => string;
}

export interface UploadBookInput {
  project: Project;
  sourcePath: string;
  repository: UploadedBookRepository;
  displayName?: string;
  clock?: Clock;
  idGenerator?: IdGenerator;
  assetLayout?: UploadBookAssetLayout;
}

export interface UploadBookResult {
  book: Book;
  chapters: Chapter[];
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
  sourceFileName: "original.txt",
  chapterDirectoryName: "chapters",
  chapterFileName: (chapter: { index: number }) => `${chapter.index.toString().padStart(4, "0")}.txt`
} satisfies Required<UploadBookAssetLayout>;

const systemClock: Clock = {
  now: () => new Date().toISOString()
};

const randomIdGenerator: IdGenerator = {
  createId(prefix = "id") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
};

export async function uploadBook(input: UploadBookInput): Promise<UploadBookResult> {
  assertTxtSource(input.sourcePath);

  const sourceBuffer = await fs.readFile(input.sourcePath);
  const decoded = decodeNovelText(sourceBuffer);
  const parsedChapters = parseChapters(decoded.text);

  const clock = input.clock ?? systemClock;
  const idGenerator = input.idGenerator ?? randomIdGenerator;
  const assetLayout = { ...DEFAULT_ASSET_LAYOUT, ...input.assetLayout };
  const bookId = idGenerator.createId("book");
  const sourceAssetId = idGenerator.createId("source");
  const now = clock.now();

  const booksRoot = createSafeProjectPath(input.project.rootPath, "assets", "books");
  const bookRoot = createSafeProjectPath(input.project.rootPath, "assets", "books", bookId);
  const sourceDestination = createSafeProjectPath(
    input.project.rootPath,
    "assets",
    "books",
    bookId,
    assetLayout.sourceDirectoryName,
    assetLayout.sourceFileName
  );
  const plannedChapterAssets = parsedChapters.map((parsedChapter) => ({
    parsedChapter,
    path: createSafeProjectPath(
      input.project.rootPath,
      "assets",
      "books",
      bookId,
      assetLayout.chapterDirectoryName,
      assetLayout.chapterFileName(parsedChapter)
    )
  }));
  assertNoAssetPathCollisions(sourceDestination, plannedChapterAssets.map((chapterAsset) => chapterAsset.path));

  const sourceDirectory = createSafeProjectPath(
    input.project.rootPath,
    "assets",
    "books",
    bookId,
    assetLayout.sourceDirectoryName
  );
  const chapterDirectory = createSafeProjectPath(
    input.project.rootPath,
    "assets",
    "books",
    bookId,
    assetLayout.chapterDirectoryName
  );

  let createdBookRoot = false;

  try {
    await fs.mkdir(booksRoot, { recursive: true });
    await createNewDirectory(bookRoot);
    createdBookRoot = true;
    await fs.mkdir(sourceDirectory, { recursive: true });
    await fs.mkdir(chapterDirectory, { recursive: true });

    await copyFileExclusively(input.sourcePath, sourceDestination);
    const sourceRelativePath = toSafeRelativePath(input.project.rootPath, sourceDestination);

    const chapters: Chapter[] = [];
    for (const { parsedChapter, path: chapterPath } of plannedChapterAssets) {
      await writeFileExclusively(chapterPath, parsedChapter.content);
      chapters.push({
        id: idGenerator.createId("chapter"),
        bookId,
        index: parsedChapter.index,
        title: parsedChapter.title,
        textPath: toSafeRelativePath(input.project.rootPath, chapterPath)
      });
    }

    const book: Book = {
      id: bookId,
      projectId: input.project.id,
      displayName: normalizeDisplayName(
        input.displayName ?? path.basename(input.sourcePath, path.extname(input.sourcePath))
      ),
      sourceAssetId,
      sourceTextPath: sourceRelativePath,
      chapterCount: chapters.length,
      createdAt: now
    };

    const saved = await input.repository.saveUploadedBook({ book, chapters });

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

function assertNoAssetPathCollisions(sourceDestination: string, chapterPaths: string[]): void {
  const seenDestinations = new Map<string, string>();
  const destinations = [
    { role: "source", path: sourceDestination },
    ...chapterPaths.map((chapterPath, index) => ({ role: `chapter ${index}`, path: chapterPath }))
  ];

  for (const destination of destinations) {
    const key = getAssetPathCollisionKey(destination.path);
    const existingRole = seenDestinations.get(key);
    if (existingRole) {
      throw new UploadBookError(
        "BOOK_ASSET_PATH_COLLISION",
        `Book asset path collision between ${existingRole} and ${destination.role}: ${destination.path}`
      );
    }

    seenDestinations.set(key, destination.role);
  }
}

function getAssetPathCollisionKey(targetPath: string): string {
  let normalizedPath: string;

  try {
    normalizedPath = realpathSync.native(targetPath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
    normalizedPath = path.resolve(targetPath);
  }

  const normalized = path.normalize(normalizedPath).normalize("NFC");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function copyFileExclusively(sourcePath: string, destinationPath: string): Promise<void> {
  try {
    await fs.copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    throwIfAssetAlreadyExists(error, destinationPath);
    throw error;
  }
}

async function writeFileExclusively(destinationPath: string, content: string): Promise<void> {
  try {
    await fs.writeFile(destinationPath, content, { encoding: "utf8", flag: "wx" });
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

function assertTxtSource(sourcePath: string): void {
  if (path.extname(sourcePath).toLowerCase() !== ".txt") {
    throw new UploadBookError("UNSUPPORTED_FILE_EXTENSION", "Only .txt novel sources can be uploaded");
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
