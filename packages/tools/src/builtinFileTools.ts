import fs from "node:fs";
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

function assertReportsRootInsideProject(context: ToolExecutionContext): void {
  const projectRootRealPath = fs.realpathSync.native(context.projectRoot);
  const reportsRootRealPath = fs.realpathSync.native(context.reportsRoot);
  assertInsideRoot(projectRootRealPath, reportsRootRealPath);
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
  if (/^Unknown tool: /u.test(message)) {
    return new ToolExecutionError(message, "UNKNOWN_TOOL");
  }
  if (isUnsafePathMessage(message)) {
    return new ToolExecutionError(message, "UNSAFE_PATH");
  }
  if (isNotFoundMessage(message)) {
    return new ToolExecutionError("Path does not exist", "NOT_FOUND");
  }
  if (isInvalidArgumentMessage(message)) {
    return new ToolExecutionError(message, "INVALID_ARGUMENTS");
  }

  return new ToolExecutionError(message, fallbackCode);
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
