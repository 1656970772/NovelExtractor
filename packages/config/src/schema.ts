import { assertValidConfigInvariants } from "./configInvariants";

export type ProviderKind = "openai-compatible";

export type ProviderApiFormat =
  | "openai_chat"
  | "openai_responses"
  | "anthropic_messages"
  | "gemini_generate_content"
  | "bedrock_converse";

export type ProviderAuthScheme =
  | "bearer"
  | "anthropic-api-key"
  | "google-api-key"
  | "aws-sigv4";

export interface ProviderReasoningCapability {
  supportsThinking: boolean;
  supportsEffort: boolean;
  thinkingParam: "thinking";
  effortParam: "reasoning_effort" | "none";
  effortValueMode?: "deepseek";
  outputFormat: "reasoning_content";
}

export type ProviderPresetId =
  | "deepseek"
  | "zhipu-glm"
  | "zhipu-glm-en"
  | "qwen-bailian"
  | "kimi"
  | "kimi-for-coding"
  | "minimax"
  | "minimax-en"
  | "xiaomi-mimo"
  | "xiaomi-mimo-token-plan"
  | "custom-openai-compatible";

export interface ModelOption {
  id: string;
  displayName: string;
  contextWindow?: number;
  supportsTools: boolean;
  supportsReasoning: boolean;
  supportsParallelToolCalls?: boolean;
  inputModalities?: Array<"text" | "image">;
  baseInstructions?: string;
  usageMapping: "openai-compatible";
}

export interface ProviderPreset {
  id: ProviderPresetId;
  displayName: string;
  kind: ProviderKind;
  baseUrl?: string;
  websiteUrl?: string;
  apiKeyUrl?: string;
  modelsUrl?: string;
  endpointCandidates?: string[];
  apiFormat: ProviderApiFormat;
  reasoning?: ProviderReasoningCapability;
  icon?: string;
  iconColor?: string;
  authScheme: ProviderAuthScheme;
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

export interface TemplateBatchingDefaults {
  maxTemplatesPerCall: number;
  promptBudgetChars: number;
  nonMergeableTemplateTags: string[];
  failureRetryIntervalMs: number;
}

export interface ExtractionRuleDefaults {
  routeFailurePolicy: RouteFailurePolicyConfig;
  ruleSections: ExtractionRuleSectionDefaults;
  templateGroupFallbackStrategy: TemplateGroupFallbackStrategy;
  templateBatching: TemplateBatchingDefaults;
  maxFullTemplatesPerCall: number;
}

export interface RawWindowReportDefaults {
  fileNamePrefix: string;
  displayNamePrefix: string;
}

export type ToolLoopToolName =
  | "read_file"
  | "read_report_excerpt"
  | "upsert_report_section"
  | "grep"
  | "glob"
  | "ls"
  | "write_file"
  | "edit_file"
  | "multi_edit"
  | "bash"
  | "bash_output"
  | "wait"
  | "kill_shell"
  | "mark_no_update";

export interface ToolLoopDefaults {
  enabledToolNames: ToolLoopToolName[];
  maxRepeatedRecoverableToolErrors: number;
  recoverableToolErrorHints: ToolRecoverableErrorHints;
  systemInstruction: string;
  windowInstructionLines: string[];
}

export interface ToolRecoverableErrorHints {
  replacement_text_not_found: string;
  replacement_text_not_unique: string;
  read_tool_target_not_found: string;
  read_tool_scope_denied: string;
  bash_tool_scope_denied: string;
  write_tool_scope_denied: string;
  bash_runtime_failure: string;
  tool_schema_invalid_arguments: string;
  read_tool_invalid_arguments: string;
  edit_target_not_found: string;
  tool_not_enabled: string;
  tool_invalid_arguments: string;
}

export interface TemplatePromptProfileDefaults {
  compressionVersion: string;
  exampleSectionPatterns: string[];
  referenceSectionPatterns: string[];
  placeholderPatterns: string[];
  alwaysKeepHeadingPatterns: string[];
  minProfileChars: number;
}

export type BatchOutcomeKeyMode = "outputFileName" | "templateIdAndOutputFileName";

export interface BatchOutcomeDefaults {
  outcomeKeyMode: BatchOutcomeKeyMode;
  noUpdateToolName: "mark_no_update";
  missingOutcomeCorrectionTemplate: string;
  maxCorrectionRounds: number;
}

export type CoverageIndexCorruptionStrategy = "fail" | "conservative-rerun";

export interface CoverageIndexDefaults {
  relativePath: string;
  corruptionStrategy: CoverageIndexCorruptionStrategy;
  keyFields: string[];
}

export type ReportPathPolicyMode = "flat";

export interface ReportPathPolicyDefaults {
  mode: ReportPathPolicyMode;
  reportsAlias: string;
  allowSubdirectories: boolean;
}

export interface RuleLayerDefaults {
  p0HardRules: string[];
  qualityRules: string[];
  formatRules: string[];
  postWriteGuards: string[];
}

export interface QuantityPolicyDefaults {
  allowZeroWhenNoEvidence: boolean;
  defaultMinItemsWhenEvidenceExists: number;
  evidenceScope: "current-window";
}

export interface JobSchedulerDefaults {
  maxConcurrentJobs: number;
  maxAllowedConcurrentJobs: number;
  maxConcurrentJobsPerBook: number;
  queuedByGlobalLimitText: string;
  queuedByBookLimitText: string;
}

export interface JobTimingDefaults {
  initialWindowEstimateMinMs: number;
  initialWindowEstimateMaxMs: number;
}

export interface JobFailureRetryDefaults {
  failureRetryIntervalMs: number;
}

export interface MiniMaxTokenPlanWaitDefaults {
  enabled: boolean;
  providerPresetIds: string[];
  quotaEndpointPath: string;
  exhaustedMessageFragments: string[];
  textQuotaModelNamePatterns: string[];
  retrySafetyBufferMs: number;
}

export interface LlmFailurePolicyDefaults {
  nonRetryableContextLimitFragments: string[];
  switchableHttpStatuses: number[];
  switchableMessageFragments: string[];
  switchableNetworkErrorFragments: string[];
  maxAutoFallbackRoundsPerWindow: number;
}

export interface ReportFileNameInput {
  name: string;
  outputFileName?: string;
}

export type TaskAction = "start" | "pause" | "resume" | "restart" | "delete";

export type TaskStatus = "pending" | "running" | "pause_requested" | "paused" | "completed" | "failed";

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
  railUtilityItems: MenuItemConfig[];
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
  templatePromptProfileDefaults: TemplatePromptProfileDefaults;
  batchOutcomeDefaults: BatchOutcomeDefaults;
  coverageIndexDefaults: CoverageIndexDefaults;
  reportPathPolicyDefaults: ReportPathPolicyDefaults;
  ruleLayerDefaults: RuleLayerDefaults;
  quantityPolicyDefaults: QuantityPolicyDefaults;
  jobSchedulerDefaults: JobSchedulerDefaults;
  jobTimingDefaults: JobTimingDefaults;
  jobFailureRetryDefaults: JobFailureRetryDefaults;
  minimaxTokenPlanWaitDefaults: MiniMaxTokenPlanWaitDefaults;
  llmFailurePolicyDefaults: LlmFailurePolicyDefaults;
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
