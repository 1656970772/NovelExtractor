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
    expect(config.extractionRuleDefaults.maxFullTemplatesPerCall).toBe(1);
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
      "禁止使用模型对作品全书、后续章节、未读窗口或常识剧情的先验知识；只能写当前窗口文本明示或当前已有报告已证实的事实；涉及未来真相、真实身份、夺舍、寿元、后续影响等当前窗口未说明内容，必须写原文未说明或不写。";
    const metadataSourceRule =
      "资料来源、参考范围、更新日期等元信息只能根据实际使用的当前窗口、已读取报告和当前运行日期填写；不得遗漏已使用窗口、不得声称未读取来源，更新日期不得晚于当前运行日期。";

    expect(config.extractionRuleDefaults.ruleSections.commonExtractionRules).toEqual(
      expect.arrayContaining([antiPriorKnowledgeRule])
    );
    expect(config.toolLoopDefaults.windowInstructionLines).toEqual(
      expect.arrayContaining([antiPriorKnowledgeRule])
    );
    expect(config.extractionRuleDefaults.ruleSections.commonExtractionRules).toEqual(
      expect.arrayContaining([metadataSourceRule])
    );
    expect(config.toolLoopDefaults.windowInstructionLines).toEqual(
      expect.arrayContaining([metadataSourceRule])
    );
  });

  it("requires unnamed material resources and public source metadata in extraction prompts", () => {
    const config = getDefaultConfig();
    const materialResourceRule =
      "材料分析类或资源类模板中，未命名但能由原文稳定描述的材料、药草、药汁、药物、灵液、资源产出源也应记录，不得仅因没有专名或呈现为成品形态就直接 NO_UPDATE；特殊容器或物件若在当前窗口明示为资源产出源、材料载体或关键性质/功能载体，也应作为资源/产出源记录，未知效果或用途写原文未说明。";
    const publicMetadataRule =
      "正式报告的资料来源、参考范围等公开元数据只能写窗口编号、章节范围、章节名或原文范围；不得写 runs/job、assets/books、本机绝对路径、AppData 项目路径等内部运行/项目路径，也不得写后续窗口等流程性措辞。";

    expect(config.extractionRuleDefaults.ruleSections.commonExtractionRules).toEqual(
      expect.arrayContaining([materialResourceRule, publicMetadataRule])
    );
    expect(config.toolLoopDefaults.windowInstructionLines).toEqual(
      expect.arrayContaining([materialResourceRule, publicMetadataRule])
    );
  });

  it("forbids unsupported template examples and common system terms in final reports", () => {
    const config = getDefaultConfig();
    const templateEvidenceRule =
      "模板示例、字段说明、示例事件链和通用体系词只作为格式参考；修仙世界/修仙界、法修/武修、灵石/灵草/矿产等词不得因为出现在模板中就写入正式报告，只有当前窗口原文或已读取既有报告明确证实时才可写；长期余波、可参考点等分析字段不得用模板泛化话术推导未来影响，当前窗口未说明的后续影响必须写原文未说明或不写。";

    expect(config.extractionRuleDefaults.ruleSections.commonExtractionRules).toEqual(
      expect.arrayContaining([templateEvidenceRule])
    );
    expect(config.toolLoopDefaults.windowInstructionLines).toEqual(
      expect.arrayContaining([templateEvidenceRule])
    );
  });

  it("provides raw window report naming defaults", () => {
    expect(getDefaultConfig().rawWindowReportDefaults).toEqual({
      fileNamePrefix: "raw-window",
      displayNamePrefix: "原始窗口"
    });
  });

  it("provides tool loop defaults for desktop window runs", () => {
    expect(getDefaultConfig().toolLoopDefaults).toEqual({
      enabledToolNames: ["read_file", "grep", "write_file", "edit_file", "multi_edit"],
      maxRounds: 12,
      systemInstruction: expect.stringContaining("文件工具"),
      windowInstructionLines: expect.arrayContaining([
        expect.stringContaining("NO_UPDATE"),
        expect.stringContaining("outputFileName")
      ])
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
    config.toolLoopDefaults.enabledToolNames.push("read_file");

    expect(getDefaultConfig().extractionRuleDefaults.routeFailurePolicy.maxRetries).toBe(1);
    expect(getDefaultConfig().extractionRuleDefaults.ruleSections.commonExtractionRules).not.toContain(
      "调用方可追加运行期规则。"
    );
    expect(getDefaultConfig().toolLoopDefaults.enabledToolNames).toEqual([
      "read_file",
      "grep",
      "write_file",
      "edit_file",
      "multi_edit"
    ]);
  });
});
