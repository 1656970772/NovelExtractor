import type {
  BatchOutcomeKeyMode,
  CoverageIndexCorruptionStrategy,
  MenuItemConfig,
  NovelExtractorConfig,
  QuantityPolicyDefaults,
  ReportPathPolicyMode,
  TaskAction,
  TemplateGroupFallbackStrategy,
  ToolLoopToolName
} from "./schema";

export class ConfigInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigInvariantError";
  }
}

const ALLOWED_TASK_ACTIONS = new Set<TaskAction>(["start", "pause", "resume", "delete"]);
const REQUIRED_TASK_ACTIONS: TaskAction[] = ["start", "pause", "resume", "delete"];
const ALLOWED_FALLBACK_STRATEGIES = new Set(["none", "semanticRuleFilter", "matchAll"]);
const ALLOWED_FALLBACK_SOURCES = new Set(["runtimePolicySnapshot", "rulesSnapshot"]);
const ALLOWED_FALLBACK_NO_MATCH_ACTIONS = new Set(["no-update", "blocked_for_user"]);
const ALLOWED_TEMPLATE_GROUP_FALLBACK_STRATEGIES = new Set<TemplateGroupFallbackStrategy>([
  "one-template-per-group",
  "by-output-file"
]);
const ALLOWED_BATCH_OUTCOME_KEY_MODES = new Set<BatchOutcomeKeyMode>([
  "outputFileName",
  "templateIdAndOutputFileName"
]);
const ALLOWED_COVERAGE_INDEX_CORRUPTION_STRATEGIES = new Set<CoverageIndexCorruptionStrategy>([
  "fail",
  "conservative-rerun"
]);
const ALLOWED_REPORT_PATH_POLICY_MODES = new Set<ReportPathPolicyMode>(["flat"]);
const ALLOWED_QUANTITY_EVIDENCE_SCOPES = new Set<QuantityPolicyDefaults["evidenceScope"]>([
  "current-window"
]);
const ALLOWED_TOOL_LOOP_TOOL_NAMES = new Set<ToolLoopToolName>([
  "read_file",
  "grep",
  "write_file",
  "edit_file",
  "multi_edit",
  "mark_no_update"
]);
const WINDOWS_DRIVE_PATH_PREFIX = /^[A-Za-z]:/;

function assertNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ConfigInvariantError(`${label} must be non-empty.`);
  }
}

function assertConfigObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigInvariantError(`${label} must be configured.`);
  }
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      throw new ConfigInvariantError(`${label} must be unique: ${value}.`);
    }
    seen.add(value);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigInvariantError(`${label} must be a positive integer.`);
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new ConfigInvariantError(`${label} must be a non-negative integer.`);
  }
}

function assertAllowedValue(value: string, allowedValues: Set<string>, label: string): void {
  if (!allowedValues.has(value)) {
    throw new ConfigInvariantError(`${label} is not allowed: ${value}.`);
  }
}

function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new ConfigInvariantError(`${label} must be a boolean.`);
  }
}

function assertNonEmptyRules(rules: unknown, label: string): void {
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new ConfigInvariantError(`${label} must contain at least one rule.`);
  }

  rules.forEach((rule, index) => {
    assertNonEmpty(rule, `${label} rule ${index + 1}`);
  });
}

function assertNonEmptyStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigInvariantError(`${label} must contain at least one value.`);
  }

  value.forEach((item, index) => {
    assertNonEmpty(item, `${label} ${index + 1}`);
  });
}

function assertSafeRawWindowReportFileNamePrefix(value: unknown): void {
  const label = "raw window report file name prefix";
  assertNonEmpty(value, label);

  if (value.includes("\0")) {
    throw new ConfigInvariantError(`${label} must not contain null characters.`);
  }
  if (/[\\/]/.test(value)) {
    throw new ConfigInvariantError(`${label} must not contain path separators.`);
  }
  if (WINDOWS_DRIVE_PATH_PREFIX.test(value.trim())) {
    throw new ConfigInvariantError(`${label} must not use absolute path semantics.`);
  }
  if (value.trim().toLowerCase().endsWith(".md")) {
    throw new ConfigInvariantError(`${label} must not include a .md suffix.`);
  }
}

function assertSafeRelativePath(value: unknown, label: string): asserts value is string {
  assertNonEmpty(value, label);

  const normalizedValue = value.replace(/\\/g, "/").trim();
  if (normalizedValue.startsWith("/") || WINDOWS_DRIVE_PATH_PREFIX.test(normalizedValue)) {
    throw new ConfigInvariantError(`${label} must be a relative path.`);
  }
  if (
    normalizedValue === "." ||
    normalizedValue === ".." ||
    normalizedValue.includes("../") ||
    normalizedValue.includes("/..")
  ) {
    throw new ConfigInvariantError(`${label} must not traverse directories.`);
  }
}

function assertRawWindowReportDefaults(config: NovelExtractorConfig): void {
  const rawWindowReportDefaults = (config as { rawWindowReportDefaults?: unknown })
    .rawWindowReportDefaults;

  if (
    rawWindowReportDefaults === null ||
    typeof rawWindowReportDefaults !== "object" ||
    Array.isArray(rawWindowReportDefaults)
  ) {
    throw new ConfigInvariantError("raw window report defaults must be configured.");
  }

  const defaults = rawWindowReportDefaults as Record<string, unknown>;
  assertSafeRawWindowReportFileNamePrefix(defaults.fileNamePrefix);
  assertNonEmpty(defaults.displayNamePrefix, "raw window report display name prefix");
}

function assertToolLoopDefaults(config: NovelExtractorConfig): void {
  const toolLoopDefaults = (config as { toolLoopDefaults?: unknown }).toolLoopDefaults;

  if (
    toolLoopDefaults === null ||
    typeof toolLoopDefaults !== "object" ||
    Array.isArray(toolLoopDefaults)
  ) {
    throw new ConfigInvariantError("tool loop defaults must be configured.");
  }

  const defaults = toolLoopDefaults as Record<string, unknown>;
  assertNonEmptyStringArray(defaults.enabledToolNames, "tool loop enabled tool names");
  assertUnique(defaults.enabledToolNames, "tool loop enabled tool names");
  defaults.enabledToolNames.forEach((toolName) => {
    assertAllowedValue(
      toolName,
      ALLOWED_TOOL_LOOP_TOOL_NAMES as Set<string>,
      "tool loop enabled tool name"
    );
  });
  assertNonEmpty(defaults.systemInstruction, "tool loop system instruction");
  assertNonEmptyStringArray(defaults.windowInstructionLines, "tool loop window instruction lines");
}

function assertTemplatePromptProfileDefaults(config: NovelExtractorConfig): void {
  assertConfigObject(config.templatePromptProfileDefaults, "template prompt profile defaults");
  const defaults = config.templatePromptProfileDefaults as Record<string, unknown>;

  assertNonEmpty(defaults.compressionVersion, "template prompt profile compression version");
  assertNonEmptyStringArray(
    defaults.exampleSectionPatterns,
    "template prompt profile example section patterns"
  );
  assertNonEmptyStringArray(
    defaults.referenceSectionPatterns,
    "template prompt profile reference section patterns"
  );
  assertNonEmptyStringArray(
    defaults.placeholderPatterns,
    "template prompt profile placeholder patterns"
  );
  assertNonEmptyStringArray(
    defaults.alwaysKeepHeadingPatterns,
    "template prompt profile always keep heading patterns"
  );
  if (typeof defaults.minProfileChars !== "number") {
    throw new ConfigInvariantError("template prompt profile min chars must be a positive integer.");
  }
  assertPositiveInteger(defaults.minProfileChars, "template prompt profile min chars");
}

function assertBatchOutcomeDefaults(config: NovelExtractorConfig): void {
  assertConfigObject(config.batchOutcomeDefaults, "batch outcome defaults");
  const defaults = config.batchOutcomeDefaults as Record<string, unknown>;

  assertAllowedValue(
    String(defaults.outcomeKeyMode),
    ALLOWED_BATCH_OUTCOME_KEY_MODES as Set<string>,
    "batch outcome key mode"
  );
  if (defaults.noUpdateToolName !== "mark_no_update") {
    throw new ConfigInvariantError("batch outcome no-update tool name must be mark_no_update.");
  }
  assertNonEmpty(
    defaults.missingOutcomeCorrectionTemplate,
    "batch outcome missing correction template"
  );
  if (typeof defaults.maxCorrectionRounds !== "number") {
    throw new ConfigInvariantError("batch outcome max correction rounds must be a positive integer.");
  }
  assertPositiveInteger(defaults.maxCorrectionRounds, "batch outcome max correction rounds");
}

function assertCoverageIndexDefaults(config: NovelExtractorConfig): void {
  assertConfigObject(config.coverageIndexDefaults, "coverage index defaults");
  const defaults = config.coverageIndexDefaults as Record<string, unknown>;

  assertSafeRelativePath(defaults.relativePath, "coverage index relative path");
  if (defaults.relativePath.replace(/\\/g, "/").toLowerCase().startsWith("reports/")) {
    throw new ConfigInvariantError("coverage index relative path must not be under reports.");
  }
  assertAllowedValue(
    String(defaults.corruptionStrategy),
    ALLOWED_COVERAGE_INDEX_CORRUPTION_STRATEGIES as Set<string>,
    "coverage index corruption strategy"
  );
  assertNonEmptyStringArray(defaults.keyFields, "coverage index key fields");
  assertUnique(defaults.keyFields, "coverage index key fields");
}

function assertReportPathPolicyDefaults(config: NovelExtractorConfig): void {
  assertConfigObject(config.reportPathPolicyDefaults, "report path policy defaults");
  const defaults = config.reportPathPolicyDefaults as Record<string, unknown>;

  assertAllowedValue(
    String(defaults.mode),
    ALLOWED_REPORT_PATH_POLICY_MODES as Set<string>,
    "report path policy mode"
  );
  assertNonEmpty(defaults.reportsAlias, "report path policy reports alias");
  assertBoolean(defaults.allowSubdirectories, "report path policy allow subdirectories");
  if (defaults.mode === "flat" && defaults.allowSubdirectories) {
    throw new ConfigInvariantError("flat report path policy must not allow subdirectories.");
  }
}

function assertRuleLayerDefaults(config: NovelExtractorConfig): void {
  assertConfigObject(config.ruleLayerDefaults, "rule layer defaults");
  const defaults = config.ruleLayerDefaults as Record<string, unknown>;

  assertNonEmptyRules(defaults.p0HardRules, "p0 hard rules");
  assertNonEmptyRules(defaults.qualityRules, "quality rules");
  assertNonEmptyRules(defaults.formatRules, "format rules");
  assertNonEmptyRules(defaults.postWriteGuards, "post write guards");
}

function assertQuantityPolicyDefaults(config: NovelExtractorConfig): void {
  assertConfigObject(config.quantityPolicyDefaults, "quantity policy defaults");
  const defaults = config.quantityPolicyDefaults as Record<string, unknown>;

  assertBoolean(defaults.allowZeroWhenNoEvidence, "quantity policy allow zero when no evidence");
  if (typeof defaults.defaultMinItemsWhenEvidenceExists !== "number") {
    throw new ConfigInvariantError(
      "quantity policy default minimum items when evidence exists must be a non-negative integer."
    );
  }
  assertNonNegativeInteger(
    defaults.defaultMinItemsWhenEvidenceExists,
    "quantity policy default minimum items when evidence exists"
  );
  assertAllowedValue(
    String(defaults.evidenceScope),
    ALLOWED_QUANTITY_EVIDENCE_SCOPES as Set<string>,
    "quantity policy evidence scope"
  );
}

function assertMenuItemsHaveLabels(items: MenuItemConfig[], label: string): void {
  for (const item of items) {
    assertNonEmpty(item.label, `${label} label for ${item.id}`);
    if (item.shortLabel !== undefined) {
      assertNonEmpty(item.shortLabel, `${label} short label for ${item.id}`);
    }
    if (item.imageSrc !== undefined) {
      assertNonEmpty(item.imageSrc, `${label} image src for ${item.id}`);
    }
  }
}

export function assertValidConfigInvariants(config: NovelExtractorConfig): void {
  assertUnique(
    config.providerPresets.map((provider) => provider.id),
    "provider preset id"
  );

  for (const provider of config.providerPresets) {
    for (const model of provider.models) {
      assertNonEmpty(model.id, `model id for provider ${provider.id}`);
    }
  }

  for (const template of config.builtInTemplates) {
    assertNonEmpty(template.name, "template name");
    assertNonEmpty(template.defaultOutputFileName, "template default output file name");
  }

  assertPositiveInteger(
    config.extractionParameterDefaults.singleRunChapterCount,
    "single run chapter count"
  );
  assertPositiveInteger(
    config.extractionParameterDefaults.extractionChapterCount,
    "extraction chapter count"
  );
  assertNonNegativeInteger(
    config.extractionParameterDefaults.overlapChapterCount,
    "overlap chapter count"
  );
  if (
    config.extractionParameterDefaults.extractionChapterCount <
    config.extractionParameterDefaults.singleRunChapterCount
  ) {
    throw new ConfigInvariantError(
      "extraction chapter count must be greater than or equal to single run chapter count."
    );
  }
  if (
    config.extractionParameterDefaults.overlapChapterCount >=
    config.extractionParameterDefaults.singleRunChapterCount
  ) {
    throw new ConfigInvariantError(
      "overlap chapter count must be less than single run chapter count."
    );
  }

  assertNonNegativeInteger(
    config.extractionRuleDefaults.routeFailurePolicy.maxRetries,
    "route failure max retries"
  );
  assertAllowedValue(
    config.extractionRuleDefaults.routeFailurePolicy.fallbackStrategy,
    ALLOWED_FALLBACK_STRATEGIES,
    "fallback strategy"
  );
  assertAllowedValue(
    config.extractionRuleDefaults.routeFailurePolicy.fallbackSource,
    ALLOWED_FALLBACK_SOURCES,
    "fallback source"
  );
  assertAllowedValue(
    config.extractionRuleDefaults.routeFailurePolicy.onFallbackNoMatch,
    ALLOWED_FALLBACK_NO_MATCH_ACTIONS,
    "fallback no match"
  );
  assertNonEmptyRules(
    config.extractionRuleDefaults.ruleSections.commonExtractionRules,
    "common extraction rules"
  );
  assertNonEmptyRules(config.extractionRuleDefaults.ruleSections.writeRules, "write rules");
  assertNonEmptyRules(
    config.extractionRuleDefaults.ruleSections.skipAlreadyExtractedRules,
    "skip already extracted rules"
  );
  assertAllowedValue(
    config.extractionRuleDefaults.templateGroupFallbackStrategy,
    ALLOWED_TEMPLATE_GROUP_FALLBACK_STRATEGIES,
    "template group fallback strategy"
  );
  const templateBatching = (config.extractionRuleDefaults as { templateBatching?: unknown })
    .templateBatching;
  assertConfigObject(templateBatching, "template batching defaults");
  assertPositiveInteger(
    templateBatching.maxTemplatesPerCall as number,
    "template batching max templates per call"
  );
  assertPositiveInteger(
    templateBatching.promptBudgetChars as number,
    "template batching prompt budget chars"
  );
  if (!Array.isArray(templateBatching.nonMergeableTemplateTags)) {
    throw new ConfigInvariantError("template batching non-mergeable template tags must be an array.");
  }
  const nonMergeableTemplateTags = templateBatching.nonMergeableTemplateTags;
  nonMergeableTemplateTags.forEach((tag, index) => {
    assertNonEmpty(tag, `template batching non-mergeable template tag ${index + 1}`);
  });
  assertUnique(nonMergeableTemplateTags, "template batching non-mergeable template tags");
  assertPositiveInteger(
    config.extractionRuleDefaults.maxFullTemplatesPerCall,
    "max full templates per call"
  );
  if (
    config.extractionRuleDefaults.maxFullTemplatesPerCall !==
    templateBatching.maxTemplatesPerCall
  ) {
    throw new ConfigInvariantError(
      "max full templates per call must match template batching max templates per call."
    );
  }
  assertRawWindowReportDefaults(config);
  assertToolLoopDefaults(config);
  assertTemplatePromptProfileDefaults(config);
  assertBatchOutcomeDefaults(config);
  assertCoverageIndexDefaults(config);
  assertReportPathPolicyDefaults(config);
  assertRuleLayerDefaults(config);
  assertQuantityPolicyDefaults(config);

  assertUnique(
    [...config.menu.mainNavigation, ...config.menu.userMenu].map((item) => item.id),
    "menu item id"
  );
  assertUnique(
    config.menu.workbenchNavigation.topFunctionItems.map((item) => item.id),
    "top function item id"
  );
  assertUnique(
    config.menu.workbenchNavigation.railFunctionItems.map((item) => item.id),
    "rail function item id"
  );
  assertUnique(
    config.menu.workbenchNavigation.railUtilityItems.map((item) => item.id),
    "rail utility item id"
  );
  assertNonEmpty(config.menu.workbenchNavigation.topFunctionLabel, "top function label");
  assertMenuItemsHaveLabels(
    [
      ...config.menu.mainNavigation,
      ...config.menu.userMenu,
      ...config.menu.workbenchNavigation.topFunctionItems,
      config.menu.workbenchNavigation.railAssetItem,
      ...config.menu.workbenchNavigation.railFunctionItems,
      ...config.menu.workbenchNavigation.railUtilityItems,
      config.menu.workbenchNavigation.languageAction,
      config.menu.workbenchNavigation.userAction
    ],
    "menu item"
  );

  if (config.menu.workbenchNavigation.topFunctionItems.some((item) => item.id === "assets")) {
    throw new ConfigInvariantError("top function menu must not include assets.");
  }

  for (const action of REQUIRED_TASK_ACTIONS) {
    assertNonEmpty(config.taskActions[action].label, `task action label for ${action}`);
  }

  for (const [status, entry] of Object.entries(config.taskStatus)) {
    for (const action of entry.allowedActions as string[]) {
      if (!ALLOWED_TASK_ACTIONS.has(action as TaskAction)) {
        throw new ConfigInvariantError(`task action for status ${status} is not allowed: ${action}.`);
      }
    }
  }
}
