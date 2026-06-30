import { describe, expect, it } from "vitest";
import {
  REAL_RUN_TEMPLATE_FILES,
  assertHarnessUploadChapterCoverage,
  buildHarnessCreateJobInput,
  createExpectedWindowPlanSummary,
  resolveDesktopRunHarnessConfig,
  resolveHarnessRunMode,
  selectHarnessModel,
  toSafeHarnessError,
  validateHarnessTemplateOutputReports,
  validateRuntimeWindowManifest
} from "./desktopRunHarnessConfig";

describe("desktop real-run harness config", () => {
  it("uses the controlled 5/81/1 window slice, four source templates, and template-free report outputs", () => {
    const config = resolveDesktopRunHarnessConfig({});
    const summary = createExpectedWindowPlanSummary(81);

    expect(config.windowParams).toEqual({
      singleRunChapterCount: 5,
      extractionChapterCount: 81,
      overlapChapterCount: 1
    });
    expect(REAL_RUN_TEMPLATE_FILES).toEqual([
      "NPC性格与代表事件模板.md",
      "事件因果链（长程因果图）模板.md",
      "势力设定模板.md",
      "材料分析模板.md"
    ]);
    expect(config.templateFiles).toEqual([
      "NPC性格与代表事件模板.md",
      "事件因果链（长程因果图）模板.md",
      "势力设定模板.md",
      "材料分析模板.md"
    ]);
    expect(config.templateOutputFileNames).toEqual([
      "NPC性格与代表事件.md",
      "事件因果链（长程因果图）.md",
      "势力设定.md",
      "材料分析.md"
    ]);
    expect(summary).toEqual({
      windowCount: 20,
      firstContextRange: "1-5",
      lastContextRange: "77-81"
    });
  });

  it("keeps real-run template sources and report output names configurable as separate lists", () => {
    const config = resolveDesktopRunHarnessConfig({
      NOVEL_EXTRACTOR_REAL_TEMPLATE_FILES: "甲模板.md;乙模板.md",
      NOVEL_EXTRACTOR_REAL_TEMPLATE_OUTPUT_FILES: "甲.md;乙.md"
    });

    expect(config.templateFiles).toEqual(["甲模板.md", "乙模板.md"]);
    expect(config.templateOutputFileNames).toEqual(["甲.md", "乙.md"]);
  });

  it("allows real-run window params to be shortened from env for development sprints", () => {
    const config = resolveDesktopRunHarnessConfig({
      NOVEL_EXTRACTOR_REAL_SINGLE_RUN_CHAPTER_COUNT: "5",
      NOVEL_EXTRACTOR_REAL_EXTRACTION_CHAPTER_COUNT: "13",
      NOVEL_EXTRACTOR_REAL_OVERLAP_CHAPTER_COUNT: "1"
    });

    expect(config.windowParams).toEqual({
      singleRunChapterCount: 5,
      extractionChapterCount: 13,
      overlapChapterCount: 1
    });
    expect(
      createExpectedWindowPlanSummary(
        config.windowParams.extractionChapterCount,
        config.windowParams
      )
    ).toEqual({
      windowCount: 3,
      firstContextRange: "1-5",
      lastContextRange: "9-13"
    });
  });

  it("rejects invalid real-run window env params with clear errors", () => {
    expect(() =>
      resolveDesktopRunHarnessConfig({
        NOVEL_EXTRACTOR_REAL_SINGLE_RUN_CHAPTER_COUNT: "0"
      })
    ).toThrow("NOVEL_EXTRACTOR_REAL_SINGLE_RUN_CHAPTER_COUNT 必须是正整数");
    expect(() =>
      resolveDesktopRunHarnessConfig({
        NOVEL_EXTRACTOR_REAL_SINGLE_RUN_CHAPTER_COUNT: "5",
        NOVEL_EXTRACTOR_REAL_OVERLAP_CHAPTER_COUNT: "5"
      })
    ).toThrow("NOVEL_EXTRACTOR_REAL_OVERLAP_CHAPTER_COUNT 必须小于 NOVEL_EXTRACTOR_REAL_SINGLE_RUN_CHAPTER_COUNT");
  });

  it("requires an explicit prepare-only or real-run mode", () => {
    expect(resolveHarnessRunMode({})).toBe("disabled");
    expect(resolveHarnessRunMode({ NOVEL_EXTRACTOR_PREPARE_ONLY: "1" })).toBe("prepare-only");
    expect(resolveHarnessRunMode({ NOVEL_EXTRACTOR_REAL_RUN: "1" })).toBe("real-run");
    expect(() =>
      resolveHarnessRunMode({
        NOVEL_EXTRACTOR_PREPARE_ONLY: "1",
        NOVEL_EXTRACTOR_REAL_RUN: "1"
      })
    ).toThrow("不能同时启用");
  });

  it("adds a run suffix to the default project name but keeps explicit project names unchanged", () => {
    const firstConfig = resolveDesktopRunHarnessConfig({
      NOVEL_EXTRACTOR_REAL_RUN_ID: "run-a"
    });
    const secondConfig = resolveDesktopRunHarnessConfig({
      NOVEL_EXTRACTOR_REAL_RUN_ID: "run-b"
    });
    const explicitConfig = resolveDesktopRunHarnessConfig({
      NOVEL_EXTRACTOR_REAL_PROJECT_NAME: "手动复用项目",
      NOVEL_EXTRACTOR_REAL_RUN_ID: "run-c"
    });

    expect(firstConfig.projectName).toBe("desktop-run-harness-凡人修仙传-20窗口-run-a");
    expect(secondConfig.projectName).toBe("desktop-run-harness-凡人修仙传-20窗口-run-b");
    expect(firstConfig.projectName).not.toBe(secondConfig.projectName);
    expect(explicitConfig.projectName).toBe("手动复用项目");
  });

  it("selects deepseek-v4-flash from enabled providers without requiring secret material", () => {
    const selected = selectHarnessModel([
      {
        id: "provider-1",
        presetId: "deepseek",
        displayName: "DeepSeek",
        kind: "openai-compatible",
        models: [
          { id: "deepseek-chat", displayName: "DeepSeek Chat", enabled: true, isDefault: true },
          { id: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", enabled: true, isDefault: false }
        ],
        hasApiKey: true,
        enabled: true
      }
    ]);

    expect(selected).toEqual({
      providerConfigId: "provider-1",
      modelId: "deepseek-v4-flash",
      providerDisplayName: "DeepSeek",
      modelDisplayName: "DeepSeek V4 Flash"
    });
  });

  it("builds the create-job payload from selected model and template ids", () => {
    const config = resolveDesktopRunHarnessConfig({
      NOVEL_EXTRACTOR_REAL_SINGLE_RUN_CHAPTER_COUNT: "5",
      NOVEL_EXTRACTOR_REAL_EXTRACTION_CHAPTER_COUNT: "13",
      NOVEL_EXTRACTOR_REAL_OVERLAP_CHAPTER_COUNT: "1"
    });
    const input = buildHarnessCreateJobInput({
      bookId: "book-1",
      templateIds: ["template-1", "template-2"],
      model: {
        providerConfigId: "provider-1",
        modelId: "deepseek-v4-flash",
        providerDisplayName: "DeepSeek",
        modelDisplayName: "DeepSeek V4 Flash"
      },
      windowParams: config.windowParams
    });

    expect(input).toMatchObject({
      bookId: "book-1",
      templateIds: ["template-1", "template-2"],
      providerConfigId: "provider-1",
      modelId: "deepseek-v4-flash",
      singleRunChapterCount: 5,
      extractionChapterCount: 13,
      overlapChapterCount: 1,
      skipAlreadyExtracted: false
    });
  });

  it("allows the uploaded source to contain more chapters than the controlled extraction window", () => {
    expect(() => assertHarnessUploadChapterCoverage(478)).not.toThrow();
    expect(() => assertHarnessUploadChapterCoverage(80)).toThrow("至少识别 81 章");
    expect(createExpectedWindowPlanSummary(478)).toEqual({
      windowCount: 20,
      firstContextRange: "1-5",
      lastContextRange: "77-81"
    });
  });

  it("validates completed runtime manifests and redacts accidental secrets from errors", () => {
    const expectedWindows = [
      { contextChapterRange: "1-5" },
      ...Array.from({ length: 18 }, (_, index) => ({ contextChapterRange: `${5 + index * 4}-${9 + index * 4}` })),
      { contextChapterRange: "77-81" }
    ];

    expect(
      validateRuntimeWindowManifest({
        totalDetectedChapterCount: 478,
        windows: expectedWindows
      })
    ).toEqual({
      windowCount: 20,
      firstContextRange: "1-5",
      lastContextRange: "77-81"
    });
    expect(() =>
      validateRuntimeWindowManifest({
        totalDetectedChapterCount: 80,
        windows: expectedWindows
      })
    ).toThrow("至少识别 81 章");

    expect(
      toSafeHarnessError(new Error("Authorization: Bearer sk-live-secret and api_key=abc123456789"))
    ).toContain("sk-***");
    expect(
      toSafeHarnessError(new Error("Authorization: Bearer sk-live-secret and api_key=abc123456789"))
    ).not.toContain("sk-live-secret");
  });

  it("validates sprint runtime manifests against the env-shortened expected window plan", () => {
    const config = resolveDesktopRunHarnessConfig({
      NOVEL_EXTRACTOR_REAL_SINGLE_RUN_CHAPTER_COUNT: "5",
      NOVEL_EXTRACTOR_REAL_EXTRACTION_CHAPTER_COUNT: "13",
      NOVEL_EXTRACTOR_REAL_OVERLAP_CHAPTER_COUNT: "1"
    });
    const expected = createExpectedWindowPlanSummary(
      config.windowParams.extractionChapterCount,
      config.windowParams
    );

    expect(
      validateRuntimeWindowManifest(
        {
          totalDetectedChapterCount: 13,
          windows: [
            { contextChapterRange: "1-5" },
            { contextChapterRange: "5-9" },
            { contextChapterRange: "9-13" }
          ]
        },
        expected
      )
    ).toEqual({
      windowCount: 3,
      firstContextRange: "1-5",
      lastContextRange: "9-13"
    });
  });

  it("allows missing allowed template outputs when a real sprint batch legitimately returns NO_UPDATE", () => {
    const reports = validateHarnessTemplateOutputReports(
      [
        createHarnessReport("NPC性格与代表事件.md", 128),
        createHarnessReport("事件因果链（长程因果图）.md", 256),
        createHarnessReport("势力设定.md", 512)
      ],
      ["NPC性格与代表事件.md", "事件因果链（长程因果图）.md", "势力设定.md", "材料分析.md"]
    );

    expect(reports.map((report) => report.fileName)).toEqual([
      "NPC性格与代表事件.md",
      "事件因果链（长程因果图）.md",
      "势力设定.md"
    ]);
  });

  it("can preserve the full real-run requirement that all expected template outputs exist", () => {
    expect(() =>
      validateHarnessTemplateOutputReports(
        [createHarnessReport("NPC性格与代表事件.md", 128)],
        ["NPC性格与代表事件.md", "材料分析.md"],
        { requireAllExpectedReports: true }
      )
    ).toThrow("材料分析.md");
  });

  it("rejects unexpected template-output reports outside the real-run allowlist", () => {
    expect(() =>
      validateHarnessTemplateOutputReports(
        [createHarnessReport("材料分析.md", 128), createHarnessReport("未选择模板.md", 64)],
        ["材料分析.md"]
      )
    ).toThrow("未选择模板.md");
  });

  it("requires at least one non-empty allowed template-output report", () => {
    expect(() => validateHarnessTemplateOutputReports([], ["材料分析.md"])).toThrow("至少需要生成一个");
    expect(() =>
      validateHarnessTemplateOutputReports([createHarnessReport("材料分析.md", 0)], ["材料分析.md"])
    ).toThrow("byteSize");
  });
});

function createHarnessReport(fileName: string, byteSize: number) {
  return {
    id: `report-${fileName}`,
    bookId: "book-1",
    fileName,
    displayName: fileName.replace(/\.md$/u, ""),
    byteSize,
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
    reportKind: "template-output" as const
  };
}
