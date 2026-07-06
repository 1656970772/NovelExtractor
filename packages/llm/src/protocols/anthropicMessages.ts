import type {
  ChatCompletionAssistantMessage,
  ChatCompletionMessage,
  ChatCompletionRequestToolCall,
  ChatCompletionToolMessage,
  ToolCall,
} from "../openAiCompatibleClient";
import type { ToolDefinition } from "../toolDefinition";
import { asRecord } from "./shared";
import { projectToolSchema } from "./toolSchemaProjection";
import type { BuildProtocolBodyInput, LlmProtocolAdapter } from "./types";

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

type AnthropicMessage =
  | {
      role: "user";
      content: Array<AnthropicTextBlock | AnthropicToolResultBlock>;
    }
  | {
      role: "assistant";
      content: Array<AnthropicTextBlock | AnthropicToolUseBlock>;
    };

function lowerTextBlock(content: string): AnthropicTextBlock {
  return {
    type: "text",
    text: content,
  };
}

function lowerTool(tool: ToolDefinition): AnthropicTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: projectToolSchema("anthropic", tool.inputSchema),
  };
}

function lowerToolCall(toolCall: ChatCompletionRequestToolCall): AnthropicToolUseBlock {
  return {
    type: "tool_use",
    id: toolCall.id,
    name: toolCall.name,
    input: toolCall.arguments,
  };
}

function lowerAssistantMessage(message: ChatCompletionAssistantMessage): AnthropicMessage {
  return {
    role: "assistant",
    content: [
      ...(message.content ? [lowerTextBlock(message.content)] : []),
      ...(message.toolCalls?.map(lowerToolCall) ?? []),
    ],
  };
}

function lowerToolMessage(message: ChatCompletionToolMessage): AnthropicMessage {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content,
      },
    ],
  };
}

function lowerMessage(message: Exclude<ChatCompletionMessage, { role: "system" }>): AnthropicMessage {
  if (message.role === "assistant") {
    return lowerAssistantMessage(message);
  }

  if (message.role === "tool") {
    return lowerToolMessage(message);
  }

  return {
    role: "user",
    content: [lowerTextBlock(message.content)],
  };
}

function splitSystemMessages(messages: ChatCompletionMessage[]): {
  system?: string;
  messages: Exclude<ChatCompletionMessage, { role: "system" }>[];
} {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const nonSystemMessages = messages.filter(
    (message): message is Exclude<ChatCompletionMessage, { role: "system" }> =>
      message.role !== "system",
  );

  return {
    ...(system ? { system } : {}),
    messages: nonSystemMessages,
  };
}

function lowerProviderOptions(providerOptions: Record<string, unknown>): Record<string, unknown> {
  const maxTokens = providerOptions.max_tokens;

  return typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0
    ? { max_tokens: maxTokens }
    : {};
}

function buildBody(input: BuildProtocolBodyInput): Record<string, unknown> {
  const { system, messages } = splitSystemMessages(input.messages);
  const tools = input.tools.map(lowerTool);
  const providerOptions = lowerProviderOptions(input.providerOptions);

  return {
    model: input.modelId,
    ...providerOptions,
    ...(system ? { system } : {}),
    messages: messages.map(lowerMessage),
    ...(tools.length ? { tools } : {}),
  };
}

function parseContentBlocks(content: unknown): { content: string; toolCalls: ToolCall[] } {
  if (!Array.isArray(content)) {
    return { content: "", toolCalls: [] };
  }

  const text: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const item of content) {
    const block = asRecord(item);

    if (block?.type === "text" && typeof block.text === "string") {
      text.push(block.text);
      continue;
    }

    if (block?.type !== "tool_use") {
      continue;
    }

    const name = block.name;
    if (typeof name !== "string" || name.trim() === "") {
      continue;
    }

    toolCalls.push({
      id: typeof block.id === "string" ? block.id : "",
      name,
      arguments: block.input,
    });
  }

  return {
    content: text.join(""),
    toolCalls,
  };
}

function parseResponse(responseBody: unknown) {
  const responseRecord = asRecord(responseBody);
  const parsed = parseContentBlocks(responseRecord?.content);

  return {
    content: parsed.content,
    usage: responseRecord?.usage,
    toolCalls: parsed.toolCalls,
  };
}

export const anthropicMessagesAdapter: LlmProtocolAdapter = {
  apiFormat: "anthropic_messages",
  path: () => "/messages",
  buildBody,
  parseResponse,
};
