import type { ProviderApiFormat } from "@novel-extractor/config";
import { anthropicMessagesAdapter } from "./anthropicMessages";
import { bedrockConverseAdapter } from "./bedrockConverse";
import { geminiGenerateContentAdapter } from "./geminiGenerateContent";
import { openAiChatAdapter } from "./openaiChat";
import { openAiResponsesAdapter } from "./openaiResponses";
import type { LlmProtocolAdapter } from "./types";

const adapters: Record<ProviderApiFormat, LlmProtocolAdapter> = {
  openai_chat: openAiChatAdapter,
  openai_responses: openAiResponsesAdapter,
  anthropic_messages: anthropicMessagesAdapter,
  gemini_generate_content: geminiGenerateContentAdapter,
  bedrock_converse: bedrockConverseAdapter,
};

export function getProtocolAdapter(apiFormat: ProviderApiFormat): LlmProtocolAdapter {
  return adapters[apiFormat];
}

export {
  anthropicMessagesAdapter,
  bedrockConverseAdapter,
  geminiGenerateContentAdapter,
  openAiChatAdapter,
  openAiResponsesAdapter,
};
