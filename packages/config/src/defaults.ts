import { defineNovelExtractorConfig, type NovelExtractorConfig } from "./schema";

type DeepReadonly<T> = T extends (...args: unknown[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nestedValue of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nestedValue);
    }
    Object.freeze(value);
  }

  return value as DeepReadonly<T>;
}

const MENU_ITEMS = {
  assets: {
    id: "assets",
    label: "资产",
    shortLabel: "资"
  },
  extraction: {
    id: "extraction",
    label: "小说提取",
    shortLabel: "提",
    imageSrc: "function-extraction.svg"
  },
  graph: {
    id: "graph",
    label: "关系图谱",
    shortLabel: "图",
    imageSrc: "function-graph.svg"
  },
  providerSettings: {
    id: "provider-settings",
    label: "大模型配置"
  },
  desktopSettings: {
    id: "desktop-settings",
    label: "设置",
    shortLabel: "⚙"
  },
  language: {
    id: "language",
    label: "语言"
  },
  userMenu: {
    id: "user-menu",
    label: "用户菜单"
  }
} as const;

const NO_WHOLE_BOOK_PRIOR_KNOWLEDGE_RULE =
  "禁止使用模型对作品全书、后续章节、未读窗口或常识剧情的先验知识；只能写当前窗口文本明示或当前已有报告已证实的事实；涉及未来真相、真实身份、夺舍、寿元、后续影响等当前窗口未说明内容，必须写原文未说明或不写。";
const REPORT_METADATA_SOURCE_RULE =
  "资料来源、参考范围、更新日期等元信息只能根据实际使用的当前窗口、已读取报告和当前运行日期填写；不得遗漏已使用窗口、不得声称未读取来源，更新日期不得晚于当前运行日期。";
const MATERIAL_RESOURCE_COVERAGE_RULE =
  "材料分析类或资源类模板中，未命名但能由原文稳定描述的材料、药草、药汁、药物、灵液、资源产出源也应记录，不得仅因没有专名或呈现为成品形态就直接 NO_UPDATE；特殊容器或物件若在当前窗口明示为资源产出源、材料载体或关键性质/功能载体，也应作为资源/产出源记录，未知效果或用途写原文未说明。";
const PUBLIC_REPORT_METADATA_RULE =
  "正式报告的资料来源、参考范围等公开元数据只能写窗口编号、章节范围、章节名或原文范围；不得写 runs/job、assets/books、本机绝对路径、AppData 项目路径等内部运行/项目路径，也不得写后续窗口等流程性措辞。";
const TEMPLATE_EXAMPLE_EVIDENCE_RULE =
  "模板示例、字段说明、示例事件链和通用体系词只作为格式参考；修仙世界/修仙界、法修/武修、灵石/灵草/矿产等词不得因为出现在模板中就写入正式报告，只有当前窗口原文或已读取既有报告明确证实时才可写；长期余波、可参考点等分析字段不得用模板泛化话术推导未来影响，当前窗口未说明的后续影响必须写原文未说明或不写。";

const DEFAULT_CONFIG_SOURCE = defineNovelExtractorConfig({
  providerPresets: [
    {
      id: "deepseek",
      displayName: "DeepSeek",
      kind: "openai-compatible",
      baseUrl: "https://api.deepseek.com",
      authScheme: "bearer",
      models: [
        {
          id: "deepseek-v4-flash",
          displayName: "DeepSeek V4 Flash",
          supportsTools: true,
          supportsReasoning: false,
          usageMapping: "openai-compatible"
        },
        {
          id: "deepseek-v4-pro",
          displayName: "DeepSeek V4 Pro",
          supportsTools: true,
          supportsReasoning: true,
          usageMapping: "openai-compatible"
        }
      ],
      defaultModelPolicy: "first-enabled",
      allowsUserModels: false
    },
    {
      id: "custom-openai-compatible",
      displayName: "自定义 OpenAI-compatible",
      kind: "openai-compatible",
      authScheme: "bearer",
      models: [],
      defaultModelPolicy: "user-required",
      allowsUserModels: true
    }
  ],
  builtInTemplates: [
    {
      id: "pill-analysis",
      name: "丹药分析模板",
      description: "提取丹药名称、品阶、功效、材料和关联剧情线索。",
      defaultOutputFileName: "丹药分析.md"
    }
  ],
  extractionParameterDefaults: {
    singleRunChapterCount: 3,
    extractionChapterCount: 9,
    overlapChapterCount: 1
  },
  extractionRuleDefaults: {
    routeFailurePolicy: {
      maxRetries: 1,
      fallbackStrategy: "semanticRuleFilter",
      fallbackSource: "rulesSnapshot",
      onFallbackNoMatch: "no-update"
    },
    ruleSections: {
      commonExtractionRules: [
        "仅根据当前窗口文本与模板快照抽取信息，禁止补写、推测或编造原文未出现的内容。",
        NO_WHOLE_BOOK_PRIOR_KNOWLEDGE_RULE,
        REPORT_METADATA_SOURCE_RULE,
        MATERIAL_RESOURCE_COVERAGE_RULE,
        PUBLIC_REPORT_METADATA_RULE,
        TEMPLATE_EXAMPLE_EVIDENCE_RULE,
        "优先匹配模板快照中声明的字段、规则和输出目标；当前窗口未提供证据时保持为空或不更新。"
      ],
      writeRules: [
        "输出文件名必须来自模板快照，不得由模型自行生成或改名。",
        "写入内容必须遵循模板快照的结构要求，不得新增模板外章节或字段。"
      ],
      skipAlreadyExtractedRules: [
        "若账本记录显示相同内容 hash 已完成抽取，应跳过对应内容，避免重复写入。",
        "跳过判断只依据调用方提供的账本快照和当前窗口信息，不得自行假设历史状态。"
      ]
    },
    templateGroupFallbackStrategy: "by-output-file",
    maxFullTemplatesPerCall: 1
  },
  rawWindowReportDefaults: {
    fileNamePrefix: "raw-window",
    displayNamePrefix: "原始窗口"
  },
  toolLoopDefaults: {
    enabledToolNames: ["read_file", "grep", "write_file", "edit_file", "multi_edit"],
    maxRounds: 12,
    systemInstruction:
      "你是小说资料抽取助手。必须通过文件工具写入或更新正式模板 Markdown；如果本窗口没有任何可写入的新信息，最终文本必须严格返回 NO_UPDATE。最终文本只简短说明本窗口处理结果，不要放完整报告正文。",
    windowInstructionLines: [
      "本阶段不做模板路由：当前请求只处理本批次列出的选中模板。",
      "写工具的 path 必须使用选中模板的 outputFileName 原样，不要添加目录或改名。",
      "模板正文只作为结构、字段和写作规则参考，不是正式报告正文。",
      "正式报告不得复制模板标题、状态：模板、前置声明、参考范围、示例或占位案例。",
      "正式报告标题必须使用 outputFileName 去掉扩展名后的报告名，不要保留或添加“模板”。",
      NO_WHOLE_BOOK_PRIOR_KNOWLEDGE_RULE,
      REPORT_METADATA_SOURCE_RULE,
      MATERIAL_RESOURCE_COVERAGE_RULE,
      PUBLIC_REPORT_METADATA_RULE,
      TEMPLATE_EXAMPLE_EVIDENCE_RULE,
      "更新既有报告前，必须先在本轮使用 read_file 或 grep 查询同一个报告文件。",
      "如果当前窗口没有可写入的新信息，且未执行写工具，最终文本必须严格返回 NO_UPDATE。"
    ]
  },
  taskActions: {
    start: {
      label: "开始"
    },
    pause: {
      label: "暂停"
    },
    resume: {
      label: "继续"
    },
    delete: {
      label: "删除任务"
    }
  },
  taskStatus: {
    pending: {
      label: "待开始",
      allowedActions: ["start", "delete"]
    },
    running: {
      label: "运行中",
      allowedActions: ["pause"]
    },
    paused: {
      label: "已暂停",
      allowedActions: ["resume", "delete"]
    },
    completed: {
      label: "已完成",
      allowedActions: ["delete"]
    },
    failed: {
      label: "失败",
      allowedActions: ["delete"]
    }
  },
  assetTypes: [
    {
      id: "book",
      label: "书籍"
    }
  ],
  menu: {
    mainNavigation: [MENU_ITEMS.assets, MENU_ITEMS.extraction, MENU_ITEMS.graph],
    userMenu: [MENU_ITEMS.providerSettings],
    workbenchNavigation: {
      topFunctionLabel: "功能",
      topFunctionItems: [MENU_ITEMS.extraction, MENU_ITEMS.graph],
      railAssetItem: MENU_ITEMS.assets,
      railFunctionItems: [MENU_ITEMS.extraction, MENU_ITEMS.graph],
      railUtilityItems: [MENU_ITEMS.desktopSettings],
      languageAction: MENU_ITEMS.language,
      userAction: MENU_ITEMS.userMenu
    }
  },
  themeTokens: {
    color: {
      appBackground: "#edf1f0",
      surface: "#ffffff",
      surfacePaper: "#f7f8f8",
      surfaceRaised: "#fbfcfc",
      textPrimary: "#1f2528",
      textMuted: "#5e686d",
      inkSoft: "#7c878b",
      accent: "#2f7d6d",
      accentHover: "#286f61",
      accentSoft: "#d9ebe6",
      onAccent: "#ffffff",
      selected: "#e9f3ef",
      progress: "#416f91",
      success: "#28724d",
      warning: "#936a24",
      danger: "#a0473d",
      dangerSoft: "#f6e5e1",
      infoSoft: "#edf5f8",
      graphLine: "#d6e6e2",
      border: "#ccd4d6",
      borderStrong: "#aebbbf"
    },
    shadow: {
      panel: "0 14px 34px rgb(36 52 54 / 0.1)",
      control: "0 1px 0 rgb(31 37 40 / 0.08)"
    },
    radius: {
      card: 8,
      control: 6
    },
    motion: {
      intensity: 3,
      durationMs: 160
    }
  }
});

export const DEFAULT_CONFIG = deepFreeze(DEFAULT_CONFIG_SOURCE);

export function getDefaultConfig(): NovelExtractorConfig {
  return structuredClone(DEFAULT_CONFIG) as NovelExtractorConfig;
}
