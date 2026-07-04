import fs from "node:fs/promises";
import path from "node:path";
import type { Clock } from "@novel-extractor/domain";
import type { ChatCompletionMessage, ToolCallArguments, ToolSchema } from "@novel-extractor/llm";
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

interface CreateTaskTextLoggerInput {
  clock?: Pick<Clock, "now">;
  jobId: string;
  projectRoot: string;
  secrets?: readonly string[];
  appVersion?: string;
  taskInfo: string;
  buildInfo?: BuildInfo;
}

export interface ModelRequestTaskLogValue {
  [key: string]: unknown;
  messages?: readonly ChatCompletionMessage[];
  tools?: readonly ToolSchema[];
}

export interface SerializeModelRequestForTaskLogInput {
  value: ModelRequestTaskLogValue;
  windowFileName: string;
  windowText: string;
}

const systemClock: Pick<Clock, "now"> = {
  now: () => new Date().toISOString()
};

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

async function allocateLogPath(input: {
  baseFileName: string;
  jobId: string;
  projectRoot: string;
}): Promise<{ absolutePath: string; relativePath: string }> {
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? "" : `-${String(index).padStart(3, "0")}`;
    const fileName = `${input.baseFileName}${suffix}.txt`;
    const relativePath = toProjectRelativePath("runs", input.jobId, "logs", fileName);
    const absolutePath = path.join(input.projectRoot, "runs", input.jobId, "logs", fileName);

    try {
      const handle = await fs.open(absolutePath, "wx");
      await handle.close();
      return { absolutePath, relativePath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        const handle = await fs.open(absolutePath, "wx");
        await handle.close();
        return { absolutePath, relativePath };
      }

      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
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
  return {
    ...input.value,
    messages: input.value.messages
      ? serializeMessagesForTaskLog({
          messages: input.value.messages,
          windowFileName: input.windowFileName,
          windowText: input.windowText
        })
      : input.value.messages,
    tools: input.value.tools ? serializeToolsForTaskLog(input.value.tools) : input.value.tools
  };
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

function replaceWindowTextForLog(content: string, windowText: string, windowFileName: string): string {
  if (windowText === "" || !content.includes(windowText)) {
    return content;
  }

  return content.split(windowText).join(`[窗口原文见 ${windowFileName}]`);
}

function serializeToolsForTaskLog(tools: readonly ToolSchema[]): Array<{
  name: string;
  parameters?: Record<string, unknown>;
}> {
  return tools.map((tool) => ({
    name: tool.function.name,
    parameters: cloneLogValue(tool.function.parameters) as Record<string, unknown> | undefined
  }));
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

export async function createTaskTextLogger(input: CreateTaskTextLoggerInput): Promise<TaskTextLogger> {
  const clock = input.clock ?? systemClock;
  const createdAt = clock.now();
  const allocated = await allocateLogPath({
    baseFileName: toFileTimestamp(createdAt),
    jobId: input.jobId,
    projectRoot: input.projectRoot
  });
  const simpleAllocated = deriveSimpleLogPath(allocated);
  await fs.writeFile(simpleAllocated.absolutePath, "", { encoding: "utf8", flag: "wx" });
  let secrets = [...(input.secrets ?? [])];

  function renderLine(tags: readonly string[], value: unknown, timestampValue = clock.now()): string {
    const timestamp = toDisplayTimestamp(timestampValue);
    const tagText = tags.map((tag) => `[${tag}]`).join("");
    const rendered = redactTaskLogText(renderPlainText(value), secrets);
    const linePrefix = `[${timestamp}]${tagText}`;

    if (!rendered.includes("\n")) {
      return `${linePrefix} ${rendered}\n`;
    }

    return `${linePrefix}\n${rendered}\n`;
  }

  function renderSimpleLine(tags: readonly string[], value: unknown, timestampValue = clock.now()): string {
    const summarized = summarizeTaskLogEntry({ tags, timestamp: toElapsedTimestamp(createdAt, timestampValue), value });
    return `${redactTaskLogText(summarized, secrets)}\n`;
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
