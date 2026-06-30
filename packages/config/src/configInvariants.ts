import type {
  MenuItemConfig,
  NovelExtractorConfig,
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
const ALLOWED_TOOL_LOOP_TOOL_NAMES = new Set<ToolLoopToolName>([
  "read_file",
  "grep",
  "write_file",
  "edit_file",
  "multi_edit"
]);
const WINDOWS_DRIVE_PATH_PREFIX = /^[A-Za-z]:/;

function assertNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ConfigInvariantError(`${label} must be non-empty.`);
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

function assertNonEmptyRules(rules: string[], label: string): void {
  if (rules.length === 0) {
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
  if (typeof defaults.maxRounds !== "number") {
    throw new ConfigInvariantError("tool loop max rounds must be a positive integer.");
  }
  assertPositiveInteger(defaults.maxRounds, "tool loop max rounds");
  assertNonEmpty(defaults.systemInstruction, "tool loop system instruction");
  assertNonEmptyStringArray(defaults.windowInstructionLines, "tool loop window instruction lines");
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
  assertPositiveInteger(
    config.extractionRuleDefaults.maxFullTemplatesPerCall,
    "max full templates per call"
  );
  assertRawWindowReportDefaults(config);
  assertToolLoopDefaults(config);

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
