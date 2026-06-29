import type { MenuItemConfig, NovelExtractorConfig, TaskAction } from "./schema";

export class ConfigInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigInvariantError";
  }
}

const ALLOWED_TASK_ACTIONS = new Set<TaskAction>(["start", "pause", "resume", "delete"]);
const REQUIRED_TASK_ACTIONS: TaskAction[] = ["start", "pause", "resume", "delete"];

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) {
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
  if (
    config.extractionParameterDefaults.extractionChapterCount <
    config.extractionParameterDefaults.singleRunChapterCount
  ) {
    throw new ConfigInvariantError(
      "extraction chapter count must be greater than or equal to single run chapter count."
    );
  }

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
  assertNonEmpty(config.menu.workbenchNavigation.topFunctionLabel, "top function label");
  assertMenuItemsHaveLabels(
    [
      ...config.menu.mainNavigation,
      ...config.menu.userMenu,
      ...config.menu.workbenchNavigation.topFunctionItems,
      config.menu.workbenchNavigation.railAssetItem,
      ...config.menu.workbenchNavigation.railFunctionItems,
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
