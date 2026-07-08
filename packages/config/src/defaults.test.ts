import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, getDefaultConfig } from "./defaults";

describe("default config", () => {
  it("does not let DEFAULT_CONFIG mutation leak into getDefaultConfig copies", () => {
    const originalAccent = getDefaultConfig().themeTokens.color.accent;
    const attemptedAccent = "#ff00ff";

    const mutationResult = Reflect.set(DEFAULT_CONFIG.themeTokens.color, "accent", attemptedAccent);
    const copiedAccentAfterMutation = getDefaultConfig().themeTokens.color.accent;
    Reflect.set(DEFAULT_CONFIG.themeTokens.color, "accent", originalAccent);

    expect(mutationResult).toBe(false);
    expect(copiedAccentAfterMutation).toBe(originalAccent);
  });

  it("returns caller-owned mutable copies", () => {
    const config = getDefaultConfig();

    config.themeTokens.color.accent = "#118877";

    expect(getDefaultConfig().themeTokens.color.accent).not.toBe("#118877");
  });

  it("provides extraction parameter defaults for window overlap", () => {
    expect(getDefaultConfig().extractionParameterDefaults).toMatchObject({
      singleRunChapterCount: 3,
      extractionChapterCount: 9,
      overlapChapterCount: 1
    });
  });

  it("provides extraction rule defaults for routing and prompt rule sections", () => {
    const config = getDefaultConfig();

    expect(config.extractionRuleDefaults.routeFailurePolicy).toEqual({
      maxRetries: 1,
      fallbackStrategy: "semanticRuleFilter",
      fallbackSource: "rulesSnapshot",
      onFallbackNoMatch: "no-update"
    });
    expect(config.extractionRuleDefaults.templateGroupFallbackStrategy).toBe("by-output-file");
    expect(config.extractionRuleDefaults.maxFullTemplatesPerCall).toBe(4);
    expect(config.extractionRuleDefaults.ruleSections.commonExtractionRules).toEqual(
      expect.arrayContaining([
        "仅根据当前窗口文本与模板快照抽取信息，禁止补写、推测或编造原文未出现的内容。"
      ])
    );
    expect(config.extractionRuleDefaults.ruleSections.writeRules).toEqual(
      expect.arrayContaining(["输出文件名必须来自模板快照，不得由模型自行生成或改名。"])
    );
    expect(config.extractionRuleDefaults.ruleSections.skipAlreadyExtractedRules).toEqual(
      expect.arrayContaining([
        "若账本记录显示相同内容 hash 已完成抽取，应跳过对应内容，避免重复写入。"
      ])
    );
  });

  it("forbids using whole-book or future-chapter prior knowledge in extraction rules", () => {
    const config = getDefaultConfig();
    const antiPriorKnowledgeRule =
      "禁止使用作品全书、后续章节、未读窗口或常识先验补写信息；只能写当前窗口文本明示或当前已有报告已证实的事实；当前未证实的内容必须写原文未说明或不写。";
    const metadataSourceRule =
      "资料来源、参考范围、更新日期等元信息必须根据实际使用的当前窗口、已读取报告和当前运行日期填写；不得遗漏已使用窗口，更新日期不得晚于当前运行日期。";

    expect(config.extractionRuleDefaults.ruleSections.commonExtractionRules).toEqual(
      expect.arrayContaining([antiPriorKnowledgeRule])
    );
    expect(config.toolLoopDefaults.windowInstructionLines).toEqual(
      expect.arrayContaining([antiPriorKnowledgeRule])
    );
    expect(config.extractionRuleDefaults.ruleSections.commonExtractionRules).toEqual(
      expect.arrayContaining([metadataSourceRule])
    );

    const windowInstructions = config.toolLoopDefaults.windowInstructionLines.join("\n");
    expect(windowInstructions).not.toContain(metadataSourceRule);
    expect(windowInstructions).not.toContain("未来真相");
    expect(windowInstructions).not.toContain("真实身份");
    expect(windowInstructions).not.toContain("夺舍");
    expect(windowInstructions).not.toContain("寿元");
  });

  it("keeps evidence and public source metadata rules out of window tool-loop prompts", () => {
    const config = getDefaultConfig();
    const evidenceRule =
      "只有当前窗口文本或已读取报告能稳定证明的条目才写入正式报告；缺少专名、用途、效果或后续结果时，写原文未说明或不写，不得把模板示例或常识推测当作事实。";
    const publicMetadataRule =
      "正式报告中的资料来源、参考范围等公开元数据只能写窗口编号、章节范围、章节名或原文范围；不得暴露内部运行路径、项目路径、窗口文件名或流程性状态。";

    expect(config.extractionRuleDefaults.ruleSections.commonExtractionRules).toEqual(
      expect.arrayContaining([evidenceRule, publicMetadataRule])
    );

    const windowInstructions = config.toolLoopDefaults.windowInstructionLines.join("\n");
    expect(windowInstructions).not.toContain(evidenceRule);
    expect(windowInstructions).not.toContain(publicMetadataRule);
    expect(windowInstructions).not.toContain("材料分析类");
    expect(windowInstructions).not.toContain("药草");
    expect(windowInstructions).not.toContain("药汁");
    expect(windowInstructions).not.toContain("药物");
    expect(windowInstructions).not.toContain("灵液");
    expect(windowInstructions).not.toContain("资源产出源");
    expect(windowInstructions).not.toContain("特殊容器");
    expect(windowInstructions).not.toContain("runs/job");
    expect(windowInstructions).not.toContain("assets/books");
    expect(windowInstructions).not.toContain("AppData");
  });

  it("forbids unsupported template examples and common system terms in final reports", () => {
    const config = getDefaultConfig();
    const templateEvidenceRule =
      "模板示例、字段说明、示例事件链和通用术语只作为格式参考；只有当前窗口原文或已读取既有报告明确证实时才可写入正式报告，未证实的分析结论必须写原文未说明或不写。";

    expect(config.extractionRuleDefaults.ruleSections.commonExtractionRules).toEqual(
      expect.arrayContaining([templateEvidenceRule])
    );
    expect(config.toolLoopDefaults.windowInstructionLines).toEqual(
      expect.arrayContaining([templateEvidenceRule])
    );

    const windowInstructions = config.toolLoopDefaults.windowInstructionLines.join("\n");
    expect(windowInstructions).not.toContain("修仙世界");
    expect(windowInstructions).not.toContain("修仙界");
    expect(windowInstructions).not.toContain("法修");
    expect(windowInstructions).not.toContain("武修");
    expect(windowInstructions).not.toContain("灵石");
    expect(windowInstructions).not.toContain("灵草");
    expect(windowInstructions).not.toContain("矿产");
    expect(windowInstructions).not.toContain("长期余波、可参考点");
  });

  it("requires card-style report body structure in window tool-loop prompts", () => {
    const windowInstructions = getDefaultConfig().toolLoopDefaults.windowInstructionLines.join("\n");

    expect(windowInstructions).not.toContain("本阶段不做模板路由：当前请求只处理本批次列出的选中模板。");
    expect(windowInstructions).not.toContain("正式报告不得复制模板标题、状态：模板、前置声明、参考范围、示例或占位案例。");
    expect(windowInstructions).toContain("正式报告正文必须按模板案例的卡片样式组织");
    expect(windowInstructions).toContain("### 卡片名");
    expect(windowInstructions).toContain("- 字段名：内容说明");
    expect(windowInstructions).toContain("不要写成无卡片或无字段名的连续正文");
  });

  it("provides raw window report naming defaults", () => {
    expect(getDefaultConfig().rawWindowReportDefaults).toEqual({
      fileNamePrefix: "raw-window",
      displayNamePrefix: "原始窗口"
    });
  });

  it("provides tool loop defaults for desktop window runs", () => {
    expect(getDefaultConfig().toolLoopDefaults).toEqual({
      enabledToolNames: [
        "read_file",
        "grep",
        "write_file",
        "edit_file",
        "multi_edit",
        "mark_no_update"
      ],
      maxRepeatedRecoverableToolErrors: 3,
      recoverableToolErrorHints: {
        replacement_text_not_found: expect.stringContaining("正确格式示例"),
        replacement_text_not_unique: expect.stringContaining("正确格式示例"),
        read_tool_target_not_found: expect.stringContaining("正确格式示例"),
        read_tool_scope_denied: expect.stringContaining("正确格式示例"),
        bash_tool_scope_denied: expect.stringContaining("正确格式示例"),
        write_tool_scope_denied: expect.stringContaining("正确格式示例"),
        bash_runtime_failure: expect.stringContaining("正确格式示例"),
        tool_schema_invalid_arguments: expect.stringContaining("edits 必须是真 JSON 数组"),
        read_tool_invalid_arguments: expect.stringContaining("正确格式示例"),
        edit_target_not_found: expect.stringContaining("正确格式示例"),
        tool_not_enabled: expect.stringContaining("正确格式示例"),
        tool_invalid_arguments: expect.stringContaining("正确格式示例")
      },
      systemInstruction: expect.stringContaining("文件工具"),
      windowInstructionLines: expect.arrayContaining([
        expect.stringContaining("NO_UPDATE"),
        expect.stringContaining("outputFileName")
      ])
    });
    const hints = getDefaultConfig().toolLoopDefaults.recoverableToolErrorHints;
    for (const hint of Object.values(hints)) {
      expect(hint).toContain("正确格式示例");
      expect(hint).toContain("mark_no_update");
      expect(hint).not.toContain("upsert_report_section");
      expect(hint).not.toContain("read_report_excerpt");
    }
    expect(hints.tool_schema_invalid_arguments).toContain('"path":"[报告]NPC性格与代表事件.md"');
    expect(hints.tool_schema_invalid_arguments).toContain("edits 必须是真 JSON 数组");
    expect(getDefaultConfig().toolLoopDefaults.windowInstructionLines.join("\n")).toContain(
      "mark_no_update"
    );
    const windowInstructions = getDefaultConfig().toolLoopDefaults.windowInstructionLines.join("\n");
    expect(windowInstructions).toContain("不要调用 read_report_excerpt 或 upsert_report_section");
    expect(windowInstructions).not.toContain("优先用 read_report_excerpt");
    expect(windowInstructions).not.toContain("直接用 upsert_report_section");
    expect(windowInstructions).not.toContain("add_card");
    expect(windowInstructions).not.toContain("add_field");
    expect(windowInstructions).not.toContain("replace_field");
    expect(windowInstructions).toContain("卡片名");
    expect(windowInstructions).toContain("字段名");
    expect(windowInstructions).toContain(
      "grep 定位关键词/字段 -> read_file offset/limit 读取命中附近上下文 -> edit_file / multi_edit 精确替换"
    );
    expect(windowInstructions).toContain("grep");
    expect(windowInstructions).toContain("offset/limit");
    expect(windowInstructions).toContain("read_file");
    expect(windowInstructions).toContain("edit_file");
    expect(windowInstructions).toContain("multi_edit");
    expect(windowInstructions).toContain("write_file");
    expect(windowInstructions).toContain("edits");
    expect(windowInstructions).not.toContain("updates");
    expect(windowInstructions).toContain("真 JSON 数组");
    expect(windowInstructions).toContain("不要把数组写成字符串");
    expect(windowInstructions).not.toContain("ls");
    expect(windowInstructions).not.toContain("glob");
    expect(windowInstructions).not.toContain("bash");
    expect(windowInstructions).toContain("待创建报告");
  });

  it("guides missing report recovery through whole-file creation", () => {
    const hint = getDefaultConfig().toolLoopDefaults.recoverableToolErrorHints.edit_target_not_found;

    expect(hint).toContain("write_file");
    expect(hint).toContain("完整且合规的报告正文");
    expect(hint).not.toContain("upsert_report_section");
    expect(hint).not.toContain("operation=add_card");
    expect(hint).not.toContain("operation=add_field");
  });

  it("provides configurable extraction batching defaults", () => {
    const config = getDefaultConfig();

    expect(config.extractionRuleDefaults.templateBatching).toEqual({
      maxTemplatesPerCall: 4,
      promptBudgetChars: expect.any(Number),
      nonMergeableTemplateTags: []
    });
    expect(config.extractionRuleDefaults.templateBatching.maxTemplatesPerCall).toBe(
      config.extractionRuleDefaults.maxFullTemplatesPerCall
    );
  });

  it("provides template profile, outcome, coverage, path and quantity policy defaults", () => {
    const config = getDefaultConfig();

    expect(config.templatePromptProfileDefaults).toMatchObject({
      compressionVersion: "template-profile-v1",
      exampleSectionPatterns: expect.arrayContaining([expect.stringContaining("示例")]),
      referenceSectionPatterns: expect.arrayContaining([expect.stringContaining("参考")]),
      placeholderPatterns: expect.arrayContaining([expect.stringContaining("待补充")]),
      alwaysKeepHeadingPatterns: expect.arrayContaining([expect.stringContaining("字段")]),
      minProfileChars: expect.any(Number)
    });
    expect(config.batchOutcomeDefaults).toEqual({
      outcomeKeyMode: "outputFileName",
      noUpdateToolName: "mark_no_update",
      missingOutcomeCorrectionTemplate: expect.stringContaining("{{missingOutputFileNames}}"),
      maxCorrectionRounds: expect.any(Number)
    });
    expect(config.coverageIndexDefaults).toEqual({
      relativePath: "metadata/coverage/coverage-index.json",
      corruptionStrategy: "fail",
      keyFields: expect.arrayContaining([
        "bookId",
        "templateId",
        "outputFileName",
        "templateHash",
        "windowHash",
        "rulesSemanticHash",
        "submittedChapterRange"
      ])
    });
    expect(config.coverageIndexDefaults.relativePath).not.toMatch(/^reports[\\/]/i);
    expect(config.reportPathPolicyDefaults).toEqual({
      mode: "flat",
      reportsAlias: "reports",
      allowSubdirectories: false
    });
    expect(config.ruleLayerDefaults.p0HardRules.length).toBeGreaterThan(0);
    expect(config.quantityPolicyDefaults).toEqual({
      allowZeroWhenNoEvidence: true,
      defaultMinItemsWhenEvidenceExists: 1,
      evidenceScope: "current-window"
    });
  });

  it("describes tool loop prompts as processing the current template batch", () => {
    const windowInstructionLines = getDefaultConfig().toolLoopDefaults.windowInstructionLines;

    expect(windowInstructionLines).toEqual(expect.arrayContaining([expect.stringContaining("本批次")]));
    expect(windowInstructionLines.join("\n")).not.toContain("所有选中模板作为同一批次处理");
  });

  it("returns mutable copies of nested extraction rule defaults", () => {
    const config = getDefaultConfig();

    config.extractionRuleDefaults.routeFailurePolicy.maxRetries = 3;
    config.extractionRuleDefaults.ruleSections.commonExtractionRules.push("调用方可追加运行期规则。");
    config.extractionRuleDefaults.templateBatching.nonMergeableTemplateTags.push("solo");
    config.toolLoopDefaults.enabledToolNames.push("read_file");
    config.templatePromptProfileDefaults.exampleSectionPatterns.push("custom-example");
    config.coverageIndexDefaults.keyFields.push("customKey");

    expect(getDefaultConfig().extractionRuleDefaults.routeFailurePolicy.maxRetries).toBe(1);
    expect(getDefaultConfig().extractionRuleDefaults.ruleSections.commonExtractionRules).not.toContain(
      "调用方可追加运行期规则。"
    );
    expect(
      getDefaultConfig().extractionRuleDefaults.templateBatching.nonMergeableTemplateTags
    ).not.toContain("solo");
    expect(getDefaultConfig().toolLoopDefaults.enabledToolNames).toEqual([
      "read_file",
      "grep",
      "write_file",
      "edit_file",
      "multi_edit",
      "mark_no_update"
    ]);
    expect(getDefaultConfig().templatePromptProfileDefaults.exampleSectionPatterns).not.toContain(
      "custom-example"
    );
    expect(getDefaultConfig().coverageIndexDefaults.keyFields).not.toContain("customKey");
  });

  it("provides job scheduler defaults for multi-book concurrency", () => {
    expect(getDefaultConfig().jobSchedulerDefaults).toEqual({
      maxConcurrentJobs: 2,
      maxAllowedConcurrentJobs: 3,
      maxConcurrentJobsPerBook: 1,
      queuedByGlobalLimitText: "等待可用运行槽",
      queuedByBookLimitText: "等待同书任务完成"
    });
  });

  it("provides retry policy defaults for failed jobs and LLM fallback switching", () => {
    expect(getDefaultConfig().jobFailureRetryDefaults).toEqual({
      failureRetryIntervalMs: 300000
    });
    expect(getDefaultConfig().llmFailurePolicyDefaults).toEqual({
      switchableHttpStatuses: [408, 409, 425, 429, 500, 502, 503, 504],
      switchableMessageFragments: expect.arrayContaining([
        "rate limit",
        "too many requests",
        "quota",
        "insufficient_quota",
        "insufficient balance",
        "余额不足",
        "额度不足",
        "timeout",
        "timed out"
      ]),
      switchableNetworkErrorFragments: expect.arrayContaining([
        "terminated",
        "fetch failed",
        "network error",
        "socket hang up",
        "ECONNRESET",
        "ETIMEDOUT",
        "EPIPE",
        "UND_ERR"
      ]),
      maxAutoFallbackRoundsPerWindow: 2
    });
  });
});
