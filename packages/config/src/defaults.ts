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
    templateBatching: {
      maxTemplatesPerCall: 4,
      promptBudgetChars: 48000,
      nonMergeableTemplateTags: []
    },
    maxFullTemplatesPerCall: 4
  },
  rawWindowReportDefaults: {
    fileNamePrefix: "raw-window",
    displayNamePrefix: "原始窗口"
  },
  toolLoopDefaults: {
    enabledToolNames: [
      "bash",
      "bash_output",
      "edit_file",
      "glob",
      "grep",
      "kill_shell",
      "ls",
      "multi_edit",
      "read_file",
      "read_report_excerpt",
      "upsert_report_section",
      "wait",
      "write_file",
      "mark_no_update"
    ],
    maxRepeatedRecoverableToolErrors: 3,
    recoverableToolErrorHints: {
      replacement_text_not_found:
        "old_string 必须精确匹配文件中的原文；更新既有报告优先用 read_report_excerpt 按关键词读取相关段落，再用 grep/read_file 找到必要的准确锚点；若已读取且需要整体更新，可用 write_file 提交完整保留旧内容的新版报告。",
      replacement_text_not_unique:
        "old_string 在文件中匹配到多处；请先用 read_report_excerpt 按关键词读取相关段落，再用 grep/read_file 找到目标段落并加入足够上下文，或用 write_file 提交完整保留旧内容的新版报告。",
      read_tool_target_not_found:
        "读取目标不存在；请先用 ls/glob 确认可读路径，或改用当前窗口文本、reports 目录或本批选中报告文件名。",
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
        "只能调用当前请求 tools 清单中列出的工具；如果需要执行 shell 命令，请调用 bash 并把命令放在 command 字段中。",
      tool_invalid_arguments:
        "工具参数无效；请根据错误消息修正参数后重试，必要时先读取文件确认当前状态。"
    },
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
      "更新既有报告前，必须先在本轮使用 read_report_excerpt 按关键词查询同一个报告文件的相关段落；常规报告更新优先使用 upsert_report_section 的 sectionId/writeMode，不要提供 old_string；只有当前窗口文本或小报告需要精确行号时才使用 read_file/grep 和 edit_file/multi_edit。",
      "如果本批次只有部分模板无新增信息，必须对这些模板调用 mark_no_update，并继续为其他模板写入或更新报告。",
      "如果当前窗口没有可写入的新信息，且未执行写工具，最终文本必须严格返回 NO_UPDATE。"
    ]
  },
  templatePromptProfileDefaults: {
    compressionVersion: "template-profile-v1",
    exampleSectionPatterns: ["^#{1,6}\\s*示例", "^#{1,6}\\s*案例", "^示例[:：]", "^案例\\d*[:：]"],
    referenceSectionPatterns: ["^#{1,6}\\s*参考", "^#{1,6}\\s*资料来源", "^参考范围[:：]"],
    placeholderPatterns: ["^状态[:：]\\s*模板", "待补充", "原文未说明", "\\{\\{[^}]+\\}\\}", "<[^>]+>"],
    alwaysKeepHeadingPatterns: ["^#{1,6}\\s*字段", "^#{1,6}\\s*输出", "^#{1,6}\\s*禁止", "^#{1,6}\\s*规则"],
    minProfileChars: 120
  },
  batchOutcomeDefaults: {
    outcomeKeyMode: "outputFileName",
    noUpdateToolName: "mark_no_update",
    missingOutcomeCorrectionTemplate:
      "上一轮尚未为本批次所有选中模板提供处理结果，缺少 outputFileName：{{missingOutputFileNames}}。",
    maxCorrectionRounds: 3
  },
  coverageIndexDefaults: {
    relativePath: "metadata/coverage/coverage-index.json",
    corruptionStrategy: "fail",
    keyFields: [
      "bookId",
      "templateId",
      "outputFileName",
      "templateHash",
      "windowHash",
      "rulesSemanticHash",
      "submittedChapterRange"
    ]
  },
  reportPathPolicyDefaults: {
    mode: "flat",
    reportsAlias: "reports",
    allowSubdirectories: false
  },
  ruleLayerDefaults: {
    p0HardRules: [
      NO_WHOLE_BOOK_PRIOR_KNOWLEDGE_RULE,
      REPORT_METADATA_SOURCE_RULE,
      PUBLIC_REPORT_METADATA_RULE
    ],
    qualityRules: [MATERIAL_RESOURCE_COVERAGE_RULE, TEMPLATE_EXAMPLE_EVIDENCE_RULE],
    formatRules: [
      "正式报告标题必须使用 outputFileName 去掉扩展名后的报告名。",
      "正式报告不得复制模板状态、前置声明、示例或占位正文。"
    ],
    postWriteGuards: [
      "正式报告不得包含 runs/job、assets/books、本机绝对路径或 window-0001 等内部运行标识。",
      "正式报告不得包含状态：模板或状态：草案。"
    ]
  },
  quantityPolicyDefaults: {
    allowZeroWhenNoEvidence: true,
    defaultMinItemsWhenEvidenceExists: 1,
    evidenceScope: "current-window"
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
    restart: {
      label: "重新开始"
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
      allowedActions: ["resume", "restart", "delete"]
    },
    completed: {
      label: "已完成",
      allowedActions: ["delete"]
    },
    failed: {
      label: "失败",
      allowedActions: ["resume", "restart", "delete"]
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
