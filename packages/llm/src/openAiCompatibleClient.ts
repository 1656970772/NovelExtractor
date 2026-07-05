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

export interface OpenAiCompatibleRetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  transientErrorMessages: string[];
}

export interface OpenAiCompatibleClientOptions {
  fetch?: FetchLike;
  retry?: Partial<OpenAiCompatibleRetryOptions>;
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

interface OpenAiResponsesResponseBody {
  output_text?: unknown;
  output?: unknown;
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

interface OpenAiResponsesRequestTool {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

interface OpenAiResponsesRequestFunctionCall {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

interface OpenAiResponsesRequestFunctionCallOutput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

type OpenAiResponsesInputItem =
  | ChatCompletionContentMessage
  | {
      role: "assistant";
      content: string;
    }
  | OpenAiResponsesRequestFunctionCall
  | OpenAiResponsesRequestFunctionCallOutput;

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
  const inputTokens =
    optionalNumberField(usageRecord, "input_tokens") ?? numberField(usageRecord, "prompt_tokens");
  const outputTokens =
    optionalNumberField(usageRecord, "output_tokens") ??
    numberField(usageRecord, "completion_tokens");
  const cacheHitTokens =
    optionalNumberField(usageRecord, "prompt_cache_hit_tokens") ??
    numberField(promptDetails, "cached_tokens");

  return {
    requestCount: 1,
    inputTokens,
    outputTokens,
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
    return parseEmptyObjectPrefixedJsonObject(value) ?? value;
  }
}

function parseEmptyObjectPrefixedJsonObject(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{}")) {
    return undefined;
  }

  const suffix = trimmed.slice(2).trimStart();
  if (!suffix.startsWith("{")) {
    return undefined;
  }

  try {
    return JSON.parse(suffix);
  } catch {
    return undefined;
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

function serializeResponsesTool(tool: ToolSchema): OpenAiResponsesRequestTool {
  return {
    type: "function",
    name: tool.function.name,
    ...(tool.function.description !== undefined ? { description: tool.function.description } : {}),
    ...(tool.function.parameters !== undefined ? { parameters: tool.function.parameters } : {})
  };
}

function serializeResponsesToolCall(
  toolCall: ChatCompletionRequestToolCall
): OpenAiResponsesRequestFunctionCall {
  return {
    type: "function_call",
    call_id: toolCall.id,
    name: toolCall.name,
    arguments: serializeToolCallArguments(toolCall.arguments)
  };
}

function serializeResponsesMessage(message: ChatCompletionMessage): OpenAiResponsesInputItem[] {
  if (message.role === "assistant") {
    return [
      ...(message.content
        ? [
            {
              role: "assistant" as const,
              content: message.content
            }
          ]
        : []),
      ...(message.toolCalls?.map(serializeResponsesToolCall) ?? [])
    ];
  }

  if (message.role === "tool") {
    return [
      {
        type: "function_call_output",
        call_id: message.toolCallId,
        output: message.content
      }
    ];
  }

  return [message];
}

function createChatCompletionsBody(request: ChatCompletionRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.modelId,
    messages: request.messages.map(serializeMessage)
  };

  if (request.tools) {
    body.tools = request.tools;
  }

  return body;
}

function createResponsesBody(request: ChatCompletionRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.modelId,
    input: request.messages.flatMap(serializeResponsesMessage)
  };

  if (request.tools) {
    body.tools = request.tools.map(serializeResponsesTool);
  }

  return body;
}

function parseResponsesContent(responseBody: OpenAiResponsesResponseBody): string {
  if (typeof responseBody.output_text === "string") {
    return responseBody.output_text;
  }

  if (!Array.isArray(responseBody.output)) {
    return "";
  }

  return responseBody.output
    .flatMap((outputItem) => {
      const outputRecord = asRecord(outputItem);
      const content = outputRecord?.content;
      if (!Array.isArray(content)) {
        return [];
      }

      return content.flatMap((contentItem) => {
        const contentRecord = asRecord(contentItem);
        const text = contentRecord?.text;
        return typeof text === "string" ? [text] : [];
      });
    })
    .join("");
}

function parseResponsesToolCalls(output: unknown): ToolCall[] {
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
        arguments: parseToolCallArguments(outputRecord.arguments)
      }
    ];
  });
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

function responsesUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/responses`;
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

const DEFAULT_RETRY_OPTIONS: OpenAiCompatibleRetryOptions = {
  maxAttempts: 2,
  initialDelayMs: 250,
  maxDelayMs: 1000,
  transientErrorMessages: [
    "terminated",
    "fetch failed",
    "network error",
    "socket hang up",
    "ECONNRESET",
    "ETIMEDOUT",
    "EPIPE",
    "UND_ERR"
  ]
};

function normalizeRetryOptions(
  options: Partial<OpenAiCompatibleRetryOptions> | undefined
): OpenAiCompatibleRetryOptions {
  const maxAttempts = options?.maxAttempts ?? DEFAULT_RETRY_OPTIONS.maxAttempts;
  const initialDelayMs = options?.initialDelayMs ?? DEFAULT_RETRY_OPTIONS.initialDelayMs;
  const maxDelayMs = options?.maxDelayMs ?? DEFAULT_RETRY_OPTIONS.maxDelayMs;

  return {
    maxAttempts: Math.max(1, Math.floor(maxAttempts)),
    initialDelayMs: Math.max(0, Math.floor(initialDelayMs)),
    maxDelayMs: Math.max(0, Math.floor(maxDelayMs)),
    transientErrorMessages:
      options?.transientErrorMessages ?? DEFAULT_RETRY_OPTIONS.transientErrorMessages
  };
}

function isRetryableRequestError(
  error: unknown,
  retryOptions: OpenAiCompatibleRetryOptions
): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.message.startsWith("OpenAI-compatible request failed with HTTP")) {
    return false;
  }

  const message = error.message.toLowerCase();

  return retryOptions.transientErrorMessages.some((fragment) =>
    message.includes(fragment.toLowerCase())
  );
}

function retryDelayMs(
  failedAttemptIndex: number,
  retryOptions: OpenAiCompatibleRetryOptions
): number {
  const delay = retryOptions.initialDelayMs * 2 ** Math.max(0, failedAttemptIndex - 1);

  return Math.min(delay, retryOptions.maxDelayMs);
}

async function waitForRetry(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, delayMs));
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
    const apiFormat = this.provider.apiFormat;
    const body =
      apiFormat === "openai_responses"
        ? createResponsesBody(request)
        : createChatCompletionsBody(request);
    const url =
      apiFormat === "openai_responses"
        ? responsesUrl(this.provider.baseUrl)
        : completionUrl(this.provider.baseUrl);

    const retryOptions = normalizeRetryOptions(this.options.retry);

    for (let attempt = 1; attempt <= retryOptions.maxAttempts; attempt += 1) {
      try {
        return await this.sendChatCompletionOnce(body, apiKey, redactionOptions, apiFormat, url);
      } catch (error) {
        const hasMoreAttempts = attempt < retryOptions.maxAttempts;
        if (!hasMoreAttempts || !isRetryableRequestError(error, retryOptions)) {
          throw error;
        }

        await waitForRetry(retryDelayMs(attempt, retryOptions));
      }
    }

    throw new Error("OpenAI-compatible request retry loop exited unexpectedly");
  }

  private async sendChatCompletionOnce(
    body: Record<string, unknown>,
    apiKey: string,
    redactionOptions: RedactSecretsOptions,
    apiFormat: OpenAiCompatibleProviderDefinition["apiFormat"],
    url: string
  ): Promise<ChatCompletionResult> {
    let response: Response;
    try {
      response = await getFetch(this.options)(url, {
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

    if (apiFormat === "openai_responses") {
      const completion = responseBody as OpenAiResponsesResponseBody;
      return {
        content: parseResponsesContent(completion),
        usage: completion.usage,
        normalizedUsage: normalizeUsage(completion.usage),
        toolCalls: parseResponsesToolCalls(completion.output),
        raw: responseBody
      };
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
