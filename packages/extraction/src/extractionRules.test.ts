import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExtractionRulesError,
  type GenerateExtractionRulesInput,
  generateExtractionRules
} from "./extractionRules";

const createdTempDirs: string[] = [];

interface TestRuleSections {
  commonExtractionRules: string[];
  writeRules: string[];
  skipAlreadyExtractedRules: string[];
}

type RulesInputOverrides = Partial<GenerateExtractionRulesInput> & {
  ruleSections?: TestRuleSections;
};

const DEFAULT_RULE_SECTIONS: TestRuleSections = {
  commonExtractionRules: [
    "只根据当前运行窗口文本和本次任务模板快照判断是否需要抽取，不根据模板名称写死命中规则。",
    "优先保留原文中明确出现的人物、地点、组织、物品、事件和状态变化，不补写未出现的信息。",
    "无法从当前窗口确认的信息应保持空缺或说明未更新，禁止为了补齐格式而编造内容。",
    "同一事实在多个模板中可重复作为各自输出依据，但每个输出文件只写入对应模板要求的内容。"
  ],
  writeRules: [
    "正式提取时只写入本次命中的模板输出文件，输出文件名必须来自任务模板快照。",
    "写入旧报告时应保留仍然有效的既有内容，并用当前窗口的新证据补充或修正。",
    "不得扫描整个项目目录寻找额外上下文；可读范围由 Runtime 的工具策略另行限制。"
  ],
  skipAlreadyExtractedRules: [
    "跳过已提取只依据运行账本中的窗口 hash、模板组快照、输出文件集合和 rulesSemanticHash。",
    "rulesDocumentHash 只用于审计和变更提示，不参与跳过判断。",
    "当规则语义、模板组或输出文件集合变化时，应重新路由和提取。"
  ]
};

afterEach(async () => {
  await Promise.all(createdTempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("generateExtractionRules", () => {
  it("writes a run snapshot and latest copy with normalized rule content and hashes", async () => {
    const projectRoot = await createTempProjectRoot();

    const result = await generateExtractionRules(createRulesInput(projectRoot));

    expect(result.rulesSnapshotPath).toBe("runs/job-a/rules/提取规则.md");
    expect(result.rulesLatestPath).toBe("rules/提取规则.md");
    await expect(fs.readFile(path.join(projectRoot, result.rulesSnapshotPath), "utf8")).resolves.toBe(result.content);
    await expect(fs.readFile(path.join(projectRoot, result.rulesLatestPath), "utf8")).resolves.toBe(result.content);
    expect(result.rulesDocumentHash).toBe(sha256(result.content));
    expect(result.rulesSemanticHash).toBe(sha256(result.semanticContent));

    expect(result.content).toContain("# 提取规则");
    expect(result.content).toContain("> 任务：job-a");
    expect(result.content).toContain("> 书籍 ID：book-1");
    expect(result.content).toContain("> 书籍名称：测试小说");
    expect(result.content).toContain("> 生成时间：2026-06-30T00:00:00.000Z");
    expect(result.content).toContain("## 通用抽取规则");
    expect(result.content).toContain("## 模板路由规则");
    expect(result.content).toContain("## 模板组快照");
    expect(result.content).toContain("## 路由失败策略");
    expect(result.content).toContain("## 写入规则");
    expect(result.content).toContain("## 跳过已提取策略");
    expect(result.content).toContain("世界观.md");
    expect(result.content).toContain("重点匹配地点、势力和世界设定变化。");
    expect(result.content).toContain("请抽取世界观设定。");

    expect(result.content.indexOf("group-a")).toBeLessThan(result.content.indexOf("group-b"));
    expect(result.content.indexOf("角色模板")).toBeLessThan(result.content.indexOf("世界观模板"));
  });

  it("keeps the semantic hash stable across job metadata while document hash changes", async () => {
    const projectRoot = await createTempProjectRoot();
    const first = await generateExtractionRules(createRulesInput(projectRoot));
    const second = await generateExtractionRules(
      createRulesInput(projectRoot, {
        jobId: "job-b",
        generatedAt: "2026-06-30T01:00:00.000Z"
      })
    );

    expect(second.rulesDocumentHash).not.toBe(first.rulesDocumentHash);
    expect(second.rulesSemanticHash).toBe(first.rulesSemanticHash);
    expect(second.semanticContent).toBe(first.semanticContent);
  });

  it("includes configurable rule sections in the semantic hash", async () => {
    const projectRoot = await createTempProjectRoot();
    const first = await generateExtractionRules(createRulesInput(projectRoot));
    const second = await generateExtractionRules(
      createRulesInput(projectRoot, {
        jobId: "job-b",
        generatedAt: "2026-06-30T01:00:00.000Z",
        ruleSections: {
          ...DEFAULT_RULE_SECTIONS,
          writeRules: [...DEFAULT_RULE_SECTIONS.writeRules, "新增写入规则会改变语义哈希。"]
        }
      })
    );
    const third = await generateExtractionRules(
      createRulesInput(projectRoot, {
        jobId: "job-c",
        generatedAt: "2026-06-30T02:00:00.000Z",
        ruleSections: {
          ...DEFAULT_RULE_SECTIONS,
          writeRules: [...DEFAULT_RULE_SECTIONS.writeRules, "新增写入规则会改变语义哈希。"]
        }
      })
    );

    expect(second.content).toContain("新增写入规则会改变语义哈希。");
    expect(second.rulesSemanticHash).not.toBe(first.rulesSemanticHash);
    expect(third.rulesSemanticHash).toBe(second.rulesSemanticHash);
    expect(third.semanticContent).toBe(second.semanticContent);
  });

  it("overwrites the latest copy while keeping earlier run snapshots intact", async () => {
    const projectRoot = await createTempProjectRoot();
    const first = await generateExtractionRules(createRulesInput(projectRoot));
    const second = await generateExtractionRules(
      createRulesInput(projectRoot, {
        jobId: "job-b",
        generatedAt: "2026-06-30T02:00:00.000Z",
        bookDisplayName: "第二本小说",
        templates: [
          {
            templateId: "tmpl-plot",
            templateName: "剧情模板",
            templateBody: "请抽取剧情推进。",
            outputFileName: "剧情.md",
            routeDescription: "重点匹配主线推进。",
            groupId: "group-plot",
            templateHash: "template-hash-plot"
          }
        ],
        groups: [
          {
            groupId: "group-plot",
            groupDisplayName: "剧情分析",
            templateIds: ["tmpl-plot"],
            maxFullTemplatesPerCall: 1,
            groupHash: "group-hash-plot"
          }
        ]
      })
    );

    await expect(fs.readFile(path.join(projectRoot, first.rulesSnapshotPath), "utf8")).resolves.toBe(first.content);
    await expect(fs.readFile(path.join(projectRoot, second.rulesSnapshotPath), "utf8")).resolves.toBe(second.content);
    await expect(fs.readFile(path.join(projectRoot, "rules", "提取规则.md"), "utf8")).resolves.toBe(second.content);
    expect(second.content).toContain("第二本小说");
    expect(second.content).not.toContain("世界观模板");
  });

  it("rejects overwriting an existing run snapshot", async () => {
    const projectRoot = await createTempProjectRoot();
    const first = await generateExtractionRules(createRulesInput(projectRoot));

    await expect(
      generateExtractionRules(
        createRulesInput(projectRoot, {
          bookDisplayName: "同一任务的新内容",
          generatedAt: "2026-06-30T03:00:00.000Z"
        })
      )
    ).rejects.toMatchObject({ code: "SNAPSHOT_ALREADY_EXISTS" });

    await expect(fs.readFile(path.join(projectRoot, first.rulesSnapshotPath), "utf8")).resolves.toBe(first.content);
    await expect(fs.readFile(path.join(projectRoot, first.rulesLatestPath), "utf8")).resolves.toBe(first.content);
  });

  it("throws a typed error for invalid snapshots before writing files", async () => {
    const projectRoot = await createTempProjectRoot();

    await expect(generateExtractionRules(createRulesInput(projectRoot, { templates: [] }))).rejects.toMatchObject({
      code: "EMPTY_TEMPLATES"
    });
    await expect(generateExtractionRules(createRulesInput(projectRoot, { templates: [] }))).rejects.toBeInstanceOf(
      ExtractionRulesError
    );
    await expect(pathExists(path.join(projectRoot, "runs"))).resolves.toBe(false);
    await expect(pathExists(path.join(projectRoot, "rules"))).resolves.toBe(false);
  });

  it.each(["..\\..\\outside", "bad/job", "bad\\job", "with\0nul", ".", "..", "C:job", "C:\\job", "   "])(
    "throws a typed error for invalid jobId %s before writing files",
    async (jobId) => {
      const projectRoot = await createTempProjectRoot();

      await expectInvalidInputBeforeWriting(createRulesInput(projectRoot, { jobId }), projectRoot, "INVALID_JOB_ID");
      await expect(pathExists(path.join(path.dirname(projectRoot), "outside"))).resolves.toBe(false);
    }
  );

  it.each([
    [
      "duplicate templateId",
      {
        templates: [
          {
            templateId: "tmpl-world",
            templateName: "世界观模板",
            templateBody: "请抽取世界观设定。",
            outputFileName: "世界观.md",
            groupId: "group-a"
          },
          {
            templateId: "tmpl-world",
            templateName: "重复模板",
            templateBody: "请抽取重复内容。",
            outputFileName: "重复.md",
            groupId: "group-a"
          }
        ]
      }
    ],
    [
      "duplicate groupId",
      {
        groups: [
          {
            groupId: "group-a",
            groupDisplayName: "基础分析",
            templateIds: ["tmpl-role", "tmpl-world"],
            maxFullTemplatesPerCall: 2
          },
          {
            groupId: "group-a",
            groupDisplayName: "重复分析",
            templateIds: ["tmpl-role"],
            maxFullTemplatesPerCall: 1
          },
          {
            groupId: "group-b",
            groupDisplayName: "道具分析",
            templateIds: ["tmpl-item"],
            maxFullTemplatesPerCall: 1
          }
        ]
      }
    ],
    ["empty templateId", { templates: [{ ...baseTemplate(), templateId: " " }] }],
    ["empty templateName", { templates: [{ ...baseTemplate(), templateName: " " }] }],
    ["empty templateBody", { templates: [{ ...baseTemplate(), templateBody: " " }] }],
    ["empty outputFileName", { templates: [{ ...baseTemplate(), outputFileName: " " }] }],
    ["outputFileName with parent segment", { templates: [{ ...baseTemplate(), outputFileName: "../世界观.md" }] }],
    ["outputFileName with slash", { templates: [{ ...baseTemplate(), outputFileName: "a/b.md" }] }],
    ["absolute outputFileName", { templates: [{ ...baseTemplate(), outputFileName: "C:\\temp\\世界观.md" }] }],
    ["empty groupId", { groups: [{ ...baseGroup(), groupId: " " }] }],
    ["empty groupDisplayName", { groups: [{ ...baseGroup(), groupDisplayName: " " }] }],
    ["empty group templateId", { groups: [{ ...baseGroup(), templateIds: ["tmpl-world", " "] }] }],
    ["maxFullTemplatesPerCall zero", { groups: [{ ...baseGroup(), maxFullTemplatesPerCall: 0 }] }],
    [
      "invalid routeFailurePolicy",
      {
        routeFailurePolicy: {
          maxRetries: 2,
          fallbackStrategy: "invalid",
          fallbackSource: "runtimePolicySnapshot",
          onFallbackNoMatch: "blocked_for_user"
        } as unknown as GenerateExtractionRulesInput["routeFailurePolicy"]
      }
    ]
  ])("throws a typed error for invalid snapshot input: %s", async (_name, overrides) => {
    const projectRoot = await createTempProjectRoot();

    await expectInvalidInputBeforeWriting(createRulesInput(projectRoot, overrides), projectRoot, "INVALID_INPUT");
  });

  it("throws a typed error when a group references a missing template", async () => {
    const projectRoot = await createTempProjectRoot();

    await expect(
      generateExtractionRules(
        createRulesInput(projectRoot, {
          groups: [
            {
              groupId: "group-a",
              groupDisplayName: "主规则",
              templateIds: ["tmpl-missing"],
              maxFullTemplatesPerCall: 2
            },
            {
              groupId: "group-b",
              groupDisplayName: "其它规则",
              templateIds: ["tmpl-item"],
              maxFullTemplatesPerCall: 1
            }
          ]
        })
      )
    ).rejects.toMatchObject({ code: "UNKNOWN_GROUP_TEMPLATE" });
  });

  it("throws a typed error when a template references a missing group", async () => {
    const projectRoot = await createTempProjectRoot();

    await expect(
      generateExtractionRules(
        createRulesInput(projectRoot, {
          templates: [
            {
              templateId: "tmpl-world",
              templateName: "世界观模板",
              templateBody: "请抽取世界观设定。",
              outputFileName: "世界观.md",
              groupId: "group-missing"
            }
          ]
        })
      )
    ).rejects.toMatchObject({ code: "UNKNOWN_TEMPLATE_GROUP" });
  });
});

function createRulesInput(
  projectRoot: string,
  overrides: RulesInputOverrides = {}
): GenerateExtractionRulesInput {
  return {
    projectRoot,
    jobId: "job-a",
    bookId: "book-1",
    bookDisplayName: "测试小说",
    generatedAt: "2026-06-30T00:00:00.000Z",
    templates: [
      {
        templateId: "tmpl-world",
        templateName: "世界观模板",
        templateBody: "请抽取世界观设定。",
        outputFileName: "世界观.md",
        routeDescription: "重点匹配地点、势力和世界设定变化。",
        groupId: "group-a",
        templateHash: "template-hash-world"
      },
      {
        templateId: "tmpl-item",
        templateName: "道具模板",
        templateBody: "请抽取道具变化。",
        outputFileName: "道具.md",
        routeDescription: "重点匹配武器、法宝和消耗品。",
        groupId: "group-b",
        templateHash: "template-hash-item"
      },
      {
        templateId: "tmpl-role",
        templateName: "角色模板",
        templateBody: "请抽取角色状态。",
        outputFileName: "角色.md",
        routeDescription: "重点匹配人物出场、关系和能力变化。",
        groupId: "group-a",
        templateHash: "template-hash-role"
      }
    ],
    groups: [
      {
        groupId: "group-b",
        groupDisplayName: "道具分析",
        templateIds: ["tmpl-item"],
        maxFullTemplatesPerCall: 1,
        groupHash: "group-hash-item"
      },
      {
        groupId: "group-a",
        groupDisplayName: "基础分析",
        templateIds: ["tmpl-role", "tmpl-world"],
        maxFullTemplatesPerCall: 2,
        groupHash: "group-hash-base"
      }
    ],
    routeFailurePolicy: {
      maxRetries: 2,
      fallbackStrategy: "semanticRuleFilter",
      fallbackSource: "runtimePolicySnapshot",
      onFallbackNoMatch: "blocked_for_user"
    },
    ruleSections: DEFAULT_RULE_SECTIONS,
    ...overrides
  } as GenerateExtractionRulesInput;
}

function baseTemplate(): GenerateExtractionRulesInput["templates"][number] {
  return {
    templateId: "tmpl-world",
    templateName: "世界观模板",
    templateBody: "请抽取世界观设定。",
    outputFileName: "世界观.md",
    groupId: "group-a"
  };
}

function baseGroup(): GenerateExtractionRulesInput["groups"][number] {
  return {
    groupId: "group-a",
    groupDisplayName: "基础分析",
    templateIds: ["tmpl-world"],
    maxFullTemplatesPerCall: 1
  };
}

async function createTempProjectRoot(): Promise<string> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-rules-"));
  createdTempDirs.push(tempRoot);
  const projectRoot = path.join(tempRoot, "project");
  await fs.mkdir(projectRoot, { recursive: true });
  return projectRoot;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function expectInvalidInputBeforeWriting(
  input: GenerateExtractionRulesInput,
  projectRoot: string,
  expectedCode: string
): Promise<void> {
  let caught: unknown;
  try {
    await generateExtractionRules(input);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(ExtractionRulesError);
  expect(caught).toMatchObject({ code: expectedCode });
  await expect(pathExists(path.join(projectRoot, "runs"))).resolves.toBe(false);
  await expect(pathExists(path.join(projectRoot, "rules"))).resolves.toBe(false);
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}
