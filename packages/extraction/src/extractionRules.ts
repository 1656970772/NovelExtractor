import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface TemplateRulesSnapshot {
  templateId: string;
  templateName: string;
  templateBody: string;
  outputFileName: string;
  routeDescription?: string;
  groupId: string;
  templateHash?: string;
}

export interface TemplateGroupRulesSnapshot {
  groupId: string;
  groupDisplayName: string;
  templateIds: string[];
  maxFullTemplatesPerCall: number;
  groupHash?: string;
}

export interface RouteFailurePolicy {
  maxRetries: number;
  fallbackStrategy: "none" | "semanticRuleFilter" | "matchAll";
  fallbackSource: "runtimePolicySnapshot" | "rulesSnapshot";
  onFallbackNoMatch: "no-update" | "blocked_for_user";
}

export interface ExtractionRuleSections {
  commonExtractionRules: string[];
  writeRules: string[];
  skipAlreadyExtractedRules: string[];
}

export interface GenerateExtractionRulesInput {
  projectRoot: string;
  jobId: string;
  bookId: string;
  bookDisplayName: string;
  templates: TemplateRulesSnapshot[];
  groups: TemplateGroupRulesSnapshot[];
  routeFailurePolicy: RouteFailurePolicy;
  ruleSections: ExtractionRuleSections;
  generatedAt?: string;
}

export interface GenerateExtractionRulesResult {
  rulesSnapshotPath: string;
  rulesLatestPath: string;
  rulesDocumentHash: string;
  rulesSemanticHash: string;
  content: string;
  semanticContent: string;
}

export type ExtractionRulesErrorCode =
  | "INVALID_JOB_ID"
  | "INVALID_INPUT"
  | "EMPTY_TEMPLATES"
  | "EMPTY_GROUPS"
  | "UNKNOWN_GROUP_TEMPLATE"
  | "UNKNOWN_TEMPLATE_GROUP"
  | "SNAPSHOT_ALREADY_EXISTS";

export class ExtractionRulesError extends Error {
  readonly code: ExtractionRulesErrorCode;

  constructor(code: ExtractionRulesErrorCode, message: string) {
    super(message);
    this.name = "ExtractionRulesError";
    this.code = code;
  }
}

interface NormalizedRulesSnapshot {
  groups: NormalizedTemplateGroup[];
  routeFailurePolicy: RouteFailurePolicy;
  ruleSections: ExtractionRuleSections;
}

interface NormalizedTemplateGroup {
  groupId: string;
  groupDisplayName: string;
  templateIds: string[];
  maxFullTemplatesPerCall: number;
  groupHash?: string;
  templates: TemplateRulesSnapshot[];
}

const RULES_FILE_NAME = "提取规则.md";
const RULES_SNAPSHOT_PATH_SEGMENTS = ["runs", "{jobId}", "rules", RULES_FILE_NAME] as const;
const RULES_LATEST_PATH = joinRelativePath("rules", RULES_FILE_NAME);

export async function generateExtractionRules(input: GenerateExtractionRulesInput): Promise<GenerateExtractionRulesResult> {
  const normalizedSnapshot = normalizeRulesSnapshot(input);
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const rulesSnapshotPath = joinRelativePath("runs", input.jobId, "rules", RULES_FILE_NAME);
  const rulesLatestPath = RULES_LATEST_PATH;
  const semanticContent = buildSemanticContent(normalizedSnapshot);
  const content = buildRulesDocument({
    input,
    generatedAt,
    rulesSnapshotPath,
    rulesLatestPath,
    semanticContent
  });
  const snapshotAbsolutePath = path.join(input.projectRoot, ...RULES_SNAPSHOT_PATH_SEGMENTS.map((segment) => segment === "{jobId}" ? input.jobId : segment));
  const latestAbsolutePath = path.join(input.projectRoot, "rules", RULES_FILE_NAME);

  await fs.mkdir(path.dirname(snapshotAbsolutePath), { recursive: true });
  await fs.mkdir(path.dirname(latestAbsolutePath), { recursive: true });
  await writeImmutableSnapshot(snapshotAbsolutePath, content);
  await fs.writeFile(latestAbsolutePath, content, "utf8");

  return {
    rulesSnapshotPath,
    rulesLatestPath,
    rulesDocumentHash: sha256(content),
    rulesSemanticHash: sha256(semanticContent),
    content,
    semanticContent
  };
}

async function writeImmutableSnapshot(snapshotAbsolutePath: string, content: string): Promise<void> {
  try {
    await fs.writeFile(snapshotAbsolutePath, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new ExtractionRulesError(
        "SNAPSHOT_ALREADY_EXISTS",
        `Extraction rules snapshot already exists: ${snapshotAbsolutePath}`
      );
    }
    throw error;
  }
}

function normalizeRulesSnapshot(input: GenerateExtractionRulesInput): NormalizedRulesSnapshot {
  assertSafeJobId(input.jobId);
  assertRuleSections(input.ruleSections);

  if (input.templates.length === 0) {
    throw new ExtractionRulesError("EMPTY_TEMPLATES", "At least one template snapshot is required");
  }
  if (input.groups.length === 0) {
    throw new ExtractionRulesError("EMPTY_GROUPS", "At least one template group snapshot is required");
  }

  const templatesById = new Map<string, TemplateRulesSnapshot>();
  for (const template of input.templates) {
    assertNonEmptyString(template.templateId, "Template id is required");
    assertUniqueId(templatesById, template.templateId, `Duplicate template id "${template.templateId}"`);
    assertNonEmptyString(template.templateName, `Template "${template.templateId}" name is required`);
    assertNonEmptyString(template.templateBody, `Template "${template.templateId}" body is required`);
    assertSafeOutputFileName(template.outputFileName, `Template "${template.templateId}" outputFileName must be a file name`);
    assertNonEmptyString(template.groupId, `Template "${template.templateId}" groupId is required`);
    templatesById.set(template.templateId, template);
  }

  const groupsById = new Map<string, TemplateGroupRulesSnapshot>();
  for (const group of input.groups) {
    assertNonEmptyString(group.groupId, "Group id is required");
    assertUniqueId(groupsById, group.groupId, `Duplicate group id "${group.groupId}"`);
    assertNonEmptyString(group.groupDisplayName, `Group "${group.groupId}" display name is required`);
    assertPositiveInteger(
      group.maxFullTemplatesPerCall,
      `Group "${group.groupId}" maxFullTemplatesPerCall must be a positive integer`
    );
    if (group.templateIds.length === 0) {
      throw new ExtractionRulesError("INVALID_INPUT", `Group "${group.groupId}" must reference at least one template`);
    }
    for (const templateId of group.templateIds) {
      assertNonEmptyString(templateId, `Group "${group.groupId}" templateIds cannot contain empty ids`);
    }
    groupsById.set(group.groupId, group);
  }

  assertRouteFailurePolicy(input.routeFailurePolicy);

  for (const template of input.templates) {
    if (!groupsById.has(template.groupId)) {
      throw new ExtractionRulesError(
        "UNKNOWN_TEMPLATE_GROUP",
        `Template "${template.templateId}" references missing group "${template.groupId}"`
      );
    }
  }

  const groups = [...input.groups]
    .sort((left, right) => left.groupId.localeCompare(right.groupId))
    .map((group) => ({
      ...group,
      templateIds: [...group.templateIds],
      templates: group.templateIds.map((templateId) => {
        const template = templatesById.get(templateId);
        if (!template) {
          throw new ExtractionRulesError(
            "UNKNOWN_GROUP_TEMPLATE",
            `Group "${group.groupId}" references missing template "${templateId}"`
          );
        }
        return template;
      })
    }));

  return {
    groups,
    routeFailurePolicy: input.routeFailurePolicy,
    ruleSections: input.ruleSections
  };
}

function buildRulesDocument(input: {
  input: GenerateExtractionRulesInput;
  generatedAt: string;
  rulesSnapshotPath: string;
  rulesLatestPath: string;
  semanticContent: string;
}): string {
  return normalizeLineEndings(`# 提取规则

> 任务：${input.input.jobId}
> 书籍 ID：${input.input.bookId}
> 书籍名称：${input.input.bookDisplayName}
> 生成时间：${input.generatedAt}
> 运行级规则快照：${input.rulesSnapshotPath}
> 项目级 latest copy：${input.rulesLatestPath}
> 规则来源：模板快照、模板组快照、运行策略快照

${input.semanticContent}`);
}

function buildSemanticContent(snapshot: NormalizedRulesSnapshot): string {
  const lines = [
    "## 通用抽取规则",
    ...snapshot.ruleSections.commonExtractionRules.map((rule) => `- ${rule}`),
    "",
    "## 模板路由规则",
    "| 模板组 | 模板 | 输出文档 | 路由说明 | 不确定时策略 |",
    "| --- | --- | --- | --- | --- |",
    ...snapshot.groups.flatMap((group) =>
      group.templates.map((template) =>
        [
          group.groupDisplayName,
          template.templateName,
          template.outputFileName,
          template.routeDescription?.trim() || "按模板名称、输出文件名和模板正文判断是否相关。",
          describeFallbackStrategy(snapshot.routeFailurePolicy)
        ].map(escapeTableCell).join(" | ")
      ).map((row) => `| ${row} |`)
    ),
    "",
    "## 模板组快照",
    ...snapshot.groups.flatMap((group) => [
      `### ${group.groupDisplayName}`,
      "",
      `- groupId: ${group.groupId}`,
      `- groupHash: ${group.groupHash ?? ""}`,
      `- maxFullTemplatesPerCall: ${group.maxFullTemplatesPerCall}`,
      `- templateIds: ${group.templateIds.join(", ")}`,
      "",
      ...group.templates.flatMap((template) => [
        `#### ${template.templateName}`,
        "",
        `- templateId: ${template.templateId}`,
        `- groupId: ${template.groupId}`,
        `- outputFileName: ${template.outputFileName}`,
        `- routeDescription: ${template.routeDescription?.trim() ?? ""}`,
        `- templateHash: ${template.templateHash ?? ""}`,
        "- templateBody:",
        indentBlock(template.templateBody),
        ""
      ])
    ]),
    "## 路由失败策略",
    `- maxRetries: ${snapshot.routeFailurePolicy.maxRetries}`,
    `- fallbackStrategy: ${snapshot.routeFailurePolicy.fallbackStrategy}`,
    `- fallbackSource: ${snapshot.routeFailurePolicy.fallbackSource}`,
    `- onFallbackNoMatch: ${snapshot.routeFailurePolicy.onFallbackNoMatch}`,
    "",
    "## 路由模型返回格式",
    "- 路由模型只返回本次模板组快照中存在的 matchedGroupIds。",
    "- Runtime 根据 matchedGroupIds 展开模板 ID、输出文件名和完整模板正文。",
    "- 路由模型不得返回模板 ID、输出文件名、confidence 或其它执行字段。",
    "",
    "## 写入规则",
    ...snapshot.ruleSections.writeRules.map((rule) => `- ${rule}`),
    "",
    "## 跳过已提取策略",
    ...snapshot.ruleSections.skipAlreadyExtractedRules.map((rule) => `- ${rule}`),
    ""
  ];

  return normalizeLineEndings(lines.join("\n"));
}

function assertRuleSections(ruleSections: ExtractionRuleSections): void {
  if (!ruleSections || typeof ruleSections !== "object") {
    throw new ExtractionRulesError("INVALID_INPUT", "Rule sections are required");
  }

  assertRuleArray(ruleSections.commonExtractionRules, "commonExtractionRules");
  assertRuleArray(ruleSections.writeRules, "writeRules");
  assertRuleArray(ruleSections.skipAlreadyExtractedRules, "skipAlreadyExtractedRules");
}

function assertRuleArray(value: unknown, name: string): void {
  if (!Array.isArray(value)) {
    throw new ExtractionRulesError("INVALID_INPUT", `Rule section "${name}" must be an array`);
  }

  value.forEach((rule, index) => {
    if (typeof rule !== "string" || !rule.trim()) {
      throw new ExtractionRulesError("INVALID_INPUT", `Rule section "${name}" contains an empty rule at index ${index}`);
    }
  });
}

function assertSafeJobId(value: string): void {
  assertNonEmptyString(value, "Job id must be a single path segment", "INVALID_JOB_ID");

  if (isUnsafePathSegment(value)) {
    throw new ExtractionRulesError("INVALID_JOB_ID", "Job id must be a single path segment");
  }
}

function assertSafeOutputFileName(value: string, message: string): void {
  assertNonEmptyString(value, message);

  if (isUnsafePathSegment(value)) {
    throw new ExtractionRulesError("INVALID_INPUT", message);
  }
}

function isUnsafePathSegment(value: string): boolean {
  const trimmed = value.trim();

  return (
    trimmed === "." ||
    trimmed === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.win32.isAbsolute(value) ||
    path.posix.isAbsolute(value) ||
    /^[a-zA-Z]:/.test(value)
  );
}

function assertNonEmptyString(
  value: string,
  message: string,
  code: ExtractionRulesErrorCode = "INVALID_INPUT"
): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new ExtractionRulesError(code, message);
  }
}

function assertUniqueId<T>(itemsById: Map<string, T>, id: string, message: string): void {
  if (itemsById.has(id)) {
    throw new ExtractionRulesError("INVALID_INPUT", message);
  }
}

function assertPositiveInteger(value: number, message: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ExtractionRulesError("INVALID_INPUT", message);
  }
}

function assertRouteFailurePolicy(policy: RouteFailurePolicy): void {
  if (!policy || typeof policy !== "object") {
    throw new ExtractionRulesError("INVALID_INPUT", "Route failure policy is required");
  }

  if (!Number.isInteger(policy.maxRetries) || policy.maxRetries < 0) {
    throw new ExtractionRulesError("INVALID_INPUT", "routeFailurePolicy.maxRetries must be a non-negative integer");
  }
  if (!isAllowedValue(policy.fallbackStrategy, ["none", "semanticRuleFilter", "matchAll"])) {
    throw new ExtractionRulesError("INVALID_INPUT", "routeFailurePolicy.fallbackStrategy is invalid");
  }
  if (!isAllowedValue(policy.fallbackSource, ["runtimePolicySnapshot", "rulesSnapshot"])) {
    throw new ExtractionRulesError("INVALID_INPUT", "routeFailurePolicy.fallbackSource is invalid");
  }
  if (!isAllowedValue(policy.onFallbackNoMatch, ["no-update", "blocked_for_user"])) {
    throw new ExtractionRulesError("INVALID_INPUT", "routeFailurePolicy.onFallbackNoMatch is invalid");
  }
}

function isAllowedValue(value: unknown, allowedValues: readonly string[]): value is string {
  return typeof value === "string" && allowedValues.includes(value);
}

function describeFallbackStrategy(policy: RouteFailurePolicy): string {
  if (policy.fallbackStrategy === "none") {
    return `最多重试 ${policy.maxRetries} 次，失败后不 fallback。`;
  }
  return `最多重试 ${policy.maxRetries} 次，失败后使用 ${policy.fallbackStrategy}，无命中时 ${policy.onFallbackNoMatch}。`;
}

function escapeTableCell(value: string): string {
  return normalizeLineEndings(value).replace(/\n/g, "<br>").replace(/\|/g, "\\|");
}

function indentBlock(value: string): string {
  const normalized = normalizeLineEndings(value).trimEnd();
  if (!normalized) {
    return "    ";
  }
  return normalized.split("\n").map((line) => `    ${line}`).join("\n");
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function joinRelativePath(...segments: string[]): string {
  return segments.join("/");
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}
