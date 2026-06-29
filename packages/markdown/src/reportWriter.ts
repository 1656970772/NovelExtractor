import fs from "node:fs";
import path from "node:path";

export type ReportEditOperation = "write_report" | "append_paragraph" | "replace_text" | "multi_edit";

export interface ReportWriterConfig {
  reportsRoot: string;
  previewLimit?: number;
}

export interface WriteReportInput {
  path: string;
  title?: string;
  content: string;
}

export interface AppendParagraphInput {
  path: string;
  paragraph: string;
}

export interface ReplaceTextInput {
  path: string;
  oldText: string;
  newText: string;
}

export interface ReportTextEdit {
  oldText: string;
  newText: string;
}

export interface MultiEditInput {
  path: string;
  edits: ReportTextEdit[];
}

export interface ReportWriteResult {
  path: string;
  relativePath: string;
  operation: ReportEditOperation;
  changedBytes: number;
  content: string;
  preview: string;
}

export class ReportWriterError extends Error {
  constructor(
    message: string,
    readonly code: "UNSAFE_PATH" | "INVALID_ARGUMENTS" | "EDIT_NOT_FOUND" | "IO_ERROR" = "INVALID_ARGUMENTS"
  ) {
    super(message);
    this.name = "ReportWriterError";
  }
}

export interface ReportWriter {
  writeReport(input: WriteReportInput): ReportWriteResult;
  appendParagraph(input: AppendParagraphInput): ReportWriteResult;
  replaceText(input: ReplaceTextInput): ReportWriteResult;
  applyMultiEdit(input: MultiEditInput): ReportWriteResult;
  resolveReportPath(relativePath: string): string;
}

export function createReportWriter(config: ReportWriterConfig): ReportWriter {
  const reportsRoot = getExistingRealRoot(config.reportsRoot);
  const previewLimit = config.previewLimit ?? 240;

  function resolveReportPath(relativePath: string): string {
    const safeName = validateReportFileName(relativePath);
    const targetPath = path.resolve(reportsRoot, safeName);
    assertInsideRoot(reportsRoot, targetPath);
    assertExistingParentInsideRoot(reportsRoot, targetPath);
    assertWritableTargetInsideRoot(reportsRoot, targetPath);
    return targetPath;
  }

  function writeResult(targetPath: string, relativePath: string, operation: ReportEditOperation, nextContent: string): ReportWriteResult {
    assertWritableTargetInsideRoot(reportsRoot, targetPath);
    const previousContent = fs.existsSync(targetPath) ? readUtf8(targetPath) : "";
    fs.writeFileSync(targetPath, nextContent, "utf8");
    return {
      path: targetPath,
      relativePath,
      operation,
      changedBytes: countChangedBytes(previousContent, nextContent),
      content: nextContent,
      preview: nextContent.slice(0, previewLimit)
    };
  }

  return {
    writeReport(input) {
      requireObject(input, "writeReport input");
      requireString(input.path, "path");
      requireString(input.content, "content");
      if (input.title !== undefined) {
        requireString(input.title, "title");
      }

      const targetPath = resolveReportPath(input.path);
      const content = normalizeReportContent(input.content, input.title);
      return writeResult(targetPath, input.path, "write_report", content);
    },

    appendParagraph(input) {
      requireObject(input, "appendParagraph input");
      requireString(input.path, "path");
      requireString(input.paragraph, "paragraph");

      const targetPath = resolveReportPath(input.path);
      const previousContent = fs.existsSync(targetPath) ? readUtf8(targetPath) : "";
      const paragraph = ensureTrailingNewline(input.paragraph.trimEnd());
      const nextContent = previousContent.trimEnd() === "" ? paragraph : `${previousContent.trimEnd()}\n\n${paragraph}`;
      return writeResult(targetPath, input.path, "append_paragraph", nextContent);
    },

    replaceText(input) {
      requireReplaceInput(input);
      const targetPath = resolveReportPath(input.path);
      const previousContent = readUtf8(targetPath);
      const nextContent = replaceFirst(previousContent, input.oldText, input.newText);
      return writeResult(targetPath, input.path, "replace_text", nextContent);
    },

    applyMultiEdit(input) {
      requireObject(input, "multi edit input");
      requireString(input.path, "path");
      if (!Array.isArray(input.edits) || input.edits.length === 0) {
        throw new ReportWriterError("edits must be a non-empty array", "INVALID_ARGUMENTS");
      }

      const targetPath = resolveReportPath(input.path);
      let nextContent = readUtf8(targetPath);
      for (const edit of input.edits) {
        requireTextEdit(edit);
        nextContent = replaceFirst(nextContent, edit.oldText, edit.newText);
      }

      return writeResult(targetPath, input.path, "multi_edit", nextContent);
    },

    resolveReportPath
  };
}

function normalizeReportContent(content: string, title?: string): string {
  const body = ensureTrailingNewline(content.trimEnd());
  if (title === undefined || title.trim() === "") {
    return body;
  }

  return `# ${title.trim()}\n\n${body}`;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function replaceFirst(content: string, oldText: string, newText: string): string {
  if (!content.includes(oldText)) {
    throw new ReportWriterError("Replacement text was not found", "EDIT_NOT_FOUND");
  }

  return content.replace(oldText, newText);
}

function readUtf8(targetPath: string): string {
  try {
    return fs.readFileSync(targetPath, "utf8");
  } catch (error) {
    throw new ReportWriterError(error instanceof Error ? error.message : "Failed to read report", "IO_ERROR");
  }
}

function countChangedBytes(previousContent: string, nextContent: string): number {
  const previousBytes = Buffer.from(previousContent, "utf8");
  const nextBytes = Buffer.from(nextContent, "utf8");
  const commonLength = Math.min(previousBytes.length, nextBytes.length);
  let changed = Math.abs(nextBytes.length - previousBytes.length);

  for (let index = 0; index < commonLength; index += 1) {
    if (previousBytes[index] !== nextBytes[index]) {
      changed += 1;
    }
  }

  return changed;
}

function getExistingRealRoot(root: string): string {
  try {
    return fs.realpathSync.native(root);
  } catch (error) {
    throw new ReportWriterError(error instanceof Error ? error.message : "Reports root does not exist", "UNSAFE_PATH");
  }
}

function assertWritableTargetInsideRoot(rootRealPath: string, targetPath: string): void {
  if (!fs.existsSync(targetPath)) {
    return;
  }

  const targetRealPath = fs.realpathSync.native(targetPath);
  assertInsideRoot(rootRealPath, targetRealPath);
}

function validateReportFileName(candidate: string): string {
  requireString(candidate, "path");
  const normalized = candidate.normalize("NFC");

  if (normalized === "" || normalized === "." || normalized === "..") {
    throw new ReportWriterError("Report path must be a file name", "UNSAFE_PATH");
  }

  if (/[\0/\\]/u.test(normalized)) {
    throw new ReportWriterError("Report path must not contain separators", "UNSAFE_PATH");
  }

  if (/^[A-Za-z]:/u.test(normalized) || path.win32.isAbsolute(normalized) || path.posix.isAbsolute(normalized)) {
    throw new ReportWriterError("Absolute report paths are not allowed", "UNSAFE_PATH");
  }

  return normalized;
}

function assertExistingParentInsideRoot(rootRealPath: string, candidatePath: string): void {
  let existingParent = path.dirname(candidatePath);

  while (!fs.existsSync(existingParent)) {
    assertInsideRoot(rootRealPath, existingParent);
    const nextParent = path.dirname(existingParent);
    if (path.relative(existingParent, nextParent) === "") {
      throw new ReportWriterError("No existing parent found inside reports root", "UNSAFE_PATH");
    }
    existingParent = nextParent;
  }

  const parentRealPath = fs.realpathSync.native(existingParent);
  assertInsideRoot(rootRealPath, parentRealPath);
}

function assertInsideRoot(rootRealPath: string, targetPath: string): void {
  const relativePath = path.relative(rootRealPath, targetPath);
  const escapesRoot = relativePath !== "" && (path.isAbsolute(relativePath) || relativePath.split(path.sep).includes(".."));
  if (escapesRoot) {
    throw new ReportWriterError("Path is outside reports root", "UNSAFE_PATH");
  }
}

function requireReplaceInput(input: ReplaceTextInput): void {
  requireObject(input, "replace input");
  requireString(input.path, "path");
  requireTextEdit(input);
}

function requireTextEdit(input: ReportTextEdit): void {
  requireObject(input, "text edit");
  requireString(input.oldText, "oldText");
  requireString(input.newText, "newText");
  if (input.oldText === "") {
    throw new ReportWriterError("oldText must not be empty", "INVALID_ARGUMENTS");
  }
}

function requireObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ReportWriterError(`${label} must be an object`, "INVALID_ARGUMENTS");
  }
}

function requireString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") {
    throw new ReportWriterError(`${label} must be a string`, "INVALID_ARGUMENTS");
  }
}
