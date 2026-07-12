import path from "node:path";
import { TOOL_LOOP_ROUND_REASON_LABELS, type ToolLoopRoundReason } from "./toolErrorClassification";

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

const TOOL_LOOP_ROUND_REASON_ORDER: ToolLoopRoundReason[] = [
  "report_discovery_rejected",
  "old_report_field_blocks_needed",
  "edit_anchor_failed",
  "tool_arguments_invalid",
  "missing_template_outcome",
  "unknown_tool_recovered"
];

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
  read_report_excerpt: {
    call: "读取报告字段",
    result: "报告字段读取完成",
    target: toolOutputFileName
  },
  upsert_report_section: {
    call: "更新报告字段",
    result: "报告字段更新完成",
    target: toolOutputFileName
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

function numberField(value: unknown, key: string): number | undefined {
  const field = stringField(value, key);
  if (!field) {
    return undefined;
  }

  const parsed = Number(field);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function ensureTemplateLabel(value: string): string {
  return /模板$/u.test(value) ? value : `${value}模板`;
}

function formatChapterPart(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    return "未知章节";
  }
  if (/^第.+章$/u.test(trimmed)) {
    return trimmed;
  }

  return `第${trimmed.replace(/^第/u, "").replace(/章$/u, "")}章`;
}

function formatChapterRangeLabel(value: unknown): string {
  const explicitLabel = stringField(value, "章节范围标签");
  if (explicitLabel) {
    return explicitLabel.startsWith("[") && explicitLabel.endsWith("]") ? explicitLabel : `[${explicitLabel}]`;
  }

  const rawRange = stringField(value, "章节范围") ?? stringField(value, "提交章节范围") ?? stringField(value, "窗口") ?? "未知章节";
  const trimmed = rawRange.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed;
  }

  const parts = trimmed
    .replace(/\s+/gu, "")
    .split(/(?:-|~|至|—|–)/u)
    .filter((part) => part !== "");
  if (parts.length === 0) {
    return "[未知章节]";
  }
  if (parts.length === 1) {
    return `[${formatChapterPart(parts[0])}]`;
  }

  return `[${formatChapterPart(parts[0])}-${formatChapterPart(parts[parts.length - 1])}]`;
}

function formatBriefRetryDelay(value: unknown): string {
  const delayMs = numberField(value, "下次重试延迟毫秒");
  if (delayMs === undefined) {
    return "稍后";
  }
  const totalSeconds = Math.max(0, Math.ceil(delayMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return [
      `${hours}小时`,
      ...(minutes > 0 ? [`${minutes}分`] : []),
      ...(seconds > 0 ? [`${seconds}秒`] : [])
    ].join("");
  }
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}分${seconds}秒` : `${minutes}分钟`;
  }
  return `${totalSeconds}秒`;
}

function compactReason(value: unknown): string {
  const reason = stringField(value, "原因") ?? stringField(value, "错误") ?? asText(value) ?? "未知原因";
  const compact = reason.replace(/\s+/gu, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

function summarizeBriefEvent(kind: string | undefined, value: unknown): string {
  const template = ensureTemplateLabel(stringField(value, "模板") ?? stringField(value, "模板名称") ?? "未知");
  const chapterRange = formatChapterRangeLabel(value);
  const target = `${template}的${chapterRange}`;

  if (kind === "执行中") {
    return `[执行中]：${target}开始分析`;
  }
  if (kind === "执行成功") {
    return `[执行成功]：${target}执行成功`;
  }
  if (kind === "限流") {
    return `[限流]：${target}执行限流，${formatBriefRetryDelay(value)}后再次尝试`;
  }
  if (kind === "执行失败") {
    return `[执行失败]：${target}执行失败，原因：${compactReason(value)}`;
  }

  return fallbackMessage(["简要流程", kind ?? "事件"]);
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

function toolOutputFileName(value: unknown): string {
  const args = rawToolValue(value);
  return fileName(args?.outputFileName, "未指定报告");
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

function isToolLoopRoundReason(value: unknown): value is ToolLoopRoundReason {
  return typeof value === "string" && value in TOOL_LOOP_ROUND_REASON_LABELS;
}

function continuationReasonLabel(value: unknown): string | undefined {
  const explicit = stringField(value, "继续原因");
  if (explicit) {
    return explicit;
  }

  const reasonTag = stringField(value, "继续原因标签");
  return isToolLoopRoundReason(reasonTag) ? TOOL_LOOP_ROUND_REASON_LABELS[reasonTag] : undefined;
}

function appendContinuationReason(message: string, value: unknown): string {
  const reason = continuationReasonLabel(value);
  return reason ? `${message}，继续原因：${reason}` : message;
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

function summarizeCoveragePrecheck(value: unknown): string {
  const totalCount = numberField(value, "窗口总数") ?? 0;
  const coveredCount = numberField(value, "已覆盖窗口数") ?? 0;
  const pendingCount = numberField(value, "待处理窗口数") ?? 0;
  const pendingWindows = (arrayField(value, "待处理窗口") ?? []).filter(
    (item): item is string => typeof item === "string" && item.trim() !== ""
  );
  const compactPendingWindows = pendingWindows.map((item, index) =>
    index === 0 ? item : item.replace(/^窗口\s*/u, "")
  );
  const pendingSuffix = compactPendingWindows.length > 0 ? `（${compactPendingWindows.join("、")}）` : "";

  return `覆盖索引预检：${totalCount} 个窗口，${coveredCount} 个已覆盖，${pendingCount} 个待处理${pendingSuffix}`;
}

function summarizeCoverageSkippedWindow(value: unknown): string {
  const windowText = stringField(value, "窗口") ?? "?/?";
  const windowFileName = stringField(value, "窗口文件") ?? "未知窗口文件";
  return `窗口 ${windowText}（${windowFileName}）已经提取过，跳过`;
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
  let message: string;
  if (missing) {
    message = `继续补齐结果：缺少 ${missing}`;
    return appendContinuationReason(message, value);
  }

  const missingCount = stringField(value, "缺失数量") ?? /还缺\s*(\d+)\s*个/u.exec(text)?.[1];
  if (missingCount) {
    message = `继续补齐结果：还缺 ${missingCount} 个模板处理结果`;
    return appendContinuationReason(message, value);
  }

  message = "继续补齐结果：检查未完成模板";
  return appendContinuationReason(message, value);
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

function summarizeToolLoopReasonSummary(value: unknown): string {
  const windowText = stringField(value, "窗口") ?? "?/?";
  const reasonCounts = objectField(value, "原因计数") ?? {};
  const orderedCounts = Object.entries(reasonCounts)
    .filter((entry): entry is [ToolLoopRoundReason, number] => isToolLoopRoundReason(entry[0]) && typeof entry[1] === "number" && entry[1] > 0)
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return TOOL_LOOP_ROUND_REASON_ORDER.indexOf(left[0]) - TOOL_LOOP_ROUND_REASON_ORDER.indexOf(right[0]);
    });
  const summary =
    orderedCounts.length > 0
      ? orderedCounts.map(([reason, count]) => `${TOOL_LOOP_ROUND_REASON_LABELS[reason]} ${count} 次`).join("，")
      : "无";

  return `窗口 ${windowText} 多轮原因：${summary}`;
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
    const message = target ? `${recoverableLabel}：${target}` : recoverableLabel;
    const reason = continuationReasonLabel(value);
    return reason ? `${message}，继续原因：${reason}` : `${message}，模型将重试`;
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

function summarizeAutoRetry(value: unknown): string {
  const event = stringField(value, "事件") ?? asText(value) ?? "已记录";
  const interval = stringField(value, "下次间隔") ?? "稍后";

  if (event === "触发") {
    return "自动续跑触发：正在重新入队";
  }
  if (event === "已接收") {
    return "自动续跑已进入运行或排队，停止本轮定时重试";
  }
  if (event === "等待下次") {
    return `自动续跑本次仍未成功，${interval}后再次尝试`;
  }
  if (event === "跳过") {
    return "自动续跑跳过：当前任务状态已变化";
  }

  return `自动续跑：${event}`;
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
  } else if (firstTag === "简要流程") {
    message = summarizeBriefEvent(secondTag, entry.value);
  } else if (firstTag === "上下文" && secondTag === "任务") {
    message = "加载任务上下文：书籍、模板、规则快照和报告目录已准备";
  } else if (firstTag === "上下文" && secondTag === "覆盖索引") {
    message = summarizeCoverageIndex(entry.value);
  } else if (firstTag === "上下文" && secondTag === "覆盖索引预检") {
    message = summarizeCoveragePrecheck(entry.value);
  } else if (firstTag === "上下文" && secondTag === "覆盖索引跳过窗口") {
    message = summarizeCoverageSkippedWindow(entry.value);
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
  } else if (firstTag === "上下文" && secondTag === "多轮原因汇总") {
    message = summarizeToolLoopReasonSummary(entry.value);
  } else if (firstTag === "错误" && secondTag === "窗口") {
    message = summarizeWindowError(entry.value);
  } else if (firstTag === "错误" && secondTag === "任务") {
    message = summarizeTaskError(entry.value);
  } else if (firstTag === "警告" && secondTag === "bash") {
    message = summarizeWarning(entry.value);
  } else if (firstTag === "自动续跑") {
    message = summarizeAutoRetry(entry.value);
  } else {
    message = fallbackMessage(entry.tags);
  }

  return withTime(entry, message);
}
