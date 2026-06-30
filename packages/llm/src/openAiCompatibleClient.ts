import type { CredentialStore as DomainCredentialStore } from "@novel-extractor/domain";
import type { OpenAiCompatibleProviderDefinition } from "./providerRegistry";
import { redactSecrets, type RedactSecretsOptions } from "./redaction";

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ChatCompletionRequest {
  providerId: string;
  modelId: string;
  messages: ChatCompletionMessage[];
  tools?: ToolSchema[];
}

export type ToolCallArguments =
  | string
  | number
  | boolean
  | null
  | Record<string, unknown>
  | unknown[];

export type ChatCompletionMessage =
  | ChatCompletionContentMessage
  | ChatCompletionAssistantMessage
  | ChatCompletionToolMessage;

export interface ChatCompletionContentMessage {
  role: "system" | "user";
  content: string;
}

export interface ChatCompletionAssistantMessage {
  role: "assistant";
  content: string;
  toolCalls?: ChatCompletionRequestToolCall[];
}

export interface ChatCompletionToolMessage {
  role: "tool";
  toolCallId: string;
  name?: string;
  content: string;
}

export interface ChatCompletionRequestToolCall {
  id: string;
  name: string;
  arguments: ToolCallArguments;
}

export interface ChatCompletionResult {
  content: string;
  usage?: unknown;
  normalizedUsage: NormalizedUsage;
  toolCalls: ToolCall[];
  raw: unknown;
}

export interface NormalizedUsage {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  reasoningTokens: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ConnectionTestResult {
  ok: boolean;
  error?: string;
  raw?: unknown;
}

export type CredentialStore = Pick<DomainCredentialStore, "resolveApiKey">;

export type FetchLike = typeof fetch;

export interface OpenAiCompatibleClientOptions {
  fetch?: FetchLike;
}

interface OpenAiCompatibleResponseBody {
  choices?: Array<{
    message?: {
      content?: unknown;
      tool_calls?: unknown;
    };
  }>;
  usage?: unknown;
}

interface OpenAiCompatibleRequestToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

type OpenAiCompatibleRequestMessage =
  | ChatCompletionContentMessage
  | {
      role: "assistant";
      content: string;
      tool_calls?: OpenAiCompatibleRequestToolCall[];
    }
  | {
      role: "tool";
      tool_call_id: string;
      name?: string;
      content: string;
    };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return undefined;
}

function optionalNumberField(
  source: Record<string, unknown> | undefined,
  field: string
): number | undefined {
  const value = source?.[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberField(source: Record<string, unknown> | undefined, field: string): number {
  return optionalNumberField(source, field) ?? 0;
}

function normalizeUsage(usage: unknown): NormalizedUsage {
  const usageRecord = asRecord(usage);
  const promptDetails = asRecord(usageRecord?.prompt_tokens_details);
  const completionDetails = asRecord(usageRecord?.completion_tokens_details);
  const inputTokens = numberField(usageRecord, "prompt_tokens");
  const cacheHitTokens =
    optionalNumberField(usageRecord, "prompt_cache_hit_tokens") ??
    numberField(promptDetails, "cached_tokens");

  return {
    requestCount: 1,
    inputTokens,
    outputTokens: numberField(usageRecord, "completion_tokens"),
    totalTokens: numberField(usageRecord, "total_tokens"),
    cacheHitTokens,
    cacheMissTokens: Math.max(inputTokens - cacheHitTokens, 0),
    reasoningTokens:
      optionalNumberField(completionDetails, "reasoning_tokens") ??
      numberField(usageRecord, "reasoning_tokens")
  };
}

function parseToolCallArguments(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseToolCalls(toolCalls: unknown): ToolCall[] {
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls.flatMap((toolCall) => {
    const toolCallRecord = asRecord(toolCall);
    if (toolCallRecord?.type !== "function") {
      return [];
    }

    const functionRecord = asRecord(toolCallRecord?.function);
    const name = functionRecord?.name;
    if (typeof name !== "string" || name.trim() === "") {
      return [];
    }

    return [{
      id: typeof toolCallRecord?.id === "string" ? toolCallRecord.id : "",
      name,
      arguments: parseToolCallArguments(functionRecord?.arguments)
    }];
  });
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }

  const record = asRecord(value);
  if (!record) {
    return value;
  }

  return Object.keys(record)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      result[key] = stableJsonValue(record[key]);
      return result;
    }, {});
}

function serializeToolCallArguments(value: ToolCallArguments): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(stableJsonValue(value)) ?? "";
}

function serializeToolCall(toolCall: ChatCompletionRequestToolCall): OpenAiCompatibleRequestToolCall {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: serializeToolCallArguments(toolCall.arguments)
    }
  };
}

function serializeMessage(message: ChatCompletionMessage): OpenAiCompatibleRequestMessage {
  if (message.role === "assistant") {
    const serialized: OpenAiCompatibleRequestMessage = {
      role: "assistant",
      content: message.content
    };

    if (message.toolCalls?.length) {
      serialized.tool_calls = message.toolCalls.map(serializeToolCall);
    }

    return serialized;
  }

  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      ...(message.name ? { name: message.name } : {}),
      content: message.content
    };
  }

  return message;
}

function getFetch(options: OpenAiCompatibleClientOptions): FetchLike {
  const fetcher = options.fetch ?? globalThis.fetch;

  if (!fetcher) {
    throw new Error("fetch is not available");
  }

  return fetcher;
}

function completionUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function redactionOptionsFor(apiKey: string): RedactSecretsOptions {
  return { knownSecrets: [apiKey] };
}

function formatSafeError(error: unknown, options?: RedactSecretsOptions): string {
  if (error instanceof Error) {
    return redactSecrets(error.message, options);
  }

  if (typeof error === "string") {
    return redactSecrets(error, options);
  }

  return JSON.stringify(redactSecrets(error, options));
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatHttpError(
  response: Response,
  body: unknown,
  options: RedactSecretsOptions
): string {
  const safeBody = redactSecrets(body, options);
  const bodyText = typeof safeBody === "string" ? safeBody : JSON.stringify(safeBody);

  return `OpenAI-compatible request failed with HTTP ${response.status} ${response.statusText}: ${bodyText}`;
}

export class OpenAiCompatibleClient {
  constructor(
    private readonly provider: OpenAiCompatibleProviderDefinition,
    private readonly credentials: CredentialStore,
    private readonly options: OpenAiCompatibleClientOptions = {}
  ) {}

  async chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    this.assertProviderMatches(request);
    const apiKey = await this.resolveApiKey();

    return this.sendChatCompletion(request, apiKey);
  }

  async testConnection(request: ChatCompletionRequest): Promise<ConnectionTestResult> {
    let apiKey: string | undefined;

    try {
      this.assertProviderMatches(request);
      apiKey = await this.resolveApiKey();
      const result = await this.sendChatCompletion(request, apiKey);
      return { ok: true, raw: redactSecrets(result.raw, redactionOptionsFor(apiKey)) };
    } catch (error) {
      const options = apiKey ? redactionOptionsFor(apiKey) : undefined;
      return { ok: false, error: formatSafeError(error, options) };
    }
  }

  private assertProviderMatches(request: ChatCompletionRequest): void {
    if (request.providerId !== this.provider.id) {
      throw new Error(
        `Request provider ${request.providerId} does not match client provider ${this.provider.id}`
      );
    }
  }

  private async sendChatCompletion(
    request: ChatCompletionRequest,
    apiKey: string
  ): Promise<ChatCompletionResult> {
    const redactionOptions = redactionOptionsFor(apiKey);
    const body: Record<string, unknown> = {
      model: request.modelId,
      messages: request.messages.map(serializeMessage)
    };

    if (request.tools) {
      body.tools = request.tools;
    }

    let response: Response;
    try {
      response = await getFetch(this.options)(completionUrl(this.provider.baseUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
    } catch (error) {
      throw new Error(formatSafeError(error, redactionOptions));
    }

    let responseBody: unknown;
    try {
      responseBody = await readResponseBody(response);
    } catch (error) {
      throw new Error(formatSafeError(error, redactionOptions));
    }

    if (!response.ok) {
      throw new Error(formatHttpError(response, responseBody, redactionOptions));
    }

    const completion = responseBody as OpenAiCompatibleResponseBody;
    const message = completion.choices?.[0]?.message;
    const content = message?.content;

    return {
      content: typeof content === "string" ? content : "",
      usage: completion.usage,
      normalizedUsage: normalizeUsage(completion.usage),
      toolCalls: parseToolCalls(message?.tool_calls),
      raw: responseBody
    };
  }

  private async resolveApiKey(): Promise<string> {
    const apiKeyRef = this.provider.apiKeyRef;

    if (!apiKeyRef) {
      throw new Error(`API key reference is not configured for provider ${this.provider.id}`);
    }

    let apiKey: string | null;
    try {
      apiKey = await this.credentials.resolveApiKey(apiKeyRef);
    } catch (error) {
      throw new Error(formatSafeError(error));
    }

    if (!apiKey) {
      throw new Error(`API key is not available for provider ${this.provider.id}`);
    }

    return apiKey;
  }
}
