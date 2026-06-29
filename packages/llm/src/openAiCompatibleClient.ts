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
  messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
  tools?: ToolSchema[];
}

export interface ChatCompletionResult {
  content: string;
  usage?: unknown;
  raw: unknown;
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
    };
  }>;
  usage?: unknown;
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
      messages: request.messages
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
    const content = completion.choices?.[0]?.message?.content;

    return {
      content: typeof content === "string" ? content : "",
      usage: completion.usage,
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
