import type { ProviderApiFormat } from "@novel-extractor/config";
import type {
  ChatCompletionMessage,
  NormalizedUsage,
  ToolCall
} from "../openAiCompatibleClient";
import type { ToolDefinition } from "../toolDefinition";

export type LlmProtocolApiFormat =
  | ProviderApiFormat
  | "anthropic_messages"
  | "gemini_generate_content"
  | "bedrock_converse";

export interface ProtocolPathInput {
  baseUrl: string;
  modelId: string;
}

export interface BuildProtocolBodyInput {
  modelId: string;
  messages: ChatCompletionMessage[];
  tools: ToolDefinition[];
  providerOptions: Record<string, unknown>;
}

export interface ParsedProtocolResponse {
  content: string;
  usage: unknown;
  normalizedUsage?: NormalizedUsage;
  toolCalls: ToolCall[];
}

export interface LlmProtocolAdapter {
  apiFormat: LlmProtocolApiFormat;
  path(input: ProtocolPathInput): string;
  buildBody(input: BuildProtocolBodyInput): Record<string, unknown>;
  parseResponse(response: unknown): ParsedProtocolResponse;
}
