import fs from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { classifyToolEffects, isWriteTool, type BuiltinToolName } from "./toolPolicy";
import { BashJobManager } from "./reasonix/bashJobs";
import { PathResolver, resolveReadablePath } from "./reasonix/pathResolver";
import type { ReasonixShellConfig } from "./reasonix/workspace";
import { Workspace } from "./reasonix/workspace";
import { createReadFileTool } from "./reasonix/tools/readFileTool";
import { createWriteFileTool } from "./reasonix/tools/writeFileTool";
import { createEditFileTool } from "./reasonix/tools/editFileTool";
import { createMultiEditTool } from "./reasonix/tools/multiEditTool";
import { createGrepTool } from "./reasonix/tools/grepTool";
import { createGlobTool } from "./reasonix/tools/globTool";
import { createLsTool } from "./reasonix/tools/lsTool";
import {
  createBashOutputTool,
  createBashTool,
  createKillShellTool,
  createWaitTool
} from "./reasonix/tools/bashTool";
import { findRelevantReportExcerpt } from "./reportRelevantExcerpt";
import {
  upsertReportSection,
  type ReportWriteMode
} from "./reportSectionIndex";

export interface ToolExecutionContext {
  projectRoot: string;
  reportsRoot: string;
  maxReadBytes?: number;
  maxPreviewChars?: number;
  maxGrepFiles?: number;
  maxGrepTotalBytes?: number;
  maxGrepMatches?: number;
  ignoredDirectoryNames?: readonly string[];
  readAliasRoots?: ReadonlyArray<{ token: string; root: string }>;
  jobManager?: BashJobManager;
  sessionId?: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  bashTimeoutSeconds?: number;
  shell?: ReasonixShellConfig;
  allowedReportFileNames?: readonly string[];
}

export class ToolExecutionError extends Error {
  constructor(
    message: string,
    readonly code: "UNKNOWN_TOOL" | "INVALID_ARGUMENTS" | "UNSAFE_PATH" | "NOT_FOUND" | "IO_ERROR" | "SECTION_NOT_FOUND",
    readonly output?: string
  ) {
    super(message);
    this.name = "ToolExecutionError";
  }
}

const MARK_NO_UPDATE_TOOL_NAME = "mark_no_update";
const DEFAULT_MAX_READ_BYTES = 1024 * 1024;

export async function executeBuiltinFileTool(name: string, rawArguments: unknown, context: ToolExecutionContext): Promise<string> {
  try {
    classifyToolEffects(name);
  } catch (error) {
    throw toToolError(error, "UNKNOWN_TOOL");
  }

  try {
    if (name === MARK_NO_UPDATE_TOOL_NAME) {
      return executeMarkNoUpdate(rawArguments, context);
    }

    if (name === "read_report_excerpt") {
      return executeReadReportExcerpt(rawArguments, context);
    }

    if (name === "upsert_report_section") {
      return executeUpsertReportSection(rawArguments, context);
    }

    const workspace = createReasonixWorkspace(context);
    const tool = createReasonixTool(name as BuiltinToolName, workspace);
    const executionArguments = normalizeReasonixArguments(name, rawArguments, context);
    validateReadBudget(name, executionArguments, context, workspace);

    return await tool.execute(executionArguments, {
      jobManager: context.jobManager,
      sessionId: context.sessionId,
      signal: context.signal,
      env: context.env
    });
  } catch (error) {
    throw toToolError(error, "IO_ERROR");
  }
}

async function executeUpsertReportSection(rawArguments: unknown, context: ToolExecutionContext): Promise<string> {
  const args = parseObjectArgument(rawArguments);
  if (args === undefined) {
    throw new ToolExecutionError("Tool arguments must be an object", "INVALID_ARGUMENTS");
  }
  assertAllowedUpsertReportSectionArguments(args);

  if (typeof args.outputFileName !== "string") {
    throw new ToolExecutionError("outputFileName must be a string", "INVALID_ARGUMENTS");
  }
  if (typeof args.content !== "string") {
    throw new ToolExecutionError("content must be a string", "INVALID_ARGUMENTS");
  }

  const writeMode = normalizeReportWriteMode(args.writeMode);
  const sectionId = typeof args.sectionId === "string" ? args.sectionId : undefined;
  if ((writeMode === "replace_section" || writeMode === "append_to_section") && (!sectionId || sectionId.trim() === "")) {
    throw new ToolExecutionError("sectionId must be a non-empty string for replace_section and append_to_section", "INVALID_ARGUMENTS");
  }

  const outputFileName = validateFlatReportFileName(args.outputFileName);
  if (context.allowedReportFileNames !== undefined && !context.allowedReportFileNames.includes(outputFileName)) {
    throw new ToolExecutionError("Path is outside allowed root", "UNSAFE_PATH");
  }

  assertReportsRootInsideProject(context);
  fs.mkdirSync(context.reportsRoot, { recursive: true });
  const reportPath = path.join(context.reportsRoot, outputFileName);
  assertReportPathInsideReportsRoot(context.reportsRoot, reportPath);
  await assertExistingReportFileIsSafe(reportPath);

  const currentContent = await readReportFileIfExists(reportPath);
  const result = upsertReportSection({
    content: currentContent,
    sectionId,
    writeMode,
    nextContent: args.content
  });
  if (!result.ok) {
    throw new ToolExecutionError(result.message, result.code);
  }

  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, result.content, "utf8");
  return `upserted report section ${sectionId ?? "(end)"} in ${outputFileName} with ${writeMode}`;
}

function assertAllowedUpsertReportSectionArguments(args: Record<string, unknown>): void {
  if (Object.prototype.hasOwnProperty.call(args, "old_string")) {
    throw new ToolExecutionError(
      "upsert_report_section does not accept old_string; use section id and writeMode instead.",
      "INVALID_ARGUMENTS"
    );
  }

  const allowedKeys = new Set(["outputFileName", "sectionId", "content", "writeMode"]);
  const extraKeys = Object.keys(args).filter((key) => !allowedKeys.has(key));
  if (extraKeys.length > 0) {
    throw new ToolExecutionError(`upsert_report_section received unsupported argument(s): ${extraKeys.join(", ")}`, "INVALID_ARGUMENTS");
  }
}

function normalizeReportWriteMode(value: unknown): ReportWriteMode {
  if (value === "replace_section" || value === "append_to_section" || value === "append_to_end") {
    return value;
  }
  throw new ToolExecutionError("writeMode must be replace_section, append_to_section, or append_to_end", "INVALID_ARGUMENTS");
}

async function readReportFileIfExists(reportPath: string): Promise<string> {
  try {
    return await readFile(reportPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function assertExistingReportFileIsSafe(reportPath: string): Promise<void> {
  try {
    const stat = await fs.promises.lstat(reportPath);
    if (!stat.isFile()) {
      throw new ToolExecutionError("Path is outside allowed root", "UNSAFE_PATH");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function executeReadReportExcerpt(rawArguments: unknown, context: ToolExecutionContext): Promise<string> {
  const args = parseObjectArgument(rawArguments);
  if (args === undefined) {
    throw new ToolExecutionError("Tool arguments must be an object", "INVALID_ARGUMENTS");
  }
  assertAllowedReadReportExcerptArguments(args);

  if (typeof args.outputFileName !== "string") {
    throw new ToolExecutionError("outputFileName must be a string", "INVALID_ARGUMENTS");
  }
  if (!Array.isArray(args.keywords)) {
    throw new ToolExecutionError("keywords must be an array", "INVALID_ARGUMENTS");
  }

  const outputFileName = validateFlatReportFileName(args.outputFileName);
  const keywords = args.keywords.map((keyword) => (typeof keyword === "string" ? keyword.trim() : ""));
  if (keywords.length === 0 || keywords.some((keyword) => keyword === "")) {
    throw new ToolExecutionError("keywords must contain non-empty strings", "INVALID_ARGUMENTS");
  }

  if (context.allowedReportFileNames !== undefined && !context.allowedReportFileNames.includes(outputFileName)) {
    throw new ToolExecutionError("Path is outside allowed root", "UNSAFE_PATH");
  }

  const maxChars = normalizeMaxChars(args.maxChars);
  const reportPath = path.join(context.reportsRoot, outputFileName);
  assertReportPathInsideReportsRoot(context.reportsRoot, reportPath);
  if (fs.existsSync(reportPath)) {
    assertInsideRoot(fs.realpathSync.native(context.reportsRoot), fs.realpathSync.native(reportPath));
  }

  return JSON.stringify(
    await findRelevantReportExcerpt({
      outputFileName,
      reportPath,
      keywords,
      maxChars
    })
  );
}

function assertAllowedReadReportExcerptArguments(args: Record<string, unknown>): void {
  const allowedKeys = new Set(["outputFileName", "keywords", "maxChars"]);
  const extraKeys = Object.keys(args).filter((key) => !allowedKeys.has(key));
  if (extraKeys.length > 0) {
    throw new ToolExecutionError(`read_report_excerpt received unsupported argument(s): ${extraKeys.join(", ")}`, "INVALID_ARGUMENTS");
  }
}

function normalizeMaxChars(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolExecutionError("maxChars must be a number", "INVALID_ARGUMENTS");
  }
  return Math.floor(value);
}

function createReasonixWorkspace(context: ToolExecutionContext): Workspace {
  const readPaths = new PathResolver();
  const reportsRootToken = toProjectRelativeReportsRootPath(context);
  readPaths.registerReadRoot(reportsRootToken, context.reportsRoot);
  readPaths.registerReadRoot("reports", context.reportsRoot);

  for (const alias of context.readAliasRoots ?? []) {
    readPaths.registerReadRoot(alias.token, alias.root);
  }

  return new Workspace({
    dir: context.projectRoot,
    writeRoots: [context.reportsRoot],
    readPaths,
    bashTimeoutSeconds: context.bashTimeoutSeconds,
    shell: context.shell
  });
}

function createReasonixTool(name: BuiltinToolName, workspace: Workspace) {
  switch (name) {
    case "read_file":
      return createReadFileTool(workspace);
    case "write_file":
      return createWriteFileTool(workspace);
    case "edit_file":
      return createEditFileTool(workspace);
    case "multi_edit":
      return createMultiEditTool(workspace);
    case "grep":
      return createGrepTool(workspace);
    case "glob":
      return createGlobTool(workspace);
    case "ls":
      return createLsTool(workspace);
    case "bash":
      return createBashTool(workspace);
    case "bash_output":
      return createBashOutputTool(workspace);
    case "wait":
      return createWaitTool(workspace);
    case "kill_shell":
      return createKillShellTool(workspace);
    default:
      throw new ToolExecutionError(`Unknown tool: ${name}`, "UNKNOWN_TOOL");
  }
}

function normalizeReasonixArguments(name: string, rawArguments: unknown, context: ToolExecutionContext): unknown {
  if (!isWriteTool(name)) {
    return rawArguments;
  }

  const args = parseObjectArgument(rawArguments);
  if (args === undefined || typeof args.path !== "string") {
    return rawArguments;
  }

  return {
    ...args,
    path: toProjectRelativeReportPath(context, args.path)
  };
}

function executeMarkNoUpdate(rawArguments: unknown, context: ToolExecutionContext): string {
  const args = parseObjectArgument(rawArguments);
  if (args === undefined) {
    throw new ToolExecutionError("Tool arguments must be an object", "INVALID_ARGUMENTS");
  }

  if (typeof args.path !== "string") {
    throw new ToolExecutionError("path must be a string", "INVALID_ARGUMENTS");
  }
  if (typeof args.reason !== "string") {
    throw new ToolExecutionError("reason must be a string", "INVALID_ARGUMENTS");
  }

  const reportFileName = toReportFileName(context, args.path);
  return `marked no update for ${reportFileName}: ${args.reason}`;
}

function parseObjectArgument(rawArguments: unknown): Record<string, unknown> | undefined {
  if (typeof rawArguments === "string") {
    try {
      const parsed = JSON.parse(rawArguments) as unknown;
      return isPlainRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  return isPlainRecord(rawArguments) ? rawArguments : undefined;
}

function validateReadBudget(name: string, rawArguments: unknown, context: ToolExecutionContext, workspace: Workspace): void {
  if (name !== "read_file") {
    return;
  }

  const args = parseObjectArgument(rawArguments);
  if (args === undefined || typeof args.path !== "string") {
    return;
  }

  const maxReadBytes = context.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  const resolved = resolveReadablePath(workspace.dir, args.path, workspace.readPaths);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved.path);
  } catch {
    return;
  }

  if (stat.isFile() && stat.size > maxReadBytes) {
    throw new ToolExecutionError("File is larger than maxReadBytes", "INVALID_ARGUMENTS");
  }
}

function toProjectRelativeReportsRootPath(context: ToolExecutionContext): string {
  assertReportsRootInsideProject(context);
  return path.relative(fs.realpathSync.native(context.projectRoot), fs.realpathSync.native(context.reportsRoot)).replace(/\\/g, "/");
}

function toProjectRelativeReportPath(context: ToolExecutionContext, inputPath: string): string {
  const reportFileName = toReportFileName(context, inputPath);
  return `${toProjectRelativeReportsRootPath(context)}/${reportFileName}`;
}

function toReportFileName(context: ToolExecutionContext, inputPath: string): string {
  const comparablePath = inputPath.replace(/\\/g, "/").replace(/^(?:\.\/)+/u, "");
  const reportsRootPath = toProjectRelativeReportsRootPath(context);
  const reportsRootPrefix = `${reportsRootPath}/`;
  const reportFileName =
    comparablePath.startsWith(reportsRootPrefix)
      ? comparablePath.slice(reportsRootPrefix.length)
      : comparablePath.startsWith("reports/")
        ? comparablePath.slice("reports/".length)
        : comparablePath;

  return validateFlatReportFileName(reportFileName);
}

function validateFlatReportFileName(reportFileName: string): string {
  const normalized = reportFileName.normalize("NFC");
  if (
    normalized === "" ||
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("\0") ||
    /[\\/]/u.test(normalized) ||
    /^[A-Za-z]:/u.test(normalized) ||
    path.win32.isAbsolute(normalized) ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new ToolExecutionError("Path is outside allowed root", "UNSAFE_PATH");
  }

  return normalized;
}

function assertReportPathInsideReportsRoot(reportsRoot: string, reportPath: string): void {
  assertInsideRoot(path.resolve(reportsRoot), path.resolve(reportPath));
}

function assertReportsRootInsideProject(context: ToolExecutionContext): void {
  const projectRootRealPath = fs.realpathSync.native(context.projectRoot);
  const reportsRootRealPath = resolveExistingOrFutureRealPath(context.reportsRoot);
  assertInsideRoot(projectRootRealPath, reportsRootRealPath);
}

function resolveExistingOrFutureRealPath(targetPath: string): string {
  const absoluteTargetPath = path.resolve(targetPath);
  if (fs.existsSync(absoluteTargetPath)) {
    return fs.realpathSync.native(absoluteTargetPath);
  }

  let existingAncestor = absoluteTargetPath;
  const missingSegments: string[] = [];
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      return absoluteTargetPath;
    }
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }

  return path.join(fs.realpathSync.native(existingAncestor), ...missingSegments);
}

function assertInsideRoot(rootRealPath: string, targetPath: string): void {
  const relativePath = path.relative(rootRealPath, targetPath);
  const escapesRoot = relativePath !== "" && (path.isAbsolute(relativePath) || relativePath.split(path.sep).includes(".."));
  if (escapesRoot) {
    throw new ToolExecutionError("Path is outside allowed root", "UNSAFE_PATH");
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toToolError(error: unknown, fallbackCode: ToolExecutionError["code"]): ToolExecutionError {
  if (error instanceof ToolExecutionError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  const output = error instanceof Error && "output" in error && typeof error.output === "string" ? error.output : undefined;
  if (/^Unknown tool: /u.test(message)) {
    return new ToolExecutionError(message, "UNKNOWN_TOOL", output);
  }
  if (isUnsafePathMessage(message)) {
    return new ToolExecutionError(message, "UNSAFE_PATH", output);
  }
  if (isNotFoundMessage(message)) {
    return new ToolExecutionError("Path does not exist", "NOT_FOUND", output);
  }
  if (isInvalidArgumentMessage(message)) {
    return new ToolExecutionError(message, "INVALID_ARGUMENTS", output);
  }

  return new ToolExecutionError(message, fallbackCode, output);
}

function isUnsafePathMessage(message: string): boolean {
  return /outside (?:the )?(?:writable roots|allowed root)|outside writable roots|path is outside/iu.test(message);
}

function isNotFoundMessage(message: string): boolean {
  return /\bENOENT\b|no such file or directory|file does not exist/iu.test(message);
}

function isInvalidArgumentMessage(message: string): boolean {
  return (
    message.startsWith("invalid args:") ||
    message === "path is required" ||
    message === "old_string is required" ||
    message === "edits must not be empty" ||
    message.includes(" is a directory, not a file") ||
    /^old_string (?:not found|is not unique)\b/u.test(message) ||
    /^edit \d+: old_string (?:not found|is not unique|required)\b/u.test(message) ||
    /^invalid pattern:/u.test(message)
  );
}
