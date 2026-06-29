import { describe, expect, it, vi } from "vitest";
import type { CredentialStore as DomainCredentialStore } from "@novel-extractor/domain";
import { OpenAiCompatibleClient, type CredentialStore } from "./openAiCompatibleClient";
import type { OpenAiCompatibleProviderDefinition } from "./providerRegistry";

function createProvider(): OpenAiCompatibleProviderDefinition {
  return {
    id: "deepseek-user",
    presetId: "deepseek",
    displayName: "DeepSeek 用户配置",
    kind: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    authScheme: "bearer",
    apiKeyRef: { id: "key-1", providerConfigId: "deepseek-user" },
    allowsUserModels: false,
    models: [
      {
        id: "novel-analysis",
        displayName: "Novel Analysis",
        enabled: true,
        isDefault: true,
        supportsTools: true,
        supportsReasoning: false,
        usageMapping: "openai-compatible"
      }
    ]
  };
}

describe("OpenAiCompatibleClient", () => {
  it("resolves API keys through ApiKeyRef and sends an OpenAI-compatible chat request", async () => {
    const apiKey = "sk-" + "request-secret";
    const credentials: CredentialStore = {
      resolveApiKey: vi.fn(async (ref) => {
        expect(ref).toEqual({ id: "key-1", providerConfigId: "deepseek-user" });
        return apiKey;
      })
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(_input)).toBe("https://api.deepseek.com/chat/completions");
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe(`Bearer ${apiKey}`);
      expect(headers.get("Content-Type")).toBe("application/json");
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "novel-analysis",
        messages: [{ role: "user", content: "提取丹药信息" }],
        tools: [
          {
            type: "function",
            function: {
              name: "record_pill",
              parameters: { type: "object" }
            }
          }
        ]
      });

      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "丹药摘要" } }],
          usage: { total_tokens: 12 }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const client = new OpenAiCompatibleClient(createProvider(), credentials, { fetch: fetchMock });
    const result = await client.chatCompletion({
      providerId: "deepseek-user",
      modelId: "novel-analysis",
      messages: [{ role: "user", content: "提取丹药信息" }],
      tools: [
        {
          type: "function",
          function: {
            name: "record_pill",
            parameters: { type: "object" }
          }
        }
      ]
    });

    expect(result.content).toBe("丹药摘要");
    expect(result.usage).toEqual({ total_tokens: 12 });
    expect(credentials.resolveApiKey).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not call fetch when the API key reference is missing", async () => {
    const provider = { ...createProvider(), apiKeyRef: undefined };
    const fetchMock = vi.fn();
    const client = new OpenAiCompatibleClient(
      provider,
      { resolveApiKey: vi.fn() },
      { fetch: fetchMock as unknown as typeof fetch }
    );

    await expect(
      client.chatCompletion({
        providerId: "deepseek-user",
        modelId: "novel-analysis",
        messages: [{ role: "user", content: "hello" }]
      })
    ).rejects.toThrow(/API key reference/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects provider mismatches before resolving credentials or fetching", async () => {
    const credentials: CredentialStore = { resolveApiKey: vi.fn() };
    const fetchMock = vi.fn();
    const client = new OpenAiCompatibleClient(createProvider(), credentials, {
      fetch: fetchMock as unknown as typeof fetch
    });

    await expect(
      client.chatCompletion({
        providerId: "other-provider",
        modelId: "novel-analysis",
        messages: [{ role: "user", content: "hello" }]
      })
    ).rejects.toThrow("Request provider other-provider does not match client provider deepseek-user");
    expect(credentials.resolveApiKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts domain credential stores directly and rejects null API keys", async () => {
    const domainCredentials: DomainCredentialStore = {
      saveApiKey: vi.fn(async () => undefined),
      resolveApiKey: vi.fn(async () => null)
    };
    const credentials: CredentialStore = domainCredentials;
    const fetchMock = vi.fn();
    const client = new OpenAiCompatibleClient(createProvider(), credentials, {
      fetch: fetchMock as unknown as typeof fetch
    });

    await expect(
      client.chatCompletion({
        providerId: "deepseek-user",
        modelId: "novel-analysis",
        messages: [{ role: "user", content: "hello" }]
      })
    ).rejects.toThrow(/API key is not available/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redacts secrets from HTTP error messages", async () => {
    const apiKey = "sk-" + "http-secret";
    const credentials: CredentialStore = {
      resolveApiKey: async () => apiKey
    };
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            message: `upstream rejected Bearer ${apiKey}`
          }
        }),
        { status: 401, statusText: "Unauthorized" }
      );
    });
    const client = new OpenAiCompatibleClient(createProvider(), credentials, { fetch: fetchMock });

    await expect(
      client.chatCompletion({
        providerId: "deepseek-user",
        modelId: "novel-analysis",
        messages: [{ role: "user", content: "hello" }]
      })
    ).rejects.toThrow(/sk-\*\*\*/);
    await expect(
      client.chatCompletion({
        providerId: "deepseek-user",
        modelId: "novel-analysis",
        messages: [{ role: "user", content: "hello" }]
      })
    ).rejects.not.toThrow(apiKey);
  });

  it("redacts secrets from fetch failures and connection tests", async () => {
    const apiKey = "sk-" + "network-secret";
    const client = new OpenAiCompatibleClient(
      createProvider(),
      { resolveApiKey: async () => apiKey },
      {
        fetch: vi.fn(async () => {
          throw new Error(`socket closed for Bearer ${apiKey}`);
        })
      }
    );

    await expect(
      client.chatCompletion({
        providerId: "deepseek-user",
        modelId: "novel-analysis",
        messages: [{ role: "user", content: "hello" }]
      })
    ).rejects.not.toThrow(apiKey);

    const connection = await client.testConnection({
      providerId: "deepseek-user",
      modelId: "novel-analysis",
      messages: [{ role: "user", content: "hello" }]
    });

    expect(connection).toEqual({ ok: false, error: "socket closed for Bearer sk-***" });
  });

  it("redacts secrets from response body read failures", async () => {
    const apiKey = "plain" + "secret12345";
    const client = new OpenAiCompatibleClient(
      createProvider(),
      { resolveApiKey: async () => apiKey },
      {
        fetch: vi.fn(async () => {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            text: async () => {
              throw new Error(`failed to read response for api key ${apiKey}`);
            }
          } as unknown as Response;
        })
      }
    );

    let thrown: unknown;
    try {
      await client.chatCompletion({
        providerId: "deepseek-user",
        modelId: "novel-analysis",
        messages: [{ role: "user", content: "hello" }]
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toBe("failed to read response for api key ***");
    expect(message).not.toContain(apiKey);
  });

  it("redacts secrets from successful connection test raw responses", async () => {
    const apiKey = "sk-" + "success-secret";
    const client = new OpenAiCompatibleClient(
      createProvider(),
      { resolveApiKey: async () => apiKey },
      {
        fetch: vi.fn(async () => {
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: "ok" } }],
              echo: { apiKey, Authorization: `Bearer ${apiKey}` }
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        })
      }
    );

    const connection = await client.testConnection({
      providerId: "deepseek-user",
      modelId: "novel-analysis",
      messages: [{ role: "user", content: "hello" }]
    });

    expect(connection).toEqual({
      ok: true,
      raw: {
        choices: [{ message: { content: "ok" } }],
        echo: { apiKey: "***", Authorization: "Bearer sk-***" }
      }
    });
    expect(JSON.stringify(connection.raw)).not.toContain(apiKey);
  });

  it("redacts non-sk bearer tokens from successful connection test raw responses", async () => {
    const apiKey = "plain" + "secret12345";
    const client = new OpenAiCompatibleClient(
      createProvider(),
      { resolveApiKey: async () => apiKey },
      {
        fetch: vi.fn(async () => {
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: "ok" } }],
              echo: { apiKey, Authorization: `Bearer ${apiKey}` },
              nested: [`Bearer ${apiKey}`]
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        })
      }
    );

    const connection = await client.testConnection({
      providerId: "deepseek-user",
      modelId: "novel-analysis",
      messages: [{ role: "user", content: "hello" }]
    });

    expect(connection).toEqual({
      ok: true,
      raw: {
        choices: [{ message: { content: "ok" } }],
        echo: { apiKey: "***", Authorization: "Bearer ***" },
        nested: ["Bearer ***"]
      }
    });
    expect(JSON.stringify(connection)).not.toContain(apiKey);
  });

  it("redacts non-sk bearer tokens from HTTP error text in connection tests", async () => {
    const apiKey = "plain" + "secret12345";
    const client = new OpenAiCompatibleClient(
      createProvider(),
      { resolveApiKey: async () => apiKey },
      {
        fetch: vi.fn(async () => {
          return new Response(`upstream rejected Bearer ${apiKey}`, {
            status: 401,
            statusText: "Unauthorized"
          });
        })
      }
    );

    const connection = await client.testConnection({
      providerId: "deepseek-user",
      modelId: "novel-analysis",
      messages: [{ role: "user", content: "hello" }]
    });

    expect(connection).toEqual({
      ok: false,
      error: "OpenAI-compatible request failed with HTTP 401 Unauthorized: upstream rejected Bearer ***"
    });
    expect(JSON.stringify(connection)).not.toContain(apiKey);
  });

  it("redacts known non-sk API keys from HTTP error text in connection tests", async () => {
    const apiKey = "plain" + "secret12345";
    const client = new OpenAiCompatibleClient(
      createProvider(),
      { resolveApiKey: async () => apiKey },
      {
        fetch: vi.fn(async () => {
          return new Response(`upstream rejected api key ${apiKey}`, {
            status: 401,
            statusText: "Unauthorized"
          });
        })
      }
    );

    const connection = await client.testConnection({
      providerId: "deepseek-user",
      modelId: "novel-analysis",
      messages: [{ role: "user", content: "hello" }]
    });

    expect(connection).toEqual({
      ok: false,
      error: "OpenAI-compatible request failed with HTTP 401 Unauthorized: upstream rejected api key ***"
    });
    expect(JSON.stringify(connection)).not.toContain(apiKey);
  });

  it("redacts known non-sk API keys from HTTP error JSON messages", async () => {
    const apiKey = "plain" + "secret12345";
    const client = new OpenAiCompatibleClient(
      createProvider(),
      { resolveApiKey: async () => apiKey },
      {
        fetch: vi.fn(async () => {
          return new Response(
            JSON.stringify({
              error: {
                message: `upstream rejected api key ${apiKey}`
              }
            }),
            { status: 401, statusText: "Unauthorized" }
          );
        })
      }
    );

    let thrown: unknown;
    try {
      await client.chatCompletion({
        providerId: "deepseek-user",
        modelId: "novel-analysis",
        messages: [{ role: "user", content: "hello" }]
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("upstream rejected api key ***");
    expect(message).not.toContain(apiKey);
  });

  it("redacts credential store errors before throwing from chat completion", async () => {
    const apiKey = "sk-" + "credential" + "-throw-secret";
    const fetchMock = vi.fn();
    const client = new OpenAiCompatibleClient(
      createProvider(),
      {
        resolveApiKey: vi.fn(async () => {
          throw new Error(`credential store leaked Bearer ${apiKey}`);
        })
      },
      { fetch: fetchMock as unknown as typeof fetch }
    );

    let thrown: unknown;
    try {
      await client.chatCompletion({
        providerId: "deepseek-user",
        modelId: "novel-analysis",
        messages: [{ role: "user", content: "hello" }]
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toBe("credential store leaked Bearer sk-***");
    expect(message).not.toContain(apiKey);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redacts non-sk credential store errors before an API key resolves", async () => {
    const apiKey = "plain" + "secret12345";
    const client = new OpenAiCompatibleClient(
      createProvider(),
      {
        resolveApiKey: vi.fn(async () => {
          throw new Error(`credential store leaked api key ${apiKey}`);
        })
      },
      { fetch: vi.fn() as unknown as typeof fetch }
    );

    let thrown: unknown;
    try {
      await client.chatCompletion({
        providerId: "deepseek-user",
        modelId: "novel-analysis",
        messages: [{ role: "user", content: "hello" }]
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toBe("credential store leaked api key ***");
    expect(message).not.toContain(apiKey);

    const connection = await client.testConnection({
      providerId: "deepseek-user",
      modelId: "novel-analysis",
      messages: [{ role: "user", content: "hello" }]
    });

    expect(connection).toEqual({ ok: false, error: "credential store leaked api key ***" });
    expect(JSON.stringify(connection)).not.toContain(apiKey);
  });
});
