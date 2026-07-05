import type {
  ModelOption,
  ProviderApiFormat,
  ProviderPreset,
  ProviderPresetId,
  ProviderReasoningCapability
} from "./schema";

interface CcSwitchCatalogModel {
  model: string;
  displayName?: string;
  contextWindow?: number;
  supportsParallelToolCalls?: boolean;
  inputModalities?: Array<"text" | "image">;
  baseInstructions?: string;
}

interface CcSwitchPresetSeed {
  id: Exclude<ProviderPresetId, "custom-openai-compatible">;
  displayName: string;
  ccSwitchName: string;
  websiteUrl: string;
  apiKeyUrl?: string;
  modelsUrl?: string;
  baseUrl: string;
  endpointCandidates: string[];
  apiFormat: ProviderApiFormat;
  reasoning?: ProviderReasoningCapability;
  modelCatalog: CcSwitchCatalogModel[];
  supportsReasoning: boolean;
  icon?: string;
  iconColor?: string;
}

const xiaomiBaseInstructions =
  "You are MiMo, an AI assistant developed by Xiaomi. Today's date: {date} {week}. Your knowledge cutoff date is December 2024.";

const minimaxBaseInstructions =
  "You are Codex, a coding agent based on MiniMax-M3. You and the user share the same workspace and collaborate to achieve the user's goals.";

const deepseekReasoning: ProviderReasoningCapability = {
  supportsThinking: true,
  supportsEffort: true,
  thinkingParam: "thinking",
  effortParam: "reasoning_effort",
  effortValueMode: "deepseek",
  outputFormat: "reasoning_content"
};

const thinkingOnlyReasoning: ProviderReasoningCapability = {
  supportsThinking: true,
  supportsEffort: false,
  thinkingParam: "thinking",
  effortParam: "none",
  outputFormat: "reasoning_content"
};

const CC_SWITCH_CODEX_P1_PRESETS: CcSwitchPresetSeed[] = [
  {
    id: "deepseek",
    displayName: "DeepSeek",
    ccSwitchName: "DeepSeek",
    websiteUrl: "https://platform.deepseek.com",
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
    // cc-switch Codex preset lacks modelsUrl; reuse Claude DeepSeek root /models override.
    modelsUrl: "https://api.deepseek.com/models",
    baseUrl: "https://api.deepseek.com",
    endpointCandidates: ["https://api.deepseek.com"],
    apiFormat: "openai_chat",
    supportsReasoning: true,
    reasoning: deepseekReasoning,
    modelCatalog: [
      { model: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", contextWindow: 1000000 },
      { model: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", contextWindow: 1000000 }
    ],
    icon: "deepseek",
    iconColor: "#1E88E5"
  },
  {
    id: "zhipu-glm",
    displayName: "GLM（智谱）",
    ccSwitchName: "Zhipu GLM",
    websiteUrl: "https://open.bigmodel.cn",
    apiKeyUrl: "https://www.bigmodel.cn/claude-code?ic=RRVJPB5SII",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    endpointCandidates: ["https://open.bigmodel.cn/api/coding/paas/v4"],
    apiFormat: "openai_chat",
    supportsReasoning: true,
    reasoning: thinkingOnlyReasoning,
    modelCatalog: [{ model: "glm-5.2", displayName: "GLM-5.2", contextWindow: 200000 }],
    icon: "zhipu",
    iconColor: "#0F62FE"
  },
  {
    id: "zhipu-glm-en",
    displayName: "GLM（智谱国际）",
    ccSwitchName: "Zhipu GLM en",
    websiteUrl: "https://z.ai",
    apiKeyUrl: "https://z.ai/subscribe?ic=8JVLJQFSKB",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    endpointCandidates: ["https://api.z.ai/api/coding/paas/v4"],
    apiFormat: "openai_chat",
    supportsReasoning: true,
    reasoning: thinkingOnlyReasoning,
    modelCatalog: [{ model: "glm-5.2", displayName: "GLM-5.2", contextWindow: 200000 }],
    icon: "zhipu",
    iconColor: "#0F62FE"
  },
  {
    id: "qwen-bailian",
    displayName: "Qwen（通义千问 / 阿里百炼）",
    ccSwitchName: "Bailian",
    websiteUrl: "https://bailian.console.aliyun.com",
    apiKeyUrl: "https://bailian.console.aliyun.com/#/api-key",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    endpointCandidates: ["https://dashscope.aliyuncs.com/compatible-mode/v1"],
    apiFormat: "openai_responses",
    supportsReasoning: false,
    modelCatalog: [{ model: "qwen3-coder-plus", displayName: "Qwen3 Coder Plus", contextWindow: 1048576 }],
    icon: "bailian",
    iconColor: "#624AFF"
  },
  {
    id: "kimi",
    displayName: "Kimi",
    ccSwitchName: "Kimi",
    websiteUrl: "https://platform.kimi.com?aff=cc-switch",
    apiKeyUrl: "https://platform.kimi.com/console/api-keys?aff=cc-switch",
    baseUrl: "https://api.moonshot.cn/v1",
    endpointCandidates: ["https://api.moonshot.cn/v1"],
    apiFormat: "openai_chat",
    supportsReasoning: true,
    reasoning: thinkingOnlyReasoning,
    modelCatalog: [{ model: "kimi-k2.7-code", displayName: "Kimi K2.7 Code", contextWindow: 262144 }],
    icon: "kimi",
    iconColor: "#6366F1"
  },
  {
    id: "kimi-for-coding",
    displayName: "Kimi For Coding",
    ccSwitchName: "Kimi For Coding",
    websiteUrl: "https://www.kimi.com/code/?aff=cc-switch",
    apiKeyUrl: "https://www.kimi.com/code/?aff=cc-switch",
    baseUrl: "https://api.kimi.com/coding/v1",
    endpointCandidates: ["https://api.kimi.com/coding/v1"],
    apiFormat: "openai_chat",
    supportsReasoning: true,
    reasoning: thinkingOnlyReasoning,
    modelCatalog: [{ model: "kimi-for-coding", displayName: "Kimi For Coding", contextWindow: 262144 }],
    icon: "kimi",
    iconColor: "#6366F1"
  },
  {
    id: "minimax",
    displayName: "MiniMax",
    ccSwitchName: "MiniMax",
    websiteUrl: "https://platform.minimaxi.com",
    apiKeyUrl: "https://platform.minimaxi.com/subscribe/coding-plan",
    baseUrl: "https://api.minimaxi.com/v1",
    endpointCandidates: ["https://api.minimaxi.com/v1"],
    apiFormat: "openai_responses",
    supportsReasoning: false,
    modelCatalog: [
      {
        model: "MiniMax-M3",
        displayName: "MiniMax-M3",
        contextWindow: 1000000,
        supportsParallelToolCalls: true,
        inputModalities: ["text", "image"],
        baseInstructions: minimaxBaseInstructions
      }
    ],
    icon: "minimax",
    iconColor: "#FF6B6B"
  },
  {
    id: "minimax-en",
    displayName: "MiniMax International",
    ccSwitchName: "MiniMax en",
    websiteUrl: "https://platform.minimax.io",
    apiKeyUrl: "https://platform.minimax.io/subscribe/coding-plan",
    baseUrl: "https://api.minimax.io/v1",
    endpointCandidates: ["https://api.minimax.io/v1"],
    apiFormat: "openai_responses",
    supportsReasoning: false,
    modelCatalog: [
      {
        model: "MiniMax-M3",
        displayName: "MiniMax-M3",
        contextWindow: 1000000,
        supportsParallelToolCalls: true,
        inputModalities: ["text", "image"],
        baseInstructions: minimaxBaseInstructions
      }
    ],
    icon: "minimax",
    iconColor: "#FF6B6B"
  },
  {
    id: "xiaomi-mimo",
    displayName: "Xiaomi MiMo",
    ccSwitchName: "Xiaomi MiMo",
    websiteUrl: "https://platform.xiaomimimo.com",
    apiKeyUrl: "https://platform.xiaomimimo.com/#/console/api-keys",
    baseUrl: "https://api.xiaomimimo.com/v1",
    endpointCandidates: ["https://api.xiaomimimo.com/v1"],
    apiFormat: "openai_responses",
    supportsReasoning: false,
    modelCatalog: [
      {
        model: "mimo-v2.5-pro",
        displayName: "MiMo V2.5 Pro",
        contextWindow: 1048576,
        inputModalities: ["text"],
        baseInstructions: xiaomiBaseInstructions
      },
      {
        model: "mimo-v2.5",
        displayName: "MiMo V2.5",
        contextWindow: 1048576,
        inputModalities: ["text", "image"],
        baseInstructions: xiaomiBaseInstructions
      }
    ],
    icon: "xiaomimimo",
    iconColor: "#000000"
  },
  {
    id: "xiaomi-mimo-token-plan",
    displayName: "Xiaomi MiMo Token Plan（中国）",
    ccSwitchName: "Xiaomi MiMo Token Plan (China)",
    websiteUrl: "https://platform.xiaomimimo.com/#/token-plan",
    apiKeyUrl: "https://platform.xiaomimimo.com/#/console/plan-manage",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    endpointCandidates: ["https://token-plan-cn.xiaomimimo.com/v1"],
    apiFormat: "openai_responses",
    supportsReasoning: false,
    modelCatalog: [
      {
        model: "mimo-v2.5-pro",
        displayName: "MiMo V2.5 Pro",
        contextWindow: 1048576,
        inputModalities: ["text"],
        baseInstructions: xiaomiBaseInstructions
      },
      {
        model: "mimo-v2.5",
        displayName: "MiMo V2.5",
        contextWindow: 1048576,
        inputModalities: ["text", "image"],
        baseInstructions: xiaomiBaseInstructions
      }
    ],
    icon: "xiaomimimo",
    iconColor: "#000000"
  }
];

function toModelOption(seed: CcSwitchPresetSeed, model: CcSwitchCatalogModel): ModelOption {
  return {
    id: model.model,
    displayName: model.displayName ?? model.model,
    contextWindow: model.contextWindow,
    supportsTools: true,
    supportsReasoning: seed.supportsReasoning,
    supportsParallelToolCalls: model.supportsParallelToolCalls,
    inputModalities: model.inputModalities ? [...model.inputModalities] : undefined,
    baseInstructions: model.baseInstructions,
    usageMapping: "openai-compatible"
  };
}

function toProviderPreset(seed: CcSwitchPresetSeed): ProviderPreset {
  return {
    id: seed.id,
    displayName: seed.displayName,
    kind: "openai-compatible",
    baseUrl: seed.baseUrl,
    websiteUrl: seed.websiteUrl,
    apiKeyUrl: seed.apiKeyUrl,
    modelsUrl: seed.modelsUrl,
    endpointCandidates: [...seed.endpointCandidates],
    apiFormat: seed.apiFormat,
    reasoning: seed.reasoning ? { ...seed.reasoning } : undefined,
    authScheme: "bearer",
    models: seed.modelCatalog.map((model) => toModelOption(seed, model)),
    defaultModelPolicy: "first-enabled",
    allowsUserModels: false,
    icon: seed.icon,
    iconColor: seed.iconColor
  };
}

function createCustomOpenAiCompatiblePreset(): ProviderPreset {
  return {
    id: "custom-openai-compatible",
    displayName: "自定义 OpenAI-compatible",
    kind: "openai-compatible",
    apiFormat: "openai_chat",
    authScheme: "bearer",
    models: [],
    defaultModelPolicy: "user-required",
    allowsUserModels: true
  };
}

export function createCcSwitchProviderPresets(): ProviderPreset[] {
  return [...CC_SWITCH_CODEX_P1_PRESETS.map(toProviderPreset), createCustomOpenAiCompatiblePreset()];
}
