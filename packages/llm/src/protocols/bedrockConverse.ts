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
import type { LlmProtocolAdapter } from "./types";

interface BedrockTextBlock {
  text: string;
}

interface BedrockToolUseBlock {
  toolUse: {
    toolUseId: string;
    name: string;
    input: unknown;
  };
}

interface BedrockToolResultBlock {
  toolResult: {
    toolUseId: string;
    content: BedrockTextBlock[];
  };
}

type BedrockAssistantBlock = BedrockTextBlock | BedrockToolUseBlock;
type BedrockUserBlock = BedrockTextBlock | BedrockToolResultBlock;

type BedrockMessage =
  | {
      role: "assistant";
      content: BedrockAssistantBlock[];
    }
  | {
      role: "user";
      content: BedrockUserBlock[];
    };

interface BedrockToolSpec {
  toolSpec: {
    name: string;
    description: string;
    inputSchema: {
      json: Record<string, unknown>;
    };
  };
}

function lowerSystem(messages: ChatCompletionMessage[]): BedrockTextBlock[] | undefined {
  const text = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");

  return text ? [{ text }] : undefined;
}

function lowerToolCall(toolCall: ChatCompletionRequestToolCall): BedrockToolUseBlock {
  return {
    toolUse: {
      toolUseId: toolCall.id,
      name: toolCall.name,
      input: toolCall.arguments,
    },
  };
}

function lowerAssistantMessage(message: ChatCompletionAssistantMessage): BedrockMessage {
  return {
    role: "assistant",
    content: [
      ...(message.content ? [{ text: message.content }] : []),
      ...(message.toolCalls?.map(lowerToolCall) ?? []),
    ],
  };
}

function lowerToolMessage(message: ChatCompletionToolMessage): BedrockMessage {
  return {
    role: "user",
    content: [
      {
        toolResult: {
          toolUseId: message.toolCallId,
          content: [{ text: message.content }],
        },
      },
    ],
  };
}

function lowerMessage(message: ChatCompletionMessage): BedrockMessage | undefined {
  if (message.role === "system") {
    return undefined;
  }

  if (message.role === "assistant") {
    return lowerAssistantMessage(message);
  }

  if (message.role === "tool") {
    return lowerToolMessage(message);
  }

  return {
    role: "user",
    content: [{ text: message.content }],
  };
}

function lowerMessages(messages: ChatCompletionMessage[]): BedrockMessage[] {
  return messages.flatMap((message) => {
    const lowered = lowerMessage(message);
    return lowered ? [lowered] : [];
  });
}

function lowerTool(tool: ToolDefinition): BedrockToolSpec {
  return {
    toolSpec: {
      name: tool.name,
      description: tool.description,
      inputSchema: {
        json: projectToolSchema("bedrock", tool.inputSchema),
      },
    },
  };
}

function lowerTools(tools: ToolDefinition[]): { tools: BedrockToolSpec[] } | undefined {
  return tools.length ? { tools: tools.map(lowerTool) } : undefined;
}

function parseContent(content: unknown): { text: string[]; toolCalls: ToolCall[] } {
  if (!Array.isArray(content)) {
    return { text: [], toolCalls: [] };
  }

  const text: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const part of content) {
    const record = asRecord(part);
    if (typeof record?.text === "string") {
      text.push(record.text);
    }

    const toolUse = asRecord(record?.toolUse);
    if (typeof toolUse?.name === "string" && toolUse.name.trim() !== "") {
      toolCalls.push({
        id: typeof toolUse.toolUseId === "string" ? toolUse.toolUseId : "",
        name: toolUse.name,
        arguments: toolUse.input ?? {},
      });
    }
  }

  return { text, toolCalls };
}

export const bedrockConverseAdapter: LlmProtocolAdapter = {
  apiFormat: "bedrock_converse",
  path: ({ modelId }) => `/model/${encodeURIComponent(modelId)}/converse`,
  buildBody(input) {
    const system = lowerSystem(input.messages);
    const toolConfig = lowerTools(input.tools);

    return {
      ...(system ? { system } : {}),
      messages: lowerMessages(input.messages),
      ...(toolConfig ? { toolConfig } : {}),
    };
  },
  parseResponse(responseBody) {
    const body = asRecord(responseBody);
    const content = asRecord(asRecord(body?.output)?.message)?.content;
    const parsed = parseContent(content);

    return {
      content: parsed.text.join(""),
      usage: body?.usage,
      toolCalls: parsed.toolCalls,
    };
  },
};
