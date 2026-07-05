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
        "edit_file",
        "grep",
        "ls",
        "multi_edit",
        "read_file",
        "read_report_excerpt",
        "upsert_report_section",
        "write_file",
        "mark_no_update"
      ],
      maxRepeatedRecoverableToolErrors: 3,
      recoverableToolErrorHints: {
        replacement_text_not_found: expect.stringContaining("read_report_excerpt"),
        replacement_text_not_unique: expect.stringContaining("read_report_excerpt"),
        read_tool_target_not_found:
          "读取目标不存在；请先用 ls 确认可读路径，或改用当前窗口文本、reports 目录或本批选中报告文件名。",
        read_tool_scope_denied:
          "只能读取、搜索、列出或匹配当前窗口文本、当前书籍 reports 目录或本批选中输出报告；请改用窗口文件路径、reports 或选中报告文件名。",
        bash_tool_scope_denied:
          "桌面端 bash 只能在当前书籍 reports 目录内执行；不要读取 source、runs、rules、项目根路径、绝对路径或通过 .. 跳出 reports。",
        write_tool_scope_denied:
          "写工具只能写入本批允许的输出报告；path 必须使用模板 outputFileName 或对应报告文件名。",
        bash_runtime_failure:
          "bash 命令执行失败；请根据 stderr/stdout 调整命令、参数或先用文件工具确认目标。",
        tool_schema_invalid_arguments:
          "工具参数结构不符合 schema；请只传入该工具支持的字段，并确保 path/content/pattern/old_string/new_string 等字段类型正确。",
        read_tool_invalid_arguments:
          "读取工具参数无效；请检查 path/pattern 是否为字符串，并缩小读取或搜索范围。",
        edit_target_not_found:
          "目标报告不存在；如果需要创建报告，请改用 write_file 写入完整且合规的报告正文。",
        tool_not_enabled:
          "只能调用当前请求 tools 清单中列出的工具；不要调用未列出的 shell、匹配或报告片段工具。",
        tool_invalid_arguments:
          "工具参数无效；请根据错误消息修正参数后重试，必要时先读取文件确认当前状态。"
      },
      systemInstruction: expect.stringContaining("文件工具"),
      windowInstructionLines: expect.arrayContaining([
        expect.stringContaining("NO_UPDATE"),
        expect.stringContaining("outputFileName")
      ])
    });
    expect(getDefaultConfig().toolLoopDefaults.windowInstructionLines.join("\n")).toContain(
      "mark_no_update"
    );
    const windowInstructions = getDefaultConfig().toolLoopDefaults.windowInstructionLines.join("\n");
    expect(windowInstructions).toContain("read_report_excerpt");
    expect(windowInstructions).toContain("upsert_report_section");
    expect(windowInstructions).toContain("卡片名");
    expect(windowInstructions).toContain("字段名");
    expect(windowInstructions).toContain("韩立-角色定位/核心性格/代表行为");
    expect(windowInstructions).not.toContain("glob");
    expect(windowInstructions).not.toContain("bash");
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
      "edit_file",
      "grep",
      "ls",
      "multi_edit",
      "read_file",
      "read_report_excerpt",
      "upsert_report_section",
      "write_file",
      "mark_no_update"
    ]);
    expect(getDefaultConfig().templatePromptProfileDefaults.exampleSectionPatterns).not.toContain(
      "custom-example"
    );
    expect(getDefaultConfig().coverageIndexDefaults.keyFields).not.toContain("customKey");
  });
});
