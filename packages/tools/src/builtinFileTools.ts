import fs from "node:fs";
import path from "node:path";
import { createReportWriter, ReportWriterError } from "@novel-extractor/markdown/reportWriter";
import { classifyToolEffects, type BuiltinToolName } from "./toolPolicy";

export interface ToolExecutionContext {
  projectRoot: string;
  reportsRoot: string;
  maxReadBytes?: number;
  maxPreviewChars?: number;
  maxGrepFiles?: number;
  maxGrepTotalBytes?: number;
  maxGrepMatches?: number;
  ignoredDirectoryNames?: readonly string[];
}

export interface ToolWriteSummary {
  path: string;
  operation: "write_file" | "edit_file" | "multi_edit";
  changedBytes: number;
  preview: string;
}

export interface LsResult {
  path: string;
  entries: Array<{ name: string; type: "file" | "directory" }>;
}

export interface ReadFileResult {
  path: string;
  content: string;
}

export interface GrepResult {
  path: string;
  pattern: string;
  matches: Array<{ path: string; line: number; text: string }>;
}

export class ToolExecutionError extends Error {
  constructor(
    message: string,
    readonly code: "UNKNOWN_TOOL" | "INVALID_ARGUMENTS" | "UNSAFE_PATH" | "NOT_FOUND" | "IO_ERROR"
  ) {
    super(message);
    this.name = "ToolExecutionError";
  }
}

type ToolResult = LsResult | ReadFileResult | GrepResult | ToolWriteSummary;

const DEFAULT_MAX_READ_BYTES = 1024 * 1024;
const DEFAULT_MAX_GREP_FILES = 5000;
const DEFAULT_MAX_GREP_TOTAL_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_GREP_MATCHES = 1000;
const DEFAULT_IGNORED_DIRECTORY_NAMES = [".git", "node_modules", "dist", "build", "coverage", ".next", ".turbo", "out"] as const;

export async function executeBuiltinFileTool(name: string, rawArguments: unknown, context: ToolExecutionContext): Promise<ToolResult> {
  try {
    classifyToolEffects(name);
  } catch (error) {
    throw toToolError(error, "UNKNOWN_TOOL");
  }

  try {
    switch (name as BuiltinToolName) {
      case "ls":
        return executeLs(rawArguments, context);
      case "read_file":
        return executeReadFile(rawArguments, context);
      case "grep":
        return executeGrep(rawArguments, context);
      case "write_file":
        return executeWriteFile(rawArguments, context);
      case "edit_file":
        return executeEditFile(rawArguments, context);
      case "multi_edit":
        return executeMultiEdit(rawArguments, context);
    }
  } catch (error) {
    throw toToolError(error, "IO_ERROR");
  }
}

function executeLs(rawArguments: unknown, context: ToolExecutionContext): LsResult {
  const args = parseArgs(rawArguments, ["path"]);
  const targetPath = resolveProjectPath(context.projectRoot, args.path);
  const stat = statExisting(targetPath);
  if (!stat.isDirectory()) {
    throw new ToolExecutionError("ls path must be a directory", "INVALID_ARGUMENTS");
  }

  const entries = fs
    .readdirSync(targetPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() || entry.isDirectory())
    .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? ("directory" as const) : ("file" as const) }))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));

  return { path: normalizeRelativeForOutput(args.path), entries };
}

function executeReadFile(rawArguments: unknown, context: ToolExecutionContext): ReadFileResult {
  const args = parseArgs(rawArguments, ["path"]);
  const targetPath = resolveProjectPath(context.projectRoot, args.path);
  const stat = statExisting(targetPath);
  if (!stat.isFile()) {
    throw new ToolExecutionError("read_file path must be a file", "INVALID_ARGUMENTS");
  }

  const maxReadBytes = context.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  if (stat.size > maxReadBytes) {
    throw new ToolExecutionError("File is larger than maxReadBytes", "INVALID_ARGUMENTS");
  }

  return { path: normalizeRelativeForOutput(args.path), content: fs.readFileSync(targetPath, "utf8") };
}

function executeGrep(rawArguments: unknown, context: ToolExecutionContext): GrepResult {
  const args = parseArgs(rawArguments, ["path", "pattern"]);
  if (args.pattern === "") {
    throw new ToolExecutionError("pattern must not be empty", "INVALID_ARGUMENTS");
  }

  const targetPath = resolveProjectPath(context.projectRoot, args.path);
  const stat = statExisting(targetPath);
  const maxReadBytes = getPositiveIntegerBudget(context.maxReadBytes, DEFAULT_MAX_READ_BYTES, "maxReadBytes");
  const maxGrepFiles = getPositiveIntegerBudget(context.maxGrepFiles, DEFAULT_MAX_GREP_FILES, "maxGrepFiles");
  const maxGrepTotalBytes = getPositiveIntegerBudget(context.maxGrepTotalBytes, DEFAULT_MAX_GREP_TOTAL_BYTES, "maxGrepTotalBytes");
  const maxGrepMatches = getPositiveIntegerBudget(context.maxGrepMatches, DEFAULT_MAX_GREP_MATCHES, "maxGrepMatches");
  const ignoredDirectoryNames = new Set(context.ignoredDirectoryNames ?? DEFAULT_IGNORED_DIRECTORY_NAMES);
  const files = stat.isDirectory()
    ? collectFiles(targetPath, { maxFiles: maxGrepFiles, maxTotalBytes: maxGrepTotalBytes, ignoredDirectoryNames })
    : [{ path: targetPath, size: stat.size }];
  const projectRoot = fs.realpathSync.native(context.projectRoot);
  const maxPreviewChars = context.maxPreviewChars ?? 240;
  const matches: GrepResult["matches"] = [];

  for (const file of files) {
    if (file.size > maxReadBytes) {
      throw new ToolExecutionError("File is larger than maxReadBytes", "INVALID_ARGUMENTS");
    }
    if (file.size > maxGrepTotalBytes) {
      throw new ToolExecutionError("grep total byte budget exceeded", "INVALID_ARGUMENTS");
    }

    const content = fs.readFileSync(file.path, "utf8");
    const lines = content.split(/\r?\n/u);
    lines.forEach((line, index) => {
      if (line.includes(args.pattern)) {
        if (matches.length >= maxGrepMatches) {
          throw new ToolExecutionError("grep match budget exceeded", "INVALID_ARGUMENTS");
        }
        matches.push({
          path: path.relative(projectRoot, file.path).replace(/\\/g, "/"),
          line: index + 1,
          text: line.slice(0, maxPreviewChars)
        });
      }
    });
  }

  return { path: normalizeRelativeForOutput(args.path), pattern: args.pattern, matches };
}

function executeWriteFile(rawArguments: unknown, context: ToolExecutionContext): ToolWriteSummary {
  const args = parseArgs(rawArguments, ["path", "content"]);
  assertReportsRootInsideProject(context);
  const writer = createReportWriter({ reportsRoot: context.reportsRoot, previewLimit: context.maxPreviewChars });
  const result = writer.writeReport({ path: args.path, content: args.content });
  return toSummary(result.relativePath, "write_file", result.changedBytes, result.preview);
}

function executeEditFile(rawArguments: unknown, context: ToolExecutionContext): ToolWriteSummary {
  const args = parseArgs(rawArguments, ["path", "oldText", "newText"]);
  assertReportsRootInsideProject(context);
  const writer = createReportWriter({ reportsRoot: context.reportsRoot, previewLimit: context.maxPreviewChars });
  const result = writer.replaceText({ path: args.path, oldText: args.oldText, newText: args.newText });
  return toSummary(result.relativePath, "edit_file", result.changedBytes, result.preview);
}

function executeMultiEdit(rawArguments: unknown, context: ToolExecutionContext): ToolWriteSummary {
  const args = parseArgs(rawArguments, ["path"], ["edits"]);
  const edits = getRawProperty(rawArguments, "edits");
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new ToolExecutionError("edits must be a non-empty array", "INVALID_ARGUMENTS");
  }

  const parsedEdits = edits.map((edit) => parseArgs(edit, ["oldText", "newText"]));
  assertReportsRootInsideProject(context);
  const writer = createReportWriter({ reportsRoot: context.reportsRoot, previewLimit: context.maxPreviewChars });
  const result = writer.applyMultiEdit({
    path: args.path,
    edits: parsedEdits.map((edit) => ({ path: args.path, oldText: edit.oldText, newText: edit.newText }))
  });

  return toSummary(result.relativePath, "multi_edit", result.changedBytes, result.preview);
}

function toSummary(pathName: string, operation: ToolWriteSummary["operation"], changedBytes: number, preview: string): ToolWriteSummary {
  return {
    path: pathName,
    operation,
    changedBytes,
    preview
  };
}

function parseArgs(rawArguments: unknown, requiredKeys: string[], allowedExtraKeys: string[] = []): Record<string, string> {
  if (typeof rawArguments !== "object" || rawArguments === null || Array.isArray(rawArguments)) {
    throw new ToolExecutionError("Tool arguments must be an object", "INVALID_ARGUMENTS");
  }

  const record = rawArguments as Record<string, unknown>;
  const allowedKeys = new Set([...requiredKeys, ...allowedExtraKeys]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new ToolExecutionError(`Unexpected argument: ${key}`, "INVALID_ARGUMENTS");
    }
  }

  const parsed: Record<string, string> = {};
  for (const key of requiredKeys) {
    const value = record[key];
    if (typeof value !== "string") {
      throw new ToolExecutionError(`${key} must be a string`, "INVALID_ARGUMENTS");
    }
    parsed[key] = value;
  }

  return parsed;
}

function assertReportsRootInsideProject(context: ToolExecutionContext): void {
  const projectRootRealPath = fs.realpathSync.native(context.projectRoot);
  const reportsRootRealPath = fs.realpathSync.native(context.reportsRoot);
  assertInsideRoot(projectRootRealPath, reportsRootRealPath);
}

function getRawProperty(rawArguments: unknown, key: string): unknown {
  if (typeof rawArguments !== "object" || rawArguments === null || Array.isArray(rawArguments)) {
    throw new ToolExecutionError("Tool arguments must be an object", "INVALID_ARGUMENTS");
  }

  return (rawArguments as Record<string, unknown>)[key];
}

function resolveProjectPath(root: string, relativePath: string): string {
  const rootRealPath = fs.realpathSync.native(root);
  const safeRelativePath = validateProjectRelativePath(relativePath);
  const candidatePath = path.resolve(rootRealPath, safeRelativePath);
  assertInsideRoot(rootRealPath, candidatePath);
  if (!fs.existsSync(candidatePath)) {
    return candidatePath;
  }

  const realPath = fs.realpathSync.native(candidatePath);
  assertInsideRoot(rootRealPath, realPath);
  return realPath;
}

function validateProjectRelativePath(candidate: string): string {
  if (candidate === ".") {
    return ".";
  }

  if (candidate === "" || candidate.includes("\0")) {
    throw new ToolExecutionError("path must not be empty", "UNSAFE_PATH");
  }

  if (/^[A-Za-z]:/u.test(candidate) || path.win32.isAbsolute(candidate) || path.posix.isAbsolute(candidate)) {
    throw new ToolExecutionError("Absolute paths are not allowed", "UNSAFE_PATH");
  }

  const parts = candidate.replace(/\\/g, "/").split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new ToolExecutionError("Path must be relative and stay inside project root", "UNSAFE_PATH");
  }

  return parts.join(path.sep);
}

function statExisting(targetPath: string): fs.Stats {
  try {
    return fs.statSync(targetPath);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
    if (code === "ENOENT") {
      throw new ToolExecutionError("Path does not exist", "NOT_FOUND");
    }
    throw toToolError(error, "IO_ERROR");
  }
}

interface GrepCollectionBudget {
  maxFiles: number;
  maxTotalBytes: number;
  ignoredDirectoryNames: ReadonlySet<string>;
}

function collectFiles(root: string, budget: GrepCollectionBudget): Array<{ path: string; size: number }> {
  const files: Array<{ path: string; size: number }> = [];
  const pendingDirectories = [root];
  let totalBytes = 0;

  while (pendingDirectories.length > 0) {
    const currentDirectory = pendingDirectories.pop() ?? root;
    for (const entry of fs.readdirSync(currentDirectory, { withFileTypes: true })) {
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        if (!budget.ignoredDirectoryNames.has(entry.name)) {
          pendingDirectories.push(entryPath);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const fileStat = statExisting(entryPath);
      if (files.length >= budget.maxFiles) {
        throw new ToolExecutionError("grep file budget exceeded", "INVALID_ARGUMENTS");
      }
      totalBytes += fileStat.size;
      if (totalBytes > budget.maxTotalBytes) {
        throw new ToolExecutionError("grep total byte budget exceeded", "INVALID_ARGUMENTS");
      }
      files.push({ path: entryPath, size: fileStat.size });
    }
  }

  return files;
}

function assertInsideRoot(rootRealPath: string, targetPath: string): void {
  const relativePath = path.relative(rootRealPath, targetPath);
  const escapesRoot = relativePath !== "" && (path.isAbsolute(relativePath) || relativePath.split(path.sep).includes(".."));
  if (escapesRoot) {
    throw new ToolExecutionError("Path is outside allowed root", "UNSAFE_PATH");
  }
}

function normalizeRelativeForOutput(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

function getPositiveIntegerBudget(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ToolExecutionError(`${label} must be a positive integer`, "INVALID_ARGUMENTS");
  }
  return value;
}

function toToolError(error: unknown, fallbackCode: ToolExecutionError["code"]): ToolExecutionError {
  if (error instanceof ToolExecutionError) {
    return error;
  }
  if (error instanceof ReportWriterError) {
    if (isFileNotFoundError(error)) {
      return new ToolExecutionError("Path does not exist", "NOT_FOUND");
    }
    return new ToolExecutionError(error.message, error.code === "UNSAFE_PATH" ? "UNSAFE_PATH" : "INVALID_ARGUMENTS");
  }
  if (isFileNotFoundError(error)) {
    return new ToolExecutionError("Path does not exist", "NOT_FOUND");
  }
  return new ToolExecutionError(error instanceof Error ? error.message : "Tool execution failed", fallbackCode);
}

function isFileNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || /\bENOENT\b|no such file or directory/iu.test(error.message);
}
