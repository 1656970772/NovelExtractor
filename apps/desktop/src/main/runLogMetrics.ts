import { Buffer } from "node:buffer";
import { TOOL_LOOP_ROUND_REASON_LABELS, type ToolLoopRoundReason } from "./toolErrorClassification";

export type RunLogMetrics = {
  modelRequestCount: number;
  toolCallCountByName: Record<string, number>;
  recoverableRetryCount: number;
  unsafePathCount: number;
  invalidArgumentsCount: number;
  unknownToolFailures: string[];
  roundReasonCounts: Record<string, number>;
  fullReportReadCount: number;
  windowTextReferenceCount: number;
  expandedToolSchemaCount: number;
  fullLogBytes: number;
};

type ToolCallBlock = {
  name: string;
  body: string;
};

const SIMPLE_READ_FILE_LABEL = "读取文件：";

const SIMPLE_TOOL_CALL_LABELS: Record<string, string> = {
  [SIMPLE_READ_FILE_LABEL]: "read_file",
  "查找报告文件：": "glob",
  "搜索文件：": "grep",
  "列出目录：": "ls",
  "读取报告字段：": "read_report_excerpt",
  "更新报告字段：": "upsert_report_section",
  "写入报告：": "write_file",
  "更新报告：": "edit_file",
  "批量更新报告：": "multi_edit",
  "标记无新增：": "mark_no_update",
  "执行命令：": "bash",
  "读取后台命令输出：": "bash_output",
  "等待后台任务完成": "wait",
  "终止后台任务：": "kill_shell"
};

function countMatches(text: string, pattern: RegExp): number {
  return Array.from(text.matchAll(pattern)).length;
}

function incrementCount(counts: Record<string, number>, key: string, amount = 1): void {
  counts[key] = (counts[key] ?? 0) + amount;
}

function countModelRequests(logText: string): number {
  const fullLogCount = countMatches(logText, /\[[^\]\r\n]+\]\[大模型请求\]\[Prompt\]/gu);
  if (fullLogCount > 0) {
    // full/simple 拼接同一运行时，full 标签是权威来源，simple 摘要不再参与计数以避免双计数。
    return fullLogCount;
  }

  const providerBodyCount = countMatches(logText, /\[[^\]\r\n]+\]\[大模型请求\]\[ProviderBody\]/gu);
  if (providerBodyCount > 0) {
    return providerBodyCount;
  }

  return countMatches(logText, /请求模型：窗口\s+[^，,\r\n]+[，,]第\s+\d+\s+轮/gu);
}

function countToolCallsByName(logText: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const fullLogMatches = Array.from(logText.matchAll(/\[[^\]\r\n]+\]\[工具调用\]\[([^\]\r\n]+)\]/gu));
  if (fullLogMatches.length > 0) {
    // full/simple 拼接同一运行时，full 标签是权威来源，simple 摘要不再参与计数以避免双计数。
    for (const match of fullLogMatches) {
      incrementCount(counts, match[1]);
    }
    return counts;
  }

  for (const [label, toolName] of Object.entries(SIMPLE_TOOL_CALL_LABELS)) {
    const count = countMatches(logText, new RegExp(escapeRegExp(label), "gu"));
    if (count > 0) {
      counts[toolName] = count;
    }
  }

  for (const match of logText.matchAll(/调用工具：([a-zA-Z0-9_-]+)/gu)) {
    incrementCount(counts, match[1]);
  }

  return counts;
}

function countRecoverableRetries(logText: string): number {
  const classificationCount = countMatches(logText, /^\s*classification:\s*recoverable_by_model\s*$/gmu);
  if (classificationCount > 0) {
    return classificationCount;
  }

  const recoverableFlagCount = countMatches(logText, /^\s*是否可恢复错误:\s*true\s*$/gmu);
  if (recoverableFlagCount > 0) {
    return recoverableFlagCount;
  }

  return countMatches(logText, /返回可恢复错误/gu);
}

function parseUnknownToolFailures(logText: string): string[] {
  const names = new Set<string>();
  for (const match of logText.matchAll(/Tool is not enabled:\s*([^\s,，.;。"'`]+)/giu)) {
    const toolName = match[1].trim();
    if (toolName !== "") {
      names.add(toolName);
    }
  }
  return [...names].sort();
}

function parseRoundReasonCounts(logText: string): Record<string, number> {
  const simpleCounts = parseSimpleRoundReasonCounts(logText);
  if (Object.keys(simpleCounts).length > 0) {
    return simpleCounts;
  }

  return parseFullRoundReasonCounts(logText);
}

function parseSimpleRoundReasonCounts(logText: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const match of logText.matchAll(/多轮原因：([^\r\n]+)/gu)) {
    const summary = match[1].trim();
    if (summary === "无") {
      continue;
    }

    for (const item of summary.split(/[，,]/u)) {
      const itemMatch = item.trim().match(/^(.+?)\s+(\d+)\s*次$/u);
      if (!itemMatch) {
        continue;
      }
      incrementCount(counts, itemMatch[1].trim(), Number(itemMatch[2]));
    }
  }
  return counts;
}

function parseFullRoundReasonCounts(logText: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const labelsByReason = TOOL_LOOP_ROUND_REASON_LABELS as Record<ToolLoopRoundReason, string>;
  for (const [reason, label] of Object.entries(labelsByReason)) {
    const escapedReason = escapeRegExp(reason);
    const pattern = new RegExp(`^\\s*${escapedReason}:\\s*(\\d+)\\s*$`, "gmu");
    for (const match of logText.matchAll(pattern)) {
      const count = Number(match[1]);
      if (count > 0) {
        incrementCount(counts, label, count);
      }
    }
  }
  return counts;
}

function collectToolCallBlocks(logText: string): ToolCallBlock[] {
  const blocks: ToolCallBlock[] = [];
  let current: { name: string; lines: string[] } | undefined;

  for (const line of logText.split(/\r?\n/u)) {
    const toolCallHeader = line.match(/^\[[^\]\r\n]+\]\[工具调用\]\[([^\]\r\n]+)\](.*)$/u);
    if (toolCallHeader) {
      if (current) {
        blocks.push({ name: current.name, body: current.lines.join("\n") });
      }
      current = { name: toolCallHeader[1], lines: [] };
      const inlineValue = toolCallHeader[2].trim();
      if (inlineValue !== "") {
        current.lines.push(inlineValue);
      }
      continue;
    }

    if (/^\[[^\]\r\n]+\]\[[^\]\r\n]+\]/u.test(line)) {
      if (current) {
        blocks.push({ name: current.name, body: current.lines.join("\n") });
        current = undefined;
      }
      continue;
    }

    if (current) {
      current.lines.push(line);
    }
  }

  if (current) {
    blocks.push({ name: current.name, body: current.lines.join("\n") });
  }

  return blocks;
}

function countFullReportReads(logText: string): number {
  const readFileBlocks = collectToolCallBlocks(logText).filter((block) => block.name === "read_file");
  if (readFileBlocks.length > 0) {
    return readFileBlocks.filter((block) => !hasBoundedReadArguments(block.body) && extractPathValues(block.body).some(isReportReadPath)).length;
  }

  let count = 0;
  const simpleReadFilePattern = new RegExp(`${escapeRegExp(SIMPLE_READ_FILE_LABEL)}([^\\r\\n]+)`, "gu");
  for (const match of logText.matchAll(simpleReadFilePattern)) {
    if (isReportReadPath(cleanPathValue(match[1]))) {
      count += 1;
    }
  }
  return count;
}

function hasBoundedReadArguments(blockBody: string): boolean {
  return /^\s*(?:offset|limit):\s*.*$/gmu.test(blockBody);
}

function extractPathValues(blockBody: string): string[] {
  const paths: string[] = [];
  const lines = blockBody.split(/\r?\n/u);

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*path:\s*(.*)$/u);
    if (!match) {
      continue;
    }

    const inlineValue = cleanPathValue(match[1]);
    if (inlineValue !== "") {
      paths.push(inlineValue);
      continue;
    }

    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      const nestedMatch = lines[nextIndex].match(/^\s*-\s+(.+)$/u);
      if (!nestedMatch) {
        break;
      }
      const nestedValue = cleanPathValue(nestedMatch[1]);
      if (nestedValue !== "") {
        paths.push(nestedValue);
      }
    }
  }

  return paths;
}

function cleanPathValue(value: string): string {
  return value.trim().replace(/^['"`]|['"`]$/gu, "");
}

function isReportReadPath(value: string): boolean {
  const normalized = value.replace(/\\/gu, "/");
  const baseName = normalized.split("/").pop() ?? normalized;
  return normalized.includes("/reports/") || normalized.startsWith("reports/") || (!normalized.includes("/") && baseName.endsWith(".md"));
}

function countExpandedToolSchemaDescriptions(logText: string): number {
  let promptCount = 0;
  let providerBodyCount = 0;
  let requestLines: string[] = [];
  let requestBlock: "Prompt" | "ProviderBody" | undefined;

  const flush = () => {
    if (requestBlock === "Prompt") {
      promptCount += countPromptToolSchemaDescriptions(requestLines);
    }
    if (requestBlock === "ProviderBody") {
      providerBodyCount += countProviderBodyToolDescriptions(requestLines);
    }
    requestLines = [];
    requestBlock = undefined;
  };

  for (const line of logText.split(/\r?\n/u)) {
    if (/^\[[^\]\r\n]+\]\[大模型请求\]\[Prompt\]/u.test(line)) {
      flush();
      requestBlock = "Prompt";
      continue;
    }

    if (/^\[[^\]\r\n]+\]\[大模型请求\]\[ProviderBody\]/u.test(line)) {
      flush();
      requestBlock = "ProviderBody";
      continue;
    }

    if (/^\[[^\]\r\n]+\]\[[^\]\r\n]+\]/u.test(line)) {
      flush();
      continue;
    }

    if (requestBlock) {
      requestLines.push(line);
    }
  }

  flush();

  return providerBodyCount > 0 ? providerBodyCount : promptCount;
}

function countPromptToolSchemaDescriptions(lines: string[]): number {
  let count = 0;
  let inToolsBlock = false;
  let currentToolFieldIndent: number | undefined;
  let parameterBlockIndents: number[] = [];

  for (const line of lines) {
    if (line.trim() === "") {
      continue;
    }

    const indent = line.match(/^\s*/u)?.[0].length ?? 0;

    if (indent === 0) {
      inToolsBlock = /^tools:\s*$/u.test(line);
      currentToolFieldIndent = undefined;
      parameterBlockIndents = [];
      continue;
    }

    if (!inToolsBlock) {
      continue;
    }

    parameterBlockIndents = parameterBlockIndents.filter((parameterIndent) => indent > parameterIndent);

    const toolItemMatch = line.match(/^(\s*)-\s*(.*)$/u);
    if (toolItemMatch) {
      if (parameterBlockIndents.length > 0) {
        continue;
      }
      currentToolFieldIndent = toolItemMatch[1].length + 2;
      if (/^description:/u.test(toolItemMatch[2])) {
        count += 1;
      }
      continue;
    }

    if (indent === currentToolFieldIndent && /^\s*description:/u.test(line) && parameterBlockIndents.length === 0) {
      count += 1;
    }

    if (/^\s*parameters:\s*/u.test(line)) {
      parameterBlockIndents.push(indent);
    }
  }

  return count;
}

function countProviderBodyToolDescriptions(lines: string[]): number {
  let count = 0;
  let schemaBlockIndents: number[] = [];

  for (const line of lines) {
    if (line.trim() === "") {
      continue;
    }

    const indent = line.match(/^\s*/u)?.[0].length ?? 0;
    schemaBlockIndents = schemaBlockIndents.filter((schemaIndent) => indent > schemaIndent);

    if (/^\s*(?:parameters|input_schema|inputSchema|json|properties):\s*$/u.test(line)) {
      schemaBlockIndents.push(indent);
      continue;
    }

    if (schemaBlockIndents.length === 0 && /^\s*description:\s+.+/u.test(line)) {
      count += 1;
    }
  }

  return count;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function parseRunLogMetrics(logText: string): RunLogMetrics {
  return {
    modelRequestCount: countModelRequests(logText),
    toolCallCountByName: countToolCallsByName(logText),
    recoverableRetryCount: countRecoverableRetries(logText),
    unsafePathCount: countMatches(logText, /\bUNSAFE_PATH\b/gu),
    invalidArgumentsCount: countMatches(logText, /\bINVALID_ARGUMENTS\b/gu),
    unknownToolFailures: parseUnknownToolFailures(logText),
    roundReasonCounts: parseRoundReasonCounts(logText),
    fullReportReadCount: countFullReportReads(logText),
    windowTextReferenceCount: countMatches(logText, /\[窗口原文见\s+[^\]\r\n]+\]/gu),
    expandedToolSchemaCount: countExpandedToolSchemaDescriptions(logText),
    fullLogBytes: Buffer.byteLength(logText, "utf8")
  };
}
