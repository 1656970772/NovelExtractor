import type { CredentialStore as DomainCredentialStore } from "@novel-extractor/domain";
import type { OpenAiCompatibleProviderDefinition } from "./providerRegistry";
import { getProtocolAdapter } from "./protocols";
import { redactSecrets, type RedactSecretsOptions } from "./redaction";
import type { ToolDefinition } from "./toolDefinition";

export type ToolSchema = ToolDefinition;

export interface ChatCompletionRequest {
  providerId: string;
  modelId: string;
  messages: ChatCompletionMessage[];
  tools?: ToolDefinition[];
  providerOptions?: Record<string, unknown>;
  onRequestPrepared?: (snapshot: PreparedChatCompletionRequest) => void | Promise<void>;
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
  requestBody?: unknown;
  requestApiFormat?: OpenAiCompatibleProviderDefinition["apiFormat"];
}

export interface PreparedChatCompletionRequest {
  apiFormat: OpenAiCompatibleProviderDefinition["apiFormat"];
  url: string;
  body: unknown;
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

export type OpenAiCompatibleRequestErrorKind = "http" | "network" | "response_body";

export interface OpenAiCompatibleRequestErrorDetails {
  status?: number;
  statusText?: string;
  body?: unknown;
}

export class OpenAiCompatibleRequestError extends Error {
  constructor(
    message: string,
    public readonly kind: OpenAiCompatibleRequestErrorKind,
    public readonly details: OpenAiCompatibleRequestErrorDetails = {}
  ) {
    super(message);
    this.name = "OpenAiCompatibleRequestError";
  }
}

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

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getFetch(options: OpenAiCompatibleClientOptions): FetchLike {
  const fetcher = options.fetch ?? globalThis.fetch;

  if (!fetcher) {
    throw new Error("fetch is not available");
  }

  return fetcher;
}

function redactionOptionsFor(apiKey: string): RedactSecretsOptions {
  return { knownSecrets: [apiKey] };
}

function assertSendableAuthScheme(provider: OpenAiCompatibleProviderDefinition): void {
  if (provider.authScheme === "aws-sigv4") {
    throw new Error("Bedrock Converse requires AWS SigV4 signing before native Bedrock requests can be sent.");
  }
}

function createAuthHeaders(
  authScheme: OpenAiCompatibleProviderDefinition["authScheme"],
  apiKey: string
): Record<string, string> {
  switch (authScheme) {
    case "bearer":
      return { Authorization: `Bearer ${apiKey}` };
    case "anthropic-api-key":
      return {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      };
    case "google-api-key":
      return { "x-goog-api-key": apiKey };
    case "aws-sigv4":
      throw new Error("Bedrock Converse requires AWS SigV4 signing before native Bedrock requests can be sent.");
  }
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
  const safeStatusText = redactSecrets(response.statusText, options);
  const safeBody = redactSecrets(body, options);
  const bodyText = typeof safeBody === "string" ? safeBody : JSON.stringify(safeBody);

  return `OpenAI-compatible request failed with HTTP ${response.status} ${safeStatusText}: ${bodyText}`;
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

  if (error instanceof OpenAiCompatibleRequestError && error.kind === "http") {
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
    assertSendableAuthScheme(this.provider);
    const apiKey = await this.resolveApiKey();

    return this.sendChatCompletion(request, apiKey);
  }

  async testConnection(request: ChatCompletionRequest): Promise<ConnectionTestResult> {
    let apiKey: string | undefined;

    try {
      this.assertProviderMatches(request);
      assertSendableAuthScheme(this.provider);
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
    const adapter = getProtocolAdapter(apiFormat);
    const body = adapter.buildBody({
      modelId: request.modelId,
      messages: request.messages,
      tools: request.tools ?? [],
      providerOptions: request.providerOptions ?? {}
    });
    const url = `${this.provider.baseUrl.replace(/\/+$/, "")}${adapter.path({
      baseUrl: this.provider.baseUrl,
      modelId: request.modelId
    })}`;
    await request.onRequestPrepared?.({
      apiFormat,
      url,
      body: cloneJsonValue(body)
    });

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
          ...createAuthHeaders(this.provider.authScheme, apiKey),
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
    } catch (error) {
      const safeMessage = formatSafeError(error, redactionOptions);
      throw new OpenAiCompatibleRequestError(safeMessage, "network", { body: safeMessage });
    }

    let responseBody: unknown;
    try {
      responseBody = await readResponseBody(response);
    } catch (error) {
      const safeMessage = formatSafeError(error, redactionOptions);
      throw new OpenAiCompatibleRequestError(safeMessage, "response_body", {
        status: response.status,
        statusText: redactSecrets(response.statusText, redactionOptions),
        body: safeMessage
      });
    }

    if (!response.ok) {
      throw new OpenAiCompatibleRequestError(
        formatHttpError(response, responseBody, redactionOptions),
        "http",
        {
          status: response.status,
          statusText: redactSecrets(response.statusText, redactionOptions),
          body: redactSecrets(responseBody, redactionOptions)
        }
      );
    }

    const adapter = getProtocolAdapter(this.provider.apiFormat);
    const parsed = adapter.parseResponse(responseBody);

    return {
      content: parsed.content,
      usage: parsed.usage,
      normalizedUsage: parsed.normalizedUsage ?? normalizeUsage(parsed.usage),
      toolCalls: parsed.toolCalls,
      raw: responseBody,
      requestBody: body,
      requestApiFormat: apiFormat
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
