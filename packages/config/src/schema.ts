import { assertValidConfigInvariants } from "./configInvariants";

export type ProviderKind = "openai-compatible";

export type ProviderPresetId = "deepseek" | "custom-openai-compatible";

export interface ModelOption {
  id: string;
  displayName: string;
  contextWindow?: number;
  supportsTools: boolean;
  supportsReasoning: boolean;
  usageMapping: "openai-compatible";
}

export interface ProviderPreset {
  id: ProviderPresetId;
  displayName: string;
  kind: ProviderKind;
  baseUrl?: string;
  authScheme: "bearer";
  models: ModelOption[];
  defaultModelPolicy: "first-enabled" | "user-required";
  allowsUserModels: boolean;
}

export type TemplateId = "pill-analysis";

export interface BuiltInTemplate {
  id: TemplateId;
  name: string;
  description: string;
  defaultOutputFileName: string;
}

export interface ExtractionParameterDefaults {
  singleRunChapterCount: number;
  extractionChapterCount: number;
  overlapChapterCount: number;
}

export interface RouteFailurePolicyConfig {
  maxRetries: number;
  fallbackStrategy: "none" | "semanticRuleFilter" | "matchAll";
  fallbackSource: "runtimePolicySnapshot" | "rulesSnapshot";
  onFallbackNoMatch: "no-update" | "blocked_for_user";
}

export interface ExtractionRuleSectionDefaults {
  commonExtractionRules: string[];
  writeRules: string[];
  skipAlreadyExtractedRules: string[];
}

export type TemplateGroupFallbackStrategy = "one-template-per-group" | "by-output-file";

export interface ExtractionRuleDefaults {
  routeFailurePolicy: RouteFailurePolicyConfig;
  ruleSections: ExtractionRuleSectionDefaults;
  templateGroupFallbackStrategy: TemplateGroupFallbackStrategy;
  maxFullTemplatesPerCall: number;
}

export interface RawWindowReportDefaults {
  fileNamePrefix: string;
  displayNamePrefix: string;
}

export type ToolLoopToolName = "read_file" | "grep" | "write_file" | "edit_file" | "multi_edit";

export interface ToolLoopDefaults {
  enabledToolNames: ToolLoopToolName[];
  maxRounds: number;
  systemInstruction: string;
  windowInstructionLines: string[];
}

export interface ReportFileNameInput {
  name: string;
  outputFileName?: string;
}

export type TaskAction = "start" | "pause" | "resume" | "delete";

export type TaskStatus = "pending" | "running" | "paused" | "completed" | "failed";

export interface TaskActionEntry {
  label: string;
}

export type TaskActionConfig = Record<TaskAction, TaskActionEntry>;

export interface TaskStatusEntry {
  label: string;
  allowedActions: TaskAction[];
}

export type TaskStatusConfig = Record<TaskStatus, TaskStatusEntry>;

export type AssetKind = "book";

export interface AssetTypeConfig {
  id: AssetKind;
  label: string;
}

export type MenuItemId =
  | "assets"
  | "extraction"
  | "graph"
  | "provider-settings"
  | "desktop-settings"
  | "language"
  | "user-menu";

export interface MenuItemConfig {
  id: MenuItemId;
  label: string;
  shortLabel?: string;
  imageSrc?: string;
}

export interface WorkbenchNavigationConfig {
  topFunctionLabel: string;
  topFunctionItems: MenuItemConfig[];
  railAssetItem: MenuItemConfig;
  railFunctionItems: MenuItemConfig[];
  languageAction: MenuItemConfig;
  userAction: MenuItemConfig;
}

export interface MenuConfig {
  mainNavigation: MenuItemConfig[];
  userMenu: MenuItemConfig[];
  workbenchNavigation: WorkbenchNavigationConfig;
}

export interface ThemeTokens {
  color: {
    appBackground: string;
    surface: string;
    surfacePaper: string;
    surfaceRaised: string;
    textPrimary: string;
    textMuted: string;
    inkSoft: string;
    accent: string;
    accentHover: string;
    accentSoft: string;
    onAccent: string;
    selected: string;
    progress: string;
    success: string;
    warning: string;
    danger: string;
    dangerSoft: string;
    infoSoft: string;
    graphLine: string;
    border: string;
    borderStrong: string;
  };
  shadow: {
    panel: string;
    control: string;
  };
  radius: {
    card: number;
    control: number;
  };
  motion: {
    intensity: number;
    durationMs: number;
  };
}

export interface NovelExtractorConfig {
  providerPresets: ProviderPreset[];
  builtInTemplates: BuiltInTemplate[];
  extractionParameterDefaults: ExtractionParameterDefaults;
  extractionRuleDefaults: ExtractionRuleDefaults;
  rawWindowReportDefaults: RawWindowReportDefaults;
  toolLoopDefaults: ToolLoopDefaults;
  taskActions: TaskActionConfig;
  taskStatus: TaskStatusConfig;
  assetTypes: AssetTypeConfig[];
  menu: MenuConfig;
  themeTokens: ThemeTokens;
}

export function defineNovelExtractorConfig(config: NovelExtractorConfig): NovelExtractorConfig {
  assertValidConfigInvariants(config);
  return config;
}
