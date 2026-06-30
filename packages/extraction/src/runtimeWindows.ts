import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ChapterParseError, parseChapters, type ParsedChapter } from "./chapterParser";
import { ChapterWindowPlanningError, planChapterWindows } from "./windowPlanner";

const DEFAULT_SPLITTER_VERSION = "ts-window-planner-v1";
const CHAPTER_PARSER_VERSION = "builtin-heading-v1";

export type RuntimeWindowGenerationErrorCode = "INVALID_INPUT" | "NO_CHAPTERS" | "SOURCE_OUTSIDE_PROJECT";

export class RuntimeWindowGenerationError extends Error {
  readonly code: RuntimeWindowGenerationErrorCode;

  constructor(code: RuntimeWindowGenerationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeWindowGenerationError";
    this.code = code;
  }
}

export interface GenerateRuntimeWindowsInput {
  projectRoot: string;
  jobId: string;
  bookId: string;
  sourceTextPath: string;
  singleRunChapterCount: number;
  overlapChapterCount: number;
  extractionChapterCount: number;
  splitterVersion?: string;
  generatedAt?: string;
}

export interface RuntimeWindowManifestWindow {
  windowId: string;
  index: number;
  fileName: string;
  textPath: string;
  windowHash: string;
  contextChapterRange: string;
  submittedChapterRange: string;
  contextChapterTitles: string[];
  submittedChapterTitles: string[];
  characterCount: number;
}

export interface RuntimeWindowManifest {
  jobId: string;
  bookId: string;
  sourceTextPath: string;
  sourceTextHash: string;
  splitConfigHash: string;
  splitterVersion: string;
  generatedAt: string;
  totalDetectedChapterCount: number;
  windows: RuntimeWindowManifestWindow[];
}

export interface GenerateRuntimeWindowsResult {
  manifest: RuntimeWindowManifest;
  manifestPath: string;
  windowsRoot: string;
}

export async function generateRuntimeWindows(input: GenerateRuntimeWindowsInput): Promise<GenerateRuntimeWindowsResult> {
  const normalizedInput = normalizeInput(input);
  const sourceText = await readFile(normalizedInput.sourceTextAbsolutePath, "utf8");
  const sourceTextHash = sha256(sourceText);
  const splitConfigHash = hashSplitConfig(normalizedInput);
  const manifestPath = path.join(normalizedInput.windowsRoot, "manifest.json");
  const reusableManifest = await readReusableManifest(
    manifestPath,
    {
      sourceTextHash,
      splitConfigHash,
      splitterVersion: normalizedInput.splitterVersion
    },
    normalizedInput
  );

  if (reusableManifest) {
    return {
      manifest: reusableManifest,
      manifestPath,
      windowsRoot: normalizedInput.windowsRoot
    };
  }

  const chapters = parseRuntimeChapters(sourceText);
  const plannedWindows = planRuntimeWindows(
    chapters.map((chapter) => String(chapter.index + 1)),
    normalizedInput
  );

  await recreateWindowsDirectory(normalizedInput);

  const chapterById = new Map(chapters.map((chapter) => [String(chapter.index + 1), chapter]));
  const manifestWindows: RuntimeWindowManifestWindow[] = [];

  for (const plannedWindow of plannedWindows) {
    const contextChapters = getWindowChapters(chapterById, plannedWindow.contextChapterIds);
    const submittedChapters = getWindowChapters(chapterById, plannedWindow.commitChapterIds);
    const windowText = contextChapters.map(formatChapterText).join("\n\n");
    const fileName = `window-${String(plannedWindow.index + 1).padStart(4, "0")}.txt`;
    const textAbsolutePath = path.join(normalizedInput.windowsRoot, fileName);
    const textPath = toProjectRelativePath(normalizedInput.projectRoot, textAbsolutePath);

    await writeFile(textAbsolutePath, windowText, "utf8");

    manifestWindows.push({
      windowId: plannedWindow.windowId,
      index: plannedWindow.index,
      fileName,
      textPath,
      windowHash: sha256(windowText),
      contextChapterRange: plannedWindow.contextRange,
      submittedChapterRange: plannedWindow.commitRange,
      contextChapterTitles: contextChapters.map((chapter) => chapter.title),
      submittedChapterTitles: submittedChapters.map((chapter) => chapter.title),
      characterCount: windowText.length
    });
  }

  const manifest: RuntimeWindowManifest = {
    jobId: normalizedInput.jobId,
    bookId: normalizedInput.bookId,
    sourceTextPath: normalizedInput.sourceTextProjectPath,
    sourceTextHash,
    splitConfigHash,
    splitterVersion: normalizedInput.splitterVersion,
    generatedAt: normalizedInput.generatedAt,
    totalDetectedChapterCount: chapters.length,
    windows: manifestWindows
  };

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    manifest,
    manifestPath,
    windowsRoot: normalizedInput.windowsRoot
  };
}

interface NormalizedRuntimeWindowInput {
  projectRoot: string;
  jobId: string;
  bookId: string;
  sourceTextAbsolutePath: string;
  sourceTextProjectPath: string;
  singleRunChapterCount: number;
  overlapChapterCount: number;
  extractionChapterCount: number;
  splitterVersion: string;
  generatedAt: string;
  windowsRoot: string;
}

function normalizeInput(input: GenerateRuntimeWindowsInput): NormalizedRuntimeWindowInput {
  const projectRoot = path.resolve(input.projectRoot);
  const splitterVersion = input.splitterVersion ?? DEFAULT_SPLITTER_VERSION;

  assertNonEmpty(input.projectRoot, "Project root is required");
  assertSafePathSegment(input.jobId, "Job id must be a single path segment");
  assertNonEmpty(input.bookId, "Book id is required");
  assertNonEmpty(input.sourceTextPath, "Source text path is required");
  assertPositiveInteger(input.singleRunChapterCount, "singleRunChapterCount must be a positive integer");
  assertPositiveInteger(input.extractionChapterCount, "extractionChapterCount must be a positive integer");

  if (
    !Number.isInteger(input.overlapChapterCount) ||
    input.overlapChapterCount < 0 ||
    input.overlapChapterCount >= input.singleRunChapterCount
  ) {
    throw new RuntimeWindowGenerationError(
      "INVALID_INPUT",
      "overlapChapterCount must be a non-negative integer less than singleRunChapterCount"
    );
  }

  const sourceTextAbsolutePath = path.isAbsolute(input.sourceTextPath)
    ? path.resolve(input.sourceTextPath)
    : path.resolve(projectRoot, input.sourceTextPath);
  const sourceTextRelativePath = path.relative(projectRoot, sourceTextAbsolutePath);

  if (!isContainedRelativePath(sourceTextRelativePath)) {
    throw new RuntimeWindowGenerationError("SOURCE_OUTSIDE_PROJECT", "Source text path must be inside projectRoot");
  }

  const sourceTextProjectPath = sourceTextRelativePath.split(path.sep).join("/");
  const windowsRoot = path.join(projectRoot, "runs", input.jobId, "windows");

  return {
    projectRoot,
    jobId: input.jobId,
    bookId: input.bookId,
    sourceTextAbsolutePath,
    sourceTextProjectPath,
    singleRunChapterCount: input.singleRunChapterCount,
    overlapChapterCount: input.overlapChapterCount,
    extractionChapterCount: input.extractionChapterCount,
    splitterVersion,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    windowsRoot
  };
}

function parseRuntimeChapters(sourceText: string): ParsedChapter[] {
  try {
    const chapters = parseChapters(sourceText);

    if (chapters.length === 0) {
      throw new RuntimeWindowGenerationError("NO_CHAPTERS", "No chapters were detected in the source text");
    }

    return chapters;
  } catch (error) {
    if (error instanceof RuntimeWindowGenerationError) {
      throw error;
    }

    if (error instanceof ChapterParseError) {
      throw new RuntimeWindowGenerationError("NO_CHAPTERS", error.message, { cause: error });
    }

    throw error;
  }
}

function planRuntimeWindows(
  chapterIds: string[],
  input: NormalizedRuntimeWindowInput
): ReturnType<typeof planChapterWindows> {
  try {
    const windows = planChapterWindows({
      chapterIds,
      chaptersPerWindow: input.singleRunChapterCount,
      overlapChapterCount: input.overlapChapterCount,
      maxChapters: input.extractionChapterCount
    });

    if (windows.length === 0) {
      throw new RuntimeWindowGenerationError("NO_CHAPTERS", "No runtime windows were planned");
    }

    return windows;
  } catch (error) {
    if (error instanceof RuntimeWindowGenerationError) {
      throw error;
    }

    if (error instanceof ChapterWindowPlanningError) {
      throw new RuntimeWindowGenerationError("INVALID_INPUT", error.message, { cause: error });
    }

    throw error;
  }
}

async function readReusableManifest(
  manifestPath: string,
  expected: Pick<RuntimeWindowManifest, "sourceTextHash" | "splitConfigHash" | "splitterVersion">,
  input: Pick<NormalizedRuntimeWindowInput, "projectRoot" | "windowsRoot" | "jobId" | "bookId" | "sourceTextProjectPath">
): Promise<RuntimeWindowManifest | null> {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;

    if (
      isRuntimeWindowManifest(manifest) &&
      manifest.jobId === input.jobId &&
      manifest.bookId === input.bookId &&
      manifest.sourceTextPath === input.sourceTextProjectPath &&
      manifest.sourceTextHash === expected.sourceTextHash &&
      manifest.splitConfigHash === expected.splitConfigHash &&
      manifest.splitterVersion === expected.splitterVersion &&
      (await hasValidWindowFiles(manifest, input))
    ) {
      return manifest;
    }
  } catch {
    return null;
  }

  return null;
}

async function hasValidWindowFiles(
  manifest: RuntimeWindowManifest,
  input: Pick<NormalizedRuntimeWindowInput, "projectRoot" | "windowsRoot">
): Promise<boolean> {
  for (const window of manifest.windows) {
    if (!isSafePathSegmentValue(window.fileName)) {
      return false;
    }

    const textAbsolutePath = path.resolve(input.projectRoot, window.textPath);
    const fileNameAbsolutePath = path.resolve(input.windowsRoot, window.fileName);

    if (
      path.resolve(textAbsolutePath) !== path.resolve(fileNameAbsolutePath) ||
      !isPathInside(input.windowsRoot, textAbsolutePath)
    ) {
      return false;
    }

    const windowText = await readFile(textAbsolutePath, "utf8");

    if (sha256(windowText) !== window.windowHash) {
      return false;
    }
  }

  return true;
}

async function recreateWindowsDirectory(input: NormalizedRuntimeWindowInput): Promise<void> {
  const expectedWindowsRoot = path.join(input.projectRoot, "runs", input.jobId, "windows");

  if (path.resolve(input.windowsRoot) !== path.resolve(expectedWindowsRoot)) {
    throw new RuntimeWindowGenerationError("INVALID_INPUT", "Refusing to delete an unexpected windows directory");
  }

  await rm(input.windowsRoot, { force: true, recursive: true });
  await mkdir(input.windowsRoot, { recursive: true });
}

function getWindowChapters(chapterById: Map<string, ParsedChapter>, chapterIds: string[]): ParsedChapter[] {
  return chapterIds.map((chapterId) => {
    const chapter = chapterById.get(chapterId);

    if (!chapter) {
      throw new RuntimeWindowGenerationError("NO_CHAPTERS", `Chapter ${chapterId} was not found`);
    }

    return chapter;
  });
}

function formatChapterText(chapter: ParsedChapter): string {
  return `# ${chapter.title}\n\n${chapter.content}`;
}

function hashSplitConfig(input: NormalizedRuntimeWindowInput): string {
  return sha256(
    stableJson({
      chapterParser: CHAPTER_PARSER_VERSION,
      extractionChapterCount: input.extractionChapterCount,
      overlapChapterCount: input.overlapChapterCount,
      singleRunChapterCount: input.singleRunChapterCount,
      splitterVersion: input.splitterVersion
    })
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertNonEmpty(value: string, message: string): void {
  if (!value.trim()) {
    throw new RuntimeWindowGenerationError("INVALID_INPUT", message);
  }
}

function assertSafePathSegment(value: string, message: string): void {
  assertNonEmpty(value, message);

  if (!isSafePathSegmentValue(value)) {
    throw new RuntimeWindowGenerationError("INVALID_INPUT", message);
  }
}

function assertPositiveInteger(value: number, message: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RuntimeWindowGenerationError("INVALID_INPUT", message);
  }
}

function toProjectRelativePath(projectRoot: string, absolutePath: string): string {
  return path.relative(projectRoot, absolutePath).split(path.sep).join("/");
}

function isRuntimeWindowManifest(value: unknown): value is RuntimeWindowManifest {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isString(value.jobId) &&
    isString(value.bookId) &&
    isString(value.sourceTextPath) &&
    isString(value.sourceTextHash) &&
    isString(value.splitConfigHash) &&
    isString(value.splitterVersion) &&
    isString(value.generatedAt) &&
    isPositiveIntegerValue(value.totalDetectedChapterCount) &&
    Array.isArray(value.windows) &&
    value.windows.length > 0 &&
    value.windows.every(isRuntimeWindowManifestWindow)
  );
}

function isRuntimeWindowManifestWindow(value: unknown): value is RuntimeWindowManifestWindow {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isString(value.windowId) &&
    isNonNegativeInteger(value.index) &&
    isString(value.fileName) &&
    isString(value.textPath) &&
    isString(value.windowHash) &&
    /^[a-f0-9]{64}$/.test(value.windowHash) &&
    isString(value.contextChapterRange) &&
    isString(value.submittedChapterRange) &&
    isStringArray(value.contextChapterTitles) &&
    isStringArray(value.submittedChapterTitles) &&
    isNonNegativeInteger(value.characterCount)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isPositiveIntegerValue(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isSafePathSegmentValue(value: string): boolean {
  return value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\") && !value.includes("\0");
}

function isPathInside(parent: string, child: string): boolean {
  const relativePath = path.relative(parent, child);
  return relativePath !== "" && isContainedRelativePath(relativePath);
}

function isContainedRelativePath(relativePath: string): boolean {
  if (relativePath === "") {
    return true;
  }

  if (path.isAbsolute(relativePath)) {
    return false;
  }

  return relativePath.split(/[\\/]+/)[0] !== "..";
}
