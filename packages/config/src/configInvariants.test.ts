import { describe, expect, it } from "vitest";
import { getDefaultConfig } from "./defaults";
import { ConfigInvariantError, assertValidConfigInvariants } from "./configInvariants";
import type { NovelExtractorConfig } from "./schema";

interface ToolLoopDefaultsTestShape {
  enabledToolNames: string[];
  systemInstruction: string;
  windowInstructionLines: string[];
}

function expectInvariantViolation(config: NovelExtractorConfig, messagePattern: RegExp): void {
  expect(() => assertValidConfigInvariants(config)).toThrow(ConfigInvariantError);
  expect(() => assertValidConfigInvariants(config)).toThrow(messagePattern);
}

function withToolLoopDefaults(
  overrides: Partial<ToolLoopDefaultsTestShape> = {}
): NovelExtractorConfig {
  const config = getDefaultConfig();
  (config as unknown as { toolLoopDefaults: ToolLoopDefaultsTestShape }).toolLoopDefaults = {
    enabledToolNames: [
      "read_file",
      "write_file",
      "edit_file",
      "multi_edit",
      "grep",
      "glob",
      "ls",
      "bash",
      "bash_output",
      "wait",
      "kill_shell",
      "mark_no_update"
    ],
    systemInstruction: "必须通过文件工具写入或返回 NO_UPDATE。",
    windowInstructionLines: ["写工具 path 必须使用模板 outputFileName。", "无更新时只返回 NO_UPDATE。"],
    ...overrides
  };

  return config;
}

describe("config invariants", () => {
  it("accepts the default config", () => {
    expect(() => assertValidConfigInvariants(getDefaultConfig())).not.toThrow();
  });

  it("requires provider ids to be unique", () => {
    const config = getDefaultConfig();
    config.providerPresets.push({ ...config.providerPresets[0] });

    expectInvariantViolation(config, /provider preset id/i);
  });

  it("requires model ids to be non-empty", () => {
    const config = getDefaultConfig();
    config.providerPresets[0].models[0].id = " ";

    expectInvariantViolation(config, /model id/i);
  });

  it("requires template names and default output file names to be non-empty", () => {
    const missingName = getDefaultConfig();
    missingName.builtInTemplates[0].name = "";
    expectInvariantViolation(missingName, /template name/i);

    const missingOutputFile = getDefaultConfig();
    missingOutputFile.builtInTemplates[0].defaultOutputFileName = " ";
    expectInvariantViolation(missingOutputFile, /default output file name/i);
  });

  it("requires extraction chapter defaults to be valid integers and ordered", () => {
    const zeroSingleRun = getDefaultConfig();
    zeroSingleRun.extractionParameterDefaults.singleRunChapterCount = 0;
    expectInvariantViolation(zeroSingleRun, /single run chapter count/i);

    const tooSmallExtractionWindow = getDefaultConfig();
    tooSmallExtractionWindow.extractionParameterDefaults.singleRunChapterCount = 3;
    tooSmallExtractionWindow.extractionParameterDefaults.extractionChapterCount = 2;
    expectInvariantViolation(tooSmallExtractionWindow, /greater than or equal/i);
  });

  it("requires overlap chapter count to be a non-negative integer smaller than single-run count", () => {
    const negativeOverlap = getDefaultConfig();
    negativeOverlap.extractionParameterDefaults.overlapChapterCount = -1;
    expectInvariantViolation(negativeOverlap, /overlap chapter count/i);

    const fractionalOverlap = getDefaultConfig();
    fractionalOverlap.extractionParameterDefaults.overlapChapterCount = 0.5;
    expectInvariantViolation(fractionalOverlap, /overlap chapter count/i);

    const overlapMatchesSingleRun = getDefaultConfig();
    overlapMatchesSingleRun.extractionParameterDefaults.singleRunChapterCount = 2;
    overlapMatchesSingleRun.extractionParameterDefaults.overlapChapterCount = 2;
    expectInvariantViolation(overlapMatchesSingleRun, /less than single run chapter count/i);
  });

  it("requires menu item ids to be unique across menus", () => {
    const config = getDefaultConfig();
    config.menu.userMenu.push({ ...config.menu.mainNavigation[0] });

    expectInvariantViolation(config, /menu item id/i);
  });

  it("requires task actions to be allowed by schema", () => {
    const config = getDefaultConfig();
    (config.taskStatus.pending.allowedActions as string[]).push("archive");

    expectInvariantViolation(config, /task action/i);
  });

  it("requires route failure max retries to be a non-negative integer", () => {
    const negativeRetries = getDefaultConfig();
    negativeRetries.extractionRuleDefaults.routeFailurePolicy.maxRetries = -1;
    expectInvariantViolation(negativeRetries, /route failure max retries/i);

    const fractionalRetries = getDefaultConfig();
    fractionalRetries.extractionRuleDefaults.routeFailurePolicy.maxRetries = 1.5;
    expectInvariantViolation(fractionalRetries, /route failure max retries/i);
  });

  it("requires route failure policy enum values to be allowed", () => {
    const invalidStrategy = getDefaultConfig();
    invalidStrategy.extractionRuleDefaults.routeFailurePolicy.fallbackStrategy = "alwaysRetry" as never;
    expectInvariantViolation(invalidStrategy, /fallback strategy/i);

    const invalidSource = getDefaultConfig();
    invalidSource.extractionRuleDefaults.routeFailurePolicy.fallbackSource = "handler" as never;
    expectInvariantViolation(invalidSource, /fallback source/i);

    const invalidNoMatch = getDefaultConfig();
    invalidNoMatch.extractionRuleDefaults.routeFailurePolicy.onFallbackNoMatch = "throw" as never;
    expectInvariantViolation(invalidNoMatch, /fallback no match/i);
  });

  it("requires each extraction rule section to contain non-empty rules", () => {
    const cases: Array<{
      name: "commonExtractionRules" | "writeRules" | "skipAlreadyExtractedRules";
      invalidRules: string[];
      messagePattern: RegExp;
    }> = [
      { name: "commonExtractionRules", invalidRules: [], messagePattern: /common extraction rules/i },
      { name: "commonExtractionRules", invalidRules: [" "], messagePattern: /common extraction rules/i },
      { name: "writeRules", invalidRules: [], messagePattern: /write rules/i },
      { name: "writeRules", invalidRules: [" "], messagePattern: /write rules/i },
      { name: "skipAlreadyExtractedRules", invalidRules: [], messagePattern: /skip already extracted rules/i },
      { name: "skipAlreadyExtractedRules", invalidRules: [" "], messagePattern: /skip already extracted rules/i },
    ];

    for (const testCase of cases) {
      const config = getDefaultConfig();
      config.extractionRuleDefaults.ruleSections[testCase.name] = testCase.invalidRules;
      expectInvariantViolation(config, testCase.messagePattern);
    }
  });

  it("requires template group fallback strategy to be allowed", () => {
    const config = getDefaultConfig();
    config.extractionRuleDefaults.templateGroupFallbackStrategy = "first-template" as never;

    expectInvariantViolation(config, /template group fallback strategy/i);
  });

  it("requires max full templates per call to be a positive integer", () => {
    for (const invalidValue of [0, 1.5]) {
      const config = getDefaultConfig();
      config.extractionRuleDefaults.maxFullTemplatesPerCall = invalidValue;
      expectInvariantViolation(config, /max full templates per call/i);
    }
  });

  it("requires template batching defaults to be configured and synced with the compatibility field", () => {
    const missingDefaults = getDefaultConfig();
    delete (missingDefaults.extractionRuleDefaults as unknown as Record<string, unknown>)
      .templateBatching;
    expectInvariantViolation(missingDefaults, /template batching defaults/i);

    const invalidBatchSize = getDefaultConfig();
    invalidBatchSize.extractionRuleDefaults.templateBatching.maxTemplatesPerCall = 0;
    expectInvariantViolation(invalidBatchSize, /template batching max templates per call/i);

    const invalidBudget = getDefaultConfig();
    invalidBudget.extractionRuleDefaults.templateBatching.promptBudgetChars = 0;
    expectInvariantViolation(invalidBudget, /template batching prompt budget chars/i);

    const duplicateTags = getDefaultConfig();
    duplicateTags.extractionRuleDefaults.templateBatching.nonMergeableTemplateTags = [
      "high-risk",
      "high-risk"
    ];
    expectInvariantViolation(duplicateTags, /non-mergeable template tags/i);

    const divergedCompatibilityField = getDefaultConfig();
    divergedCompatibilityField.extractionRuleDefaults.maxFullTemplatesPerCall = 2;
    expectInvariantViolation(divergedCompatibilityField, /must match template batching/i);
  });

  it("requires template prompt profile defaults to be configured", () => {
    const missingDefaults = getDefaultConfig();
    delete (missingDefaults as unknown as Record<string, unknown>).templatePromptProfileDefaults;
    expectInvariantViolation(missingDefaults, /template prompt profile defaults/i);

    const missingPatterns = getDefaultConfig();
    missingPatterns.templatePromptProfileDefaults.exampleSectionPatterns = [];
    expectInvariantViolation(missingPatterns, /example section patterns/i);

    const invalidMinChars = getDefaultConfig();
    invalidMinChars.templatePromptProfileDefaults.minProfileChars = 0;
    expectInvariantViolation(invalidMinChars, /template prompt profile min chars/i);
  });

  it("requires batch outcome defaults to be configured", () => {
    const missingDefaults = getDefaultConfig();
    delete (missingDefaults as unknown as Record<string, unknown>).batchOutcomeDefaults;
    expectInvariantViolation(missingDefaults, /batch outcome defaults/i);

    const invalidKeyMode = getDefaultConfig();
    invalidKeyMode.batchOutcomeDefaults.outcomeKeyMode = "fileName" as never;
    expectInvariantViolation(invalidKeyMode, /batch outcome key mode/i);

    const invalidNoUpdateTool = getDefaultConfig();
    invalidNoUpdateTool.batchOutcomeDefaults.noUpdateToolName = "noop" as never;
    expectInvariantViolation(invalidNoUpdateTool, /no-update tool name/i);

    const invalidCorrectionRounds = getDefaultConfig();
    invalidCorrectionRounds.batchOutcomeDefaults.maxCorrectionRounds = 0;
    expectInvariantViolation(invalidCorrectionRounds, /batch outcome max correction rounds/i);
  });

  it("requires coverage index defaults to be outside model-readable reports paths", () => {
    const missingDefaults = getDefaultConfig();
    delete (missingDefaults as unknown as Record<string, unknown>).coverageIndexDefaults;
    expectInvariantViolation(missingDefaults, /coverage index defaults/i);

    const reportsPath = getDefaultConfig();
    reportsPath.coverageIndexDefaults.relativePath = "reports/.index/coverage.json";
    expectInvariantViolation(reportsPath, /must not be under reports/i);

    const absolutePath = getDefaultConfig();
    absolutePath.coverageIndexDefaults.relativePath = "C:/tmp/coverage.json";
    expectInvariantViolation(absolutePath, /coverage index relative path/i);

    const invalidStrategy = getDefaultConfig();
    invalidStrategy.coverageIndexDefaults.corruptionStrategy = "ignore" as never;
    expectInvariantViolation(invalidStrategy, /coverage index corruption strategy/i);

    const duplicateFields = getDefaultConfig();
    duplicateFields.coverageIndexDefaults.keyFields = ["bookId", "bookId"];
    expectInvariantViolation(duplicateFields, /coverage index key fields/i);
  });

  it("requires report path policy, rule layers and quantity policy defaults", () => {
    const missingPathPolicy = getDefaultConfig();
    delete (missingPathPolicy as unknown as Record<string, unknown>).reportPathPolicyDefaults;
    expectInvariantViolation(missingPathPolicy, /report path policy defaults/i);

    const nestedReports = getDefaultConfig();
    nestedReports.reportPathPolicyDefaults.allowSubdirectories = true;
    expectInvariantViolation(nestedReports, /flat report path policy/i);

    const missingRuleLayers = getDefaultConfig();
    missingRuleLayers.ruleLayerDefaults.p0HardRules = [];
    expectInvariantViolation(missingRuleLayers, /p0 hard rules/i);

    const invalidQuantityPolicy = getDefaultConfig();
    invalidQuantityPolicy.quantityPolicyDefaults.defaultMinItemsWhenEvidenceExists = -1;
    expectInvariantViolation(invalidQuantityPolicy, /quantity policy default minimum/i);
  });

  it("requires raw window report defaults and prefixes to be present", () => {
    const missingDefaults = getDefaultConfig();
    delete (missingDefaults as unknown as Record<string, unknown>).rawWindowReportDefaults;
    expectInvariantViolation(missingDefaults, /raw window report defaults/i);

    const missingFileNamePrefix = getDefaultConfig();
    (missingFileNamePrefix as unknown as Record<string, unknown>).rawWindowReportDefaults = {
      displayNamePrefix: "原始窗口"
    };
    expectInvariantViolation(missingFileNamePrefix, /raw window report file name prefix/i);

    const missingDisplayNamePrefix = getDefaultConfig();
    (missingDisplayNamePrefix as unknown as Record<string, unknown>).rawWindowReportDefaults = {
      fileNamePrefix: "raw-window"
    };
    expectInvariantViolation(missingDisplayNamePrefix, /raw window report display name prefix/i);
  });

  it("requires raw window report prefixes to be non-empty and file-name safe", () => {
    for (const invalidPrefix of [
      "",
      " ",
      "raw/window",
      "raw\\window",
      "C:raw-window",
      "\0raw-window",
      "raw-window.md",
      "raw-window.MD "
    ]) {
      const config = getDefaultConfig();
      config.rawWindowReportDefaults.fileNamePrefix = invalidPrefix;
      expectInvariantViolation(config, /raw window report file name prefix/i);
    }

    const missingDisplayNamePrefix = getDefaultConfig();
    missingDisplayNamePrefix.rawWindowReportDefaults.displayNamePrefix = " ";
    expectInvariantViolation(
      missingDisplayNamePrefix,
      /raw window report display name prefix/i
    );
  });

  it("requires tool loop defaults to be configured and internally valid", () => {
    const missingDefaults = getDefaultConfig();
    delete (missingDefaults as unknown as Record<string, unknown>).toolLoopDefaults;
    expectInvariantViolation(missingDefaults, /tool loop defaults/i);

    expectInvariantViolation(
      withToolLoopDefaults({ enabledToolNames: [] }),
      /tool loop enabled tool names/i
    );
    expectInvariantViolation(
      withToolLoopDefaults({ enabledToolNames: ["read_file", "read_file"] }),
      /tool loop enabled tool names/i
    );
    expectInvariantViolation(
      withToolLoopDefaults({ enabledToolNames: ["read_file", "move_file"] }),
      /tool loop enabled tool name/i
    );
    expectInvariantViolation(
      withToolLoopDefaults({ systemInstruction: " " }),
      /tool loop system instruction/i
    );
    expectInvariantViolation(
      withToolLoopDefaults({ windowInstructionLines: [] }),
      /tool loop window instruction lines/i
    );
    expectInvariantViolation(
      withToolLoopDefaults({ windowInstructionLines: [" "] }),
      /tool loop window instruction lines/i
    );
  });
});
