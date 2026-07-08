import fs from "node:fs/promises";
import path from "node:path";
import type { Clock } from "@novel-extractor/domain";
import type { ChatCompletionMessage, ToolCallArguments, ToolDefinition } from "@novel-extractor/llm";
import { formatBuildInfo, resolveBuildInfo, type BuildInfo } from "./buildInfo";
import { redactSecrets } from "./credentials";
import { summarizeTaskLogEntry } from "./taskProgressLog";

export interface TaskTextLogger {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly simpleAbsolutePath: string;
  readonly simpleRelativePath: string;
  append(tags: readonly string[], value: unknown): Promise<void>;
  setSecrets(secrets: readonly string[]): void;
}

export interface AppendTaskTextLogEntryInput {
  absolutePath: string;
  simpleAbsolutePath: string;
  simpleStartedAt?: string;
  tags: readonly string[];
  value: unknown;
  clock?: Pick<Clock, "now">;
  secrets?: readonly string[];
}

interface CreateTaskTextLoggerInput {
  clock?: Pick<Clock, "now">;
  jobId: string;
  projectRoot: string;
  secrets?: readonly string[];
  appVersion?: string;
  taskInfo: string;
  buildInfo?: BuildInfo;
  logDirectorySegments?: readonly string[];
  baseFileNamePrefix?: string;
}

export interface ModelRequestTaskLogValue {
  [key: string]: unknown;
  messages?: readonly ChatCompletionMessage[];
  tools?: readonly ToolDefinition[];
  providerBody?: unknown;
}

export interface SerializeModelRequestForTaskLogInput {
  value: ModelRequestTaskLogValue;
  windowFileName: string;
  windowText: string;
}

export interface ReplaceWindowTextReferencesForTaskLogInput {
  value: unknown;
  windowFileName: string;
  windowText: string;
}

const systemClock: Pick<Clock, "now"> = {
  now: () => new Date().toISOString()
};
const minimumWindowExcerptCharsForLogReference = 8;

function toDisplayTimestamp(timestamp: string): string {
  const match = timestamp.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/u);
  if (!match) {
    return timestamp;
  }

  return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
}

function toElapsedTimestamp(startedAt: string, timestamp: string): string {
  const startedAtMs = Date.parse(startedAt);
  const timestampMs = Date.parse(timestamp);
  if (Number.isNaN(startedAtMs) || Number.isNaN(timestampMs)) {
    return timestamp;
  }

  const totalSeconds = Math.max(0, Math.floor((timestampMs - startedAtMs) / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

function toFileTimestamp(timestamp: string): string {
  const match = timestamp.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/u);
  if (!match) {
    return timestamp.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "task-log";
  }

  return `${match[1]}${match[2]}${match[3]}-${match[4]}${match[5]}${match[6]}`;
}

function toProjectRelativePath(...segments: string[]): string {
  return segments.join("/");
}

function deriveSimpleLogPath(allocated: {
  absolutePath: string;
  relativePath: string;
}): { absolutePath: string; relativePath: string } {
  return {
    absolutePath: allocated.absolutePath.replace(/\.txt$/u, ".simple.txt"),
    relativePath: allocated.relativePath.replace(/\.txt$/u, ".simple.txt")
  };
}

async function tryAllocateLogPath(input: {
  absolutePath: string;
  relativePath: string;
}): Promise<{ absolutePath: string; relativePath: string } | null> {
  try {
    const handle = await fs.open(input.absolutePath, "wx");
    await handle.close();
    return input;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      await fs.mkdir(path.dirname(input.absolutePath), { recursive: true });
      try {
        const handle = await fs.open(input.absolutePath, "wx");
        await handle.close();
        return input;
      } catch (retryError) {
        const retryCode = (retryError as NodeJS.ErrnoException).code;
        if (retryCode === "EEXIST") {
          return null;
        }
        throw retryError;
      }
    }
    if (code === "EEXIST") {
      return null;
    }
    throw error;
  }
}

async function allocateLogPath(input: {
  baseFileName: string;
  jobId: string;
  projectRoot: string;
  logDirectorySegments?: readonly string[];
}): Promise<{ absolutePath: string; relativePath: string }> {
  const directorySegments = input.logDirectorySegments ?? ["runs", input.jobId, "logs"];
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? "" : `-${String(index).padStart(3, "0")}`;
    const fileName = `${input.baseFileName}${suffix}.txt`;
    const relativePath = toProjectRelativePath(...directorySegments, fileName);
    const absolutePath = path.join(input.projectRoot, ...directorySegments, fileName);
    const allocated = await tryAllocateLogPath({ absolutePath, relativePath });
    if (allocated) {
      return allocated;
    }
  }

  throw new Error("无法创建唯一任务日志文件");
}

function redactTaskLogText(value: string, secrets: readonly string[]): string {
  return redactSecrets(value, secrets)
    .replace(/((?:apiKey|api_key|authorization|password|secret)\s*:\s*)[^\n]+/giu, "$1***")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;"]+/giu, "$1***")
    .replace(/\[REDACTED\]/gu, "***");
}

export function serializeModelRequestForTaskLog(input: SerializeModelRequestForTaskLogInput): Record<string, unknown> {
  const output = replaceWindowTextReferencesInValue(input.value, {
    windowFileName: input.windowFileName,
    windowText: input.windowText
  }) as Record<string, unknown>;

  if (input.value.messages) {
    output.messages = serializeMessagesForTaskLog({
      messages: input.value.messages,
      windowFileName: input.windowFileName,
      windowText: input.windowText
    });
  }

  return output;
}

export function replaceWindowTextReferencesForTaskLog(input: ReplaceWindowTextReferencesForTaskLogInput): unknown {
  return replaceWindowTextReferencesInValue(input.value, {
    windowFileName: input.windowFileName,
    windowText: input.windowText
  });
}

function serializeMessagesForTaskLog(input: {
  messages: readonly ChatCompletionMessage[];
  windowFileName: string;
  windowText: string;
}): ChatCompletionMessage[] {
  return input.messages.map((message) => {
    const content = replaceWindowTextForLog(message.content, input.windowText, input.windowFileName);
    if (message.role === "assistant") {
      return {
        ...message,
        content,
        toolCalls: message.toolCalls?.map((toolCall) => ({
          ...toolCall,
          arguments: cloneLogValue(toolCall.arguments) as ToolCallArguments
        }))
      };
    }

    return {
      ...message,
      content
    };
  });
}

function replaceWindowTextReferencesInValue(
  value: unknown,
  input: { windowFileName: string; windowText: string }
): unknown {
  if (typeof value === "string") {
    return replaceWindowTextForLog(value, input.windowText, input.windowFileName);
  }

  if (Array.isArray(value)) {
    return value.map((item) => replaceWindowTextReferencesInValue(item, input));
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceWindowTextReferencesInValue(item, input)])
    );
  }

  return value;
}

function replaceWindowTextForLog(content: string, windowText: string, windowFileName: string): string {
  const reference = `[窗口原文见 ${windowFileName}]`;
  const promptSectionOutput = replaceCurrentWindowPromptSectionForLog(content, windowText, reference);
  if (promptSectionOutput !== undefined) {
    return promptSectionOutput;
  }

  const candidates = windowTextReferenceCandidates(windowText);
  if (candidates.length === 0) {
    return content;
  }

  let output = content;
  for (const candidate of candidates) {
    output = output.split(candidate).join(reference);
  }

  const readFilePlainText = parseReadFileWindowText(output);
  if (readFilePlainText !== undefined && matchesWindowTextForLogReference(readFilePlainText, candidates)) {
    return reference;
  }

  return output;
}

function replaceCurrentWindowPromptSectionForLog(
  content: string,
  windowText: string,
  reference: string
): string | undefined {
  const normalizedContent = normalizeLineEndings(content);
  const headingMatch = /(^|\n)## 当前窗口文本[ \t]*\n/u.exec(normalizedContent);
  if (!headingMatch) {
    return undefined;
  }

  const sectionStart = headingMatch.index + headingMatch[0].length;
  const beforeSection = normalizedContent.slice(0, sectionStart);
  const afterHeading = normalizedContent.slice(sectionStart);
  const normalizedWindowText = normalizeLineEndings(windowText).trim();

  if (normalizedWindowText !== "" && afterHeading.startsWith(normalizedWindowText)) {
    return `${beforeSection}${reference}${afterHeading.slice(normalizedWindowText.length)}`;
  }

  const nextSectionMatch = /\n## /u.exec(afterHeading);
  if (nextSectionMatch) {
    return `${beforeSection}${reference}${afterHeading.slice(nextSectionMatch.index)}`;
  }

  return `${beforeSection}${reference}`;
}

function windowTextReferenceCandidates(windowText: string): string[] {
  const normalized = normalizeLineEndings(windowText);
  return [...new Set([normalized, normalized.trimEnd(), normalized.trim()])].filter((candidate) => candidate !== "");
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}

function comparableWindowText(value: string): string {
  return normalizeLineEndings(value).trimEnd();
}

function matchesWindowTextForLogReference(readFilePlainText: string, candidates: readonly string[]): boolean {
  const comparableReadText = comparableWindowText(readFilePlainText);
  if (comparableReadText === "") {
    return false;
  }

  return candidates.some((candidate) => {
    const comparableCandidate = comparableWindowText(candidate);
    return (
      comparableCandidate === comparableReadText ||
      (isMeaningfulWindowTextExcerpt(comparableReadText) && comparableCandidate.includes(comparableReadText))
    );
  });
}

function isMeaningfulWindowTextExcerpt(value: string): boolean {
  return value.replace(/\s/gu, "").length >= minimumWindowExcerptCharsForLogReference;
}

function parseReadFileWindowText(content: string): string | undefined {
  const lines = normalizeLineEndings(content).split("\n");
  while (lines.at(-1) === "") {
    lines.pop();
  }
  if (lines.length === 0) {
    return undefined;
  }

  const textLines: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "" && lines[index + 1]?.startsWith("[more lines below;")) {
      continue;
    }
    if (line.startsWith("[more lines below;")) {
      if (index !== lines.length - 1) {
        return undefined;
      }
      continue;
    }

    const match = /^\s*\d+→(.*)$/u.exec(line);
    if (!match) {
      return undefined;
    }
    textLines.push(match[1] ?? "");
  }

  if (textLines.length === 0) {
    return undefined;
  }

  return textLines.join("\n");
}

function cloneLogValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneLogValue(item));
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneLogValue(item)]));
  }

  return value;
}

function renderPlainText(value: unknown, depth = 0, seen = new WeakSet<object>()): string {
  const indent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }

  if (typeof value === "undefined") {
    return "未设置";
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "function") {
    return "[Function]";
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }

    return value
      .map((item) => {
        const rendered = renderPlainText(item, depth + 1, seen);
        if (rendered.includes("\n")) {
          return `${indent}-\n${rendered}`;
        }

        return `${indent}- ${rendered}`;
      })
      .join("\n");
  }

  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);

    const entries = Object.entries(value);
    if (entries.length === 0) {
      return "{}";
    }

    return entries
      .map(([key, item]) => {
        const rendered = renderPlainText(item, depth + 1, seen);
        if (rendered.includes("\n")) {
          return `${indent}${key}:\n${rendered
            .split("\n")
            .map((line) => `${childIndent}${line}`)
            .join("\n")}`;
        }

        return `${indent}${key}: ${rendered}`;
      })
      .join("\n");
  }

  return String(value);
}

function renderTaskLogLine(input: {
  secrets: readonly string[];
  tags: readonly string[];
  timestamp: string;
  value: unknown;
}): string {
  const timestamp = toDisplayTimestamp(input.timestamp);
  const tagText = input.tags.map((tag) => `[${tag}]`).join("");
  const rendered = redactTaskLogText(renderPlainText(input.value), input.secrets);
  const linePrefix = `[${timestamp}]${tagText}`;

  if (!rendered.includes("\n")) {
    return `${linePrefix} ${rendered}\n`;
  }

  return `${linePrefix}\n${rendered}\n`;
}

function renderTaskLogSimpleLine(input: {
  createdAt: string;
  secrets: readonly string[];
  tags: readonly string[];
  timestamp: string;
  value: unknown;
}): string {
  const summarized = summarizeTaskLogEntry({
    tags: input.tags,
    timestamp: toElapsedTimestamp(input.createdAt, input.timestamp),
    value: input.value
  });
  return `${redactTaskLogText(summarized, input.secrets)}\n`;
}

export async function appendTaskTextLogEntry(input: AppendTaskTextLogEntryInput): Promise<void> {
  const clock = input.clock ?? systemClock;
  const timestamp = clock.now();
  const secrets = [...(input.secrets ?? [])];
  await fs.appendFile(
    input.absolutePath,
    renderTaskLogLine({
      secrets,
      tags: input.tags,
      timestamp,
      value: input.value
    }),
    "utf8"
  );
  await fs.appendFile(
    input.simpleAbsolutePath,
    renderTaskLogSimpleLine({
      createdAt: input.simpleStartedAt ?? timestamp,
      secrets,
      tags: input.tags,
      timestamp,
      value: input.value
    }),
    "utf8"
  );
}

export async function createTaskTextLogger(input: CreateTaskTextLoggerInput): Promise<TaskTextLogger> {
  const clock = input.clock ?? systemClock;
  const createdAt = clock.now();
  const timestampFileName = toFileTimestamp(createdAt);
  const baseFileName =
    input.baseFileNamePrefix === undefined ? timestampFileName : `${input.baseFileNamePrefix}-${timestampFileName}`;
  const allocated = await allocateLogPath({
    baseFileName,
    jobId: input.jobId,
    projectRoot: input.projectRoot,
    logDirectorySegments: input.logDirectorySegments
  });
  const simpleAllocated = deriveSimpleLogPath(allocated);
  await fs.writeFile(simpleAllocated.absolutePath, "", { encoding: "utf8", flag: "wx" });
  let secrets = [...(input.secrets ?? [])];

  function renderLine(tags: readonly string[], value: unknown, timestampValue = clock.now()): string {
    return renderTaskLogLine({
      secrets,
      tags,
      timestamp: timestampValue,
      value
    });
  }

  function renderSimpleLine(tags: readonly string[], value: unknown, timestampValue = clock.now()): string {
    return renderTaskLogSimpleLine({
      createdAt,
      secrets,
      tags,
      timestamp: timestampValue,
      value
    });
  }

  async function appendBoth(tags: readonly string[], value: unknown, timestampValue = clock.now()): Promise<void> {
    await fs.appendFile(allocated.absolutePath, renderLine(tags, value, timestampValue), "utf8");
    await fs.appendFile(simpleAllocated.absolutePath, renderSimpleLine(tags, value, timestampValue), "utf8");
  }

  const logger: TaskTextLogger = {
    absolutePath: allocated.absolutePath,
    relativePath: allocated.relativePath,
    simpleAbsolutePath: simpleAllocated.absolutePath,
    simpleRelativePath: simpleAllocated.relativePath,
    async append(tags, value) {
      await appendBoth(tags, value);
    },
    setSecrets(nextSecrets) {
      secrets = [...nextSecrets];
    }
  };

  await appendBoth(["构建信息"], formatBuildInfo(input.buildInfo ?? resolveBuildInfo({ appVersion: input.appVersion })), createdAt);
  await appendBoth(["任务信息"], input.taskInfo, createdAt);
  return logger;
}
