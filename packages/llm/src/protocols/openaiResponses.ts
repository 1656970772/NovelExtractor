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

interface OpenAiResponsesTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: false;
}

interface OpenAiResponsesFunctionCall {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

interface OpenAiResponsesFunctionCallOutput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

type OpenAiResponsesInputItem =
  | Extract<ChatCompletionMessage, { role: "system" | "user" }>
  | {
      role: "assistant";
      content: string;
    }
  | OpenAiResponsesFunctionCall
  | OpenAiResponsesFunctionCallOutput;

function lowerTool(tool: ToolDefinition): OpenAiResponsesTool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: projectToolSchema("openai", tool.inputSchema),
    strict: false,
  };
}

function lowerToolCall(toolCall: ChatCompletionRequestToolCall): OpenAiResponsesFunctionCall {
  return {
    type: "function_call",
    call_id: toolCall.id,
    name: toolCall.name,
    arguments: encodeToolArguments(toolCall.arguments),
  };
}

function lowerAssistantMessage(message: ChatCompletionAssistantMessage): OpenAiResponsesInputItem[] {
  return [
    ...(message.content
      ? [
          {
            role: "assistant" as const,
            content: message.content,
          },
        ]
      : []),
    ...(message.toolCalls?.map(lowerToolCall) ?? []),
  ];
}

function lowerToolMessage(message: ChatCompletionToolMessage): OpenAiResponsesInputItem[] {
  return [
    {
      type: "function_call_output",
      call_id: message.toolCallId,
      output: message.content,
    },
  ];
}

function lowerMessage(message: ChatCompletionMessage): OpenAiResponsesInputItem[] {
  if (message.role === "assistant") {
    return lowerAssistantMessage(message);
  }

  if (message.role === "tool") {
    return lowerToolMessage(message);
  }

  return [message];
}

function buildBody(input: BuildProtocolBodyInput): Record<string, unknown> {
  return {
    model: input.modelId,
    input: input.messages.flatMap(lowerMessage),
    ...(input.tools.length ? { tools: input.tools.map(lowerTool) } : {}),
  };
}

function parseResponseContent(responseRecord: Record<string, unknown> | undefined): string {
  if (typeof responseRecord?.output_text === "string") {
    return responseRecord.output_text;
  }

  const output = responseRecord?.output;
  if (!Array.isArray(output)) {
    return "";
  }

  return output
    .flatMap((outputItem) => {
      const content = asRecord(outputItem)?.content;
      if (!Array.isArray(content)) {
        return [];
      }

      return content.flatMap((contentItem) => {
        const text = asRecord(contentItem)?.text;
        return typeof text === "string" ? [text] : [];
      });
    })
    .join("");
}

function parseResponseToolCalls(output: unknown): ToolCall[] {
  if (!Array.isArray(output)) {
    return [];
  }

  return output.flatMap((outputItem) => {
    const outputRecord = asRecord(outputItem);
    if (outputRecord?.type !== "function_call") {
      return [];
    }

    const name = outputRecord.name;
    if (typeof name !== "string" || name.trim() === "") {
      return [];
    }

    return [
      {
        id: typeof outputRecord.call_id === "string" ? outputRecord.call_id : "",
        name,
        arguments: parseProtocolToolArguments(outputRecord.arguments),
      },
    ];
  });
}

function parseResponse(responseBody: unknown) {
  const responseRecord = asRecord(responseBody);

  return {
    content: parseResponseContent(responseRecord),
    usage: responseRecord?.usage,
    toolCalls: parseResponseToolCalls(responseRecord?.output),
  };
}

export const openAiResponsesAdapter: LlmProtocolAdapter = {
  apiFormat: "openai_responses",
  path: () => "/responses",
  buildBody,
  parseResponse,
};
