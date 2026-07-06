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

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface GeminiTextPart {
  text: string;
}

interface GeminiFunctionCallPart {
  functionCall: {
    id?: string;
    name: string;
    args: unknown;
  };
}

interface GeminiFunctionResponsePart {
  functionResponse: {
    id: string;
    name: string;
    response: {
      name: string;
      content: string;
    };
  };
}

type GeminiPart = GeminiTextPart | GeminiFunctionCallPart | GeminiFunctionResponsePart;

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

function lowerTool(tool: ToolDefinition): GeminiFunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parameters: projectToolSchema("gemini", tool.inputSchema),
  };
}

function lowerToolCall(toolCall: ChatCompletionRequestToolCall): GeminiFunctionCallPart {
  return {
    functionCall: {
      id: toolCall.id,
      name: toolCall.name,
      args: toolCall.arguments,
    },
  };
}

function lowerAssistantMessage(message: ChatCompletionAssistantMessage): GeminiContent {
  return {
    role: "model",
    parts: [
      ...(message.content ? [{ text: message.content }] : []),
      ...(message.toolCalls?.map(lowerToolCall) ?? []),
    ],
  };
}

function lowerToolMessage(message: ChatCompletionToolMessage): GeminiContent {
  const name = message.name ?? "tool_result";

  return {
    role: "user",
    parts: [
      {
        functionResponse: {
          id: message.toolCallId,
          name,
          response: {
            name,
            content: message.content,
          },
        },
      },
    ],
  };
}

function lowerMessage(message: ChatCompletionMessage): GeminiContent[] {
  if (message.role === "system") {
    return [];
  }

  if (message.role === "assistant") {
    return [lowerAssistantMessage(message)];
  }

  if (message.role === "tool") {
    return [lowerToolMessage(message)];
  }

  return [
    {
      role: "user",
      parts: [{ text: message.content }],
    },
  ];
}

function lowerSystemInstruction(messages: ChatCompletionMessage[]):
  | { parts: Array<{ text: string }> }
  | undefined {
  const text = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");

  return text ? { parts: [{ text }] } : undefined;
}

function lowerTools(tools: ToolDefinition[]): Array<{ functionDeclarations: GeminiFunctionDeclaration[] }> | undefined {
  if (tools.length === 0) {
    return undefined;
  }

  return [{ functionDeclarations: tools.map(lowerTool) }];
}

function buildBody(input: BuildProtocolBodyInput): Record<string, unknown> {
  const systemInstruction = lowerSystemInstruction(input.messages);
  const tools = lowerTools(input.tools);

  return {
    ...(systemInstruction ? { systemInstruction } : {}),
    contents: input.messages.flatMap(lowerMessage),
    ...(tools ? { tools } : {}),
  };
}

function parseResponseContent(parts: unknown): string {
  if (!Array.isArray(parts)) {
    return "";
  }

  return parts
    .flatMap((part) => {
      const text = asRecord(part)?.text;
      return typeof text === "string" ? [text] : [];
    })
    .join("");
}

function parseResponseToolCalls(parts: unknown): ToolCall[] {
  if (!Array.isArray(parts)) {
    return [];
  }

  let nextToolCallId = 1;

  return parts.flatMap((part) => {
    const partRecord = asRecord(part);
    const functionCall = asRecord(partRecord?.functionCall);
    if (!functionCall) {
      return [];
    }

    const name = functionCall?.name;
    if (typeof name !== "string" || name.trim() === "") {
      return [];
    }

    const providerId = functionCall.id;
    const id = typeof providerId === "string" && providerId.trim() !== ""
      ? providerId
      : `gemini-call-${nextToolCallId}`;
    nextToolCallId += 1;

    return [
      {
        id,
        name,
        arguments: functionCall.args ?? {},
      },
    ];
  });
}

function parseResponse(responseBody: unknown) {
  const responseRecord = asRecord(responseBody);
  const candidates = responseRecord?.candidates;
  const firstCandidate = Array.isArray(candidates) ? asRecord(candidates[0]) : undefined;
  const content = asRecord(firstCandidate?.content);
  const parts = content?.parts;

  return {
    content: parseResponseContent(parts),
    usage: responseRecord?.usageMetadata,
    toolCalls: parseResponseToolCalls(parts),
  };
}

export const geminiGenerateContentAdapter: LlmProtocolAdapter = {
  apiFormat: "gemini_generate_content",
  path: ({ modelId }) => `/models/${encodeURIComponent(modelId)}:generateContent`,
  buildBody,
  parseResponse,
};
