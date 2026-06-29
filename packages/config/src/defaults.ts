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
  language: {
    id: "language",
    label: "语言"
  },
  userMenu: {
    id: "user-menu",
    label: "用户菜单"
  }
} as const;

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
    extractionChapterCount: 9
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
