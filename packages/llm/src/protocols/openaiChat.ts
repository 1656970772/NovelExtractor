import type {
  ChatCompletionAssistantMessage,
  ChatCompletionMessage,
  ChatCompletionRequestToolCall,
  ChatCompletionToolMessage,
  ToolCall,
} from "../openAiCompatibleClient";
import { encodeToolArguments, type ToolDefinition } from "../toolDefinition";
import { asRecord, parseProtocolToolArguments } from "./shared";
import { projectToolSchema } from "./toolSchemaProjection";
import type { BuildProtocolBodyInput, LlmProtocolAdapter } from "./types";

interface OpenAiChatTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAiChatAssistantToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

type OpenAiChatMessage =
  | Extract<ChatCompletionMessage, { role: "system" | "user" }>
  | {
      role: "assistant";
      content: string;
      tool_calls?: OpenAiChatAssistantToolCall[];
    }
  | {
      role: "tool";
      tool_call_id: string;
      name?: string;
      content: string;
    };

function lowerTool(tool: ToolDefinition): OpenAiChatTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: projectToolSchema("openai", tool.inputSchema),
    },
  };
}

function lowerToolCall(toolCall: ChatCompletionRequestToolCall): OpenAiChatAssistantToolCall {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: encodeToolArguments(toolCall.arguments),
    },
  };
}

function lowerAssistantMessage(message: ChatCompletionAssistantMessage): OpenAiChatMessage {
  return {
    role: "assistant",
    content: message.content,
    ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map(lowerToolCall) } : {}),
  };
}

function lowerToolMessage(message: ChatCompletionToolMessage): OpenAiChatMessage {
  return {
    role: "tool",
    tool_call_id: message.toolCallId,
    ...(message.name ? { name: message.name } : {}),
    content: message.content,
  };
}

function lowerMessage(message: ChatCompletionMessage): OpenAiChatMessage {
  if (message.role === "assistant") {
    return lowerAssistantMessage(message);
  }

  if (message.role === "tool") {
    return lowerToolMessage(message);
  }

  return message;
}

function buildBody(input: BuildProtocolBodyInput): Record<string, unknown> {
  return {
    model: input.modelId,
    messages: input.messages.map(lowerMessage),
    ...(input.tools.length ? { tools: input.tools.map(lowerTool) } : {}),
  };
}

function parseResponseToolCalls(toolCalls: unknown): ToolCall[] {
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls.flatMap((toolCall) => {
    const toolCallRecord = asRecord(toolCall);
    if (toolCallRecord?.type !== "function") {
      return [];
    }

    const functionRecord = asRecord(toolCallRecord.function);
    const name = functionRecord?.name;
    if (typeof name !== "string" || name.trim() === "") {
      return [];
    }

    return [
      {
        id: typeof toolCallRecord.id === "string" ? toolCallRecord.id : "",
        name,
        arguments: parseProtocolToolArguments(functionRecord?.arguments),
      },
    ];
  });
}

function parseResponse(responseBody: unknown) {
  const responseRecord = asRecord(responseBody);
  const choices = responseRecord?.choices;
  const firstChoice = Array.isArray(choices) ? asRecord(choices[0]) : undefined;
  const message = asRecord(firstChoice?.message);
  const content = message?.content;

  return {
    content: typeof content === "string" ? content : "",
    usage: responseRecord?.usage,
    toolCalls: parseResponseToolCalls(message?.tool_calls),
  };
}

export const openAiChatAdapter: LlmProtocolAdapter = {
  apiFormat: "openai_chat",
  path: () => "/chat/completions",
  buildBody,
  parseResponse,
};
