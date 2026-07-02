import path from "node:path";

export interface TaskProgressLogEntry {
  tags: readonly string[];
  timestamp: string;
  value: unknown;
}

type ToolSummary = {
  call: string;
  result: string;
  target: (value: unknown) => string;
};

const TOOL_SUMMARIES: Record<string, ToolSummary> = {
  read_file: {
    call: "读取文件",
    result: "读取完成",
    target: toolPath
  },
  glob: {
    call: "查找报告文件",
    result: "查找完成",
    target: toolPattern
  },
  grep: {
    call: "搜索文件",
    result: "搜索完成",
    target: toolPath
  },
  ls: {
    call: "列出目录",
    result: "列出完成",
    target: toolPath
  },
  write_file: {
    call: "写入报告",
    result: "写入完成",
    target: toolPath
  },
  edit_file: {
    call: "更新报告",
    result: "更新完成",
    target: toolPath
  },
  multi_edit: {
    call: "批量更新报告",
    result: "批量更新完成",
    target: toolPath
  },
  mark_no_update: {
    call: "标记无新增",
    result: "标记完成",
    target: toolPath
  },
  bash: {
    call: "执行命令",
    result: "命令完成",
    target: () => "bash"
  },
  bash_output: {
    call: "读取后台命令输出",
    result: "后台命令输出读取完成",
    target: toolJobId
  },
  wait: {
    call: "等待后台任务完成",
    result: "后台任务等待完成",
    target: () => ""
  },
  kill_shell: {
    call: "终止后台任务",
    result: "后台任务已终止",
    target: toolJobId
  }
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function shortTime(timestamp: string): string {
  const match = timestamp.match(/(?:T|\s|^)(\d{2}):(\d{2}):(\d{2})/u);
  return match ? `${match[1]}:${match[2]}:${match[3]}` : timestamp;
}

function withTime(entry: TaskProgressLogEntry, message: string): string {
  return `${shortTime(entry.timestamp)} ${message}`;
}

function fileName(value: unknown, fallback = "未指定文件"): string {
  if (typeof value !== "string" || value.trim() === "") {
    return fallback;
  }

  return path.basename(value.replace(/\\/gu, "/"));
}

function stringField(value: unknown, key: string): string | undefined {
  const record = asRecord(value);
  const recordValue = record?.[key];
  if (typeof recordValue === "string" && recordValue.trim() !== "") {
    return recordValue;
  }
  if (typeof recordValue === "number" || typeof recordValue === "boolean") {
    return String(recordValue);
  }

  const text = asText(value);
  if (!text) {
    return undefined;
  }

  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`^\\s*${escapedKey}:\\s*(.+?)\\s*$`, "mu").exec(text);
  const matchedValue = match?.[1]?.trim();
  if (matchedValue && matchedValue !== "未设置") {
    return matchedValue;
  }

  const inlineMatch = new RegExp(`(?:^|[，,\\s])${escapedKey}\\s+([^，,\\n]+)`, "u").exec(text);
  const inlineValue = inlineMatch?.[1]?.trim();
  return inlineValue && inlineValue !== "未设置" ? inlineValue : undefined;
}

function objectField(value: unknown, key: string): Record<string, unknown> | undefined {
  return asRecord(asRecord(value)?.[key]);
}

function arrayField(value: unknown, key: string): unknown[] | undefined {
  const item = asRecord(value)?.[key];
  return Array.isArray(item) ? item : undefined;
}

function countArrayOrRenderedItems(value: unknown, key: string): number {
  const arrayValue = arrayField(value, key);
  if (arrayValue) {
    return arrayValue.length;
  }

  const text = asText(value);
  if (!text) {
    return 0;
  }

  const lines = text.split(/\r?\n/u);
  const startIndex = lines.findIndex((line) => line.trim() === `${key}:`);
  if (startIndex < 0) {
    return 0;
  }

  let count = 0;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\S/u.test(line) && line.includes(":")) {
      break;
    }
    if (line.trim() === "-") {
      count += 1;
    }
  }

  return count;
}

function firstRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const record = objectField(value, key);
    if (record) {
      return record;
    }
  }
  return asRecord(value);
}

function rawToolValue(value: unknown): Record<string, unknown> | undefined {
  return firstRecord(value, ["实际执行输入", "模型原始输入", "输入参数"]);
}

function toolPath(value: unknown): string {
  const args = rawToolValue(value);
  return fileName(args?.path ?? args?.pattern ?? args?.job_id);
}

function toolPattern(value: unknown): string {
  const args = rawToolValue(value);
  return fileName(args?.pattern ?? args?.path ?? args?.job_id);
}

function toolJobId(value: unknown): string {
  const args = rawToolValue(value);
  const jobId = args?.job_id ?? args?.id;
  return typeof jobId === "string" && jobId.trim() !== "" ? jobId : "bash-1";
}

function hasRecoverableError(value: unknown): boolean {
  return asRecord(value)?.["是否可恢复错误"] === true;
}

function resultContent(value: unknown): unknown {
  return asRecord(value)?.["返回内容"];
}

function hasResultContent(value: unknown): boolean {
  const content = resultContent(value);
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed !== "" && trimmed !== "[]";
  }
  if (Array.isArray(content)) {
    return content.length > 0;
  }
  return content !== null && typeof content !== "undefined";
}

function summarizeTaskInfo(value: unknown): string {
  const book = stringField(value, "书籍") ?? stringField(value, "书籍名称") ?? "未知书籍";
  const model = stringField(value, "模型") ?? "未知模型";
  const templateCount =
    stringField(value, "模板")?.match(/\d+/u)?.[0] ??
    String(countArrayOrRenderedItems(value, "模板") || 0);

  return `开始任务：${book}，${templateCount} 个模板，模型 ${model}`;
}

function summarizeCoverageIndex(value: unknown): string {
  const skip = stringField(value, "跳过已提取") ?? "false";
  const pendingCount = countArrayOrRenderedItems(value, "待处理模板");
  return `检查覆盖索引：跳过已提取=${skip}，待处理模板 ${pendingCount} 个`;
}

function summarizeWindow(value: unknown): string {
  const windowText =
    stringField(value, "正在处理")?.replace(/^窗口\s*/u, "") ??
    stringField(value, "窗口序号") ??
    "?/?";
  const chapters = stringField(value, "章节范围") ?? "未知";
  const templateCount = countArrayOrRenderedItems(value, "模板");
  return `窗口 ${windowText}：处理第 ${chapters} 章，模板 ${templateCount} 个`;
}

function summarizeModelRequest(value: unknown): string {
  const windowText = stringField(value, "窗口") ?? "?/?";
  const round = stringField(value, "轮次") ?? "1";
  return `请求模型：窗口 ${windowText}，第 ${round} 轮`;
}

function summarizeModelResponse(value: unknown): string {
  const toolCalls = arrayField(value, "工具调用");
  if (toolCalls && toolCalls.length === 0) {
    return "模型返回：无工具调用";
  }
  if (toolCalls && toolCalls.length > 0) {
    return "模型返回：准备读取窗口文本和检查已有报告";
  }

  const text = asText(value);
  if (text?.match(/^工具调用:\s*\[\]\s*$/mu)) {
    return "模型返回：无工具调用";
  }
  return "模型返回：准备读取窗口文本和检查已有报告";
}

function summarizeRetry(value: unknown): string {
  const text = asText(value) ?? stringField(value, "原因") ?? "";
  const missing = /缺少\s*(?:outputFileName)?[：:]\s*([^。\n]+)/u.exec(text)?.[1]?.trim();
  if (missing) {
    return `继续补齐结果：缺少 ${missing}`;
  }

  const missingCount = stringField(value, "缺失数量") ?? /还缺\s*(\d+)\s*个/u.exec(text)?.[1];
  if (missingCount) {
    return `继续补齐结果：还缺 ${missingCount} 个模板处理结果`;
  }

  return "继续补齐结果：检查未完成模板";
}

function summarizeBatchResult(value: unknown): string {
  const outcomes = arrayField(value, "处理结果") ?? [];
  const writtenCount = outcomes.filter((item) => {
    const record = asRecord(item);
    return record?.status === "written" || record?.outcome === "written";
  }).length;
  const noUpdateCount = outcomes.filter((item) => {
    const record = asRecord(item);
    return record?.status === "no_update" || record?.outcome === "no_update";
  }).length;
  const windowText = stringField(value, "窗口") ?? stringField(value, "批次") ?? "1/1";

  return `完成窗口 ${windowText}：写入 ${writtenCount} 个报告，标记 ${noUpdateCount} 个无新增`;
}

function summarizeCoverageUpdate(value: unknown): string {
  const windowText = stringField(value, "窗口") ?? stringField(value, "批次") ?? "?/?";
  return `更新覆盖索引：窗口 ${windowText} 已记录`;
}

function summarizeToolCall(toolName: string, value: unknown): string {
  const summary = TOOL_SUMMARIES[toolName];
  if (!summary) {
    return `调用工具：${toolName}`;
  }

  const target = summary.target(value);
  return target ? `${summary.call}：${target}` : summary.call;
}

function summarizeToolResult(toolName: string, value: unknown): string {
  const summary = TOOL_SUMMARIES[toolName];
  if (!summary) {
    return `工具完成：${toolName}`;
  }

  const target = summary.target(value);
  if (hasRecoverableError(value)) {
    const recoverableLabel = summary.result.replace(/完成$/u, "返回可恢复错误");
    return target ? `${recoverableLabel}：${target}，模型将重试` : `${recoverableLabel}，模型将重试`;
  }

  if (toolName === "glob") {
    return `${summary.result}：${target}，${hasResultContent(value) ? "已找到" : "未找到"}`;
  }
  if (toolName === "grep") {
    return `${summary.result}：${target}，${hasResultContent(value) ? "已命中" : "未命中"}`;
  }

  return target ? `${summary.result}：${target}` : summary.result;
}

function summarizeWindowError(value: unknown): string {
  const windowText = stringField(value, "窗口") ?? "?/?";
  const reason = stringField(value, "原因") ?? stringField(value, "错误") ?? asText(value) ?? "未知原因";
  return `窗口失败：窗口 ${windowText}，原因 ${reason}`;
}

function summarizeTaskError(value: unknown): string {
  const reason = stringField(value, "原因") ?? stringField(value, "错误") ?? asText(value) ?? "未知原因";
  return `任务失败：原因 ${reason}`;
}

function summarizeWarning(value: unknown): string {
  const warning = stringField(value, "错误") ?? stringField(value, "类型") ?? asText(value) ?? "已记录";
  return `运行警告：${warning}`;
}

function fallbackMessage(tags: readonly string[]): string {
  const label = tags.length > 0 ? tags.join("/") : "日志";
  return `${label}：已记录`;
}

export function summarizeTaskLogEntry(entry: TaskProgressLogEntry): string {
  const [firstTag, secondTag] = entry.tags;
  let message: string;

  if (firstTag === "任务信息") {
    message = summarizeTaskInfo(entry.value);
  } else if (firstTag === "上下文" && secondTag === "任务") {
    message = "加载任务上下文：书籍、模板、规则快照和报告目录已准备";
  } else if (firstTag === "上下文" && secondTag === "覆盖索引") {
    message = summarizeCoverageIndex(entry.value);
  } else if (firstTag === "上下文" && secondTag === "窗口") {
    message = summarizeWindow(entry.value);
  } else if (firstTag === "大模型请求" && secondTag === "Prompt") {
    message = summarizeModelRequest(entry.value);
  } else if (firstTag === "大模型返回") {
    message = summarizeModelResponse(entry.value);
  } else if (firstTag === "工具调用" && secondTag) {
    message = summarizeToolCall(secondTag, entry.value);
  } else if (firstTag === "工具返回" && secondTag) {
    message = summarizeToolResult(secondTag, entry.value);
  } else if (firstTag === "上下文" && secondTag === "重试") {
    message = summarizeRetry(entry.value);
  } else if (firstTag === "上下文" && secondTag === "批次结果") {
    message = summarizeBatchResult(entry.value);
  } else if (firstTag === "上下文" && secondTag === "覆盖索引更新") {
    message = summarizeCoverageUpdate(entry.value);
  } else if (firstTag === "错误" && secondTag === "窗口") {
    message = summarizeWindowError(entry.value);
  } else if (firstTag === "错误" && secondTag === "任务") {
    message = summarizeTaskError(entry.value);
  } else if (firstTag === "警告" && secondTag === "bash") {
    message = summarizeWarning(entry.value);
  } else {
    message = fallbackMessage(entry.tags);
  }

  return withTime(entry, message);
}
