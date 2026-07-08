import { describe, expect, it, vi } from "vitest";
import type { CredentialStore as DomainCredentialStore } from "@novel-extractor/domain";
import {
  OpenAiCompatibleClient,
  OpenAiCompatibleRequestError,
  type CredentialStore,
  type FetchLike
} from "./openAiCompatibleClient";
import type { OpenAiCompatibleProviderDefinition } from "./providerRegistry";

function createProvider(): OpenAiCompatibleProviderDefinition {
  return {
    id: "deepseek-user",
    presetId: "deepseek",
    displayName: "DeepSeek 用户配置",
    kind: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    authScheme: "bearer",
    apiFormat: "openai_chat",
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

function createResponsesProvider(): OpenAiCompatibleProviderDefinition {
  return {
    id: "minimax-user",
    presetId: "minimax",
    displayName: "MiniMax",
    kind: "openai-compatible",
    baseUrl: "https://api.minimaxi.com/v1",
    authScheme: "bearer",
    apiFormat: "openai_responses",
    apiKeyRef: { id: "key-1", providerConfigId: "minimax-user" },
    allowsUserModels: false,
    models: []
  };
}

function createAnthropicProvider(): OpenAiCompatibleProviderDefinition {
  return {
    ...createProvider(),
    id: "anthropic-native",
    presetId: "anthropic",
    displayName: "Anthropic Native",
    baseUrl: "https://api.anthropic.com/v1",
    authScheme: "anthropic-api-key",
    apiFormat: "anthropic_messages",
    apiKeyRef: { id: "key-1", providerConfigId: "anthropic-native" },
    models: []
  };
}

function createBedrockProvider(): OpenAiCompatibleProviderDefinition {
  return {
    ...createProvider(),
    id: "bedrock-native",
    presetId: "bedrock",
    displayName: "Bedrock Converse",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    authScheme: "aws-sigv4",
    apiFormat: "bedrock_converse",
    apiKeyRef: { id: "key-1", providerConfigId: "bedrock-native" },
    models: []
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
              description: "记录丹药信息。",
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
          name: "record_pill",
          description: "记录丹药信息。",
          inputSchema: { type: "object" }
        }
      ]
    });

    expect(result.content).toBe("丹药摘要");
    expect(result.usage).toEqual({ total_tokens: 12 });
    expect(credentials.resolveApiKey).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("exposes the prepared provider-native request body before sending", async () => {
    const snapshots: unknown[] = [];
    const events: string[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      events.push("fetch");
      expect(snapshots).toHaveLength(1);
      expect(JSON.parse(String(init?.body))).toEqual((snapshots[0] as { body: unknown }).body);

      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    const client = new OpenAiCompatibleClient(
      createProvider(),
      { resolveApiKey: async () => "sk-prepared-secret" },
      { fetch: fetchMock }
    );

    const result = await client.chatCompletion({
      providerId: "deepseek-user",
      modelId: "novel-analysis",
      messages: [{ role: "user", content: "提取丹药信息" }],
      tools: [
        {
          name: "record_pill",
          description: "记录丹药信息。",
          inputSchema: { type: "object" }
        }
      ],
      onRequestPrepared: (snapshot) => {
        events.push("prepared");
        snapshots.push(snapshot);
      }
    });

    expect(events).toEqual(["prepared", "fetch"]);
    expect(snapshots).toEqual([
      {
        apiFormat: "openai_chat",
        url: "https://api.deepseek.com/chat/completions",
        body: {
          model: "novel-analysis",
          messages: [{ role: "user", content: "提取丹药信息" }],
          tools: [
            {
              type: "function",
              function: {
                name: "record_pill",
                description: "记录丹药信息。",
                parameters: { type: "object" }
              }
            }
          ]
        }
      }
    ]);
    expect(result.requestApiFormat).toBe("openai_chat");
    expect(result.requestBody).toEqual((snapshots[0] as { body: unknown }).body);
  });

  it("isolates prepared request snapshots from the body sent to fetch", async () => {
    let actualBody: unknown;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      actualBody = JSON.parse(String(init?.body));

      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    const client = new OpenAiCompatibleClient(
      createProvider(),
      { resolveApiKey: async () => "sk-prepared-secret" },
      { fetch: fetchMock }
    );

    const result = await client.chatCompletion({
      providerId: "deepseek-user",
      modelId: "novel-analysis",
      messages: [{ role: "user", content: "提取丹药信息" }],
      onRequestPrepared: (snapshot) => {
        const body = snapshot.body as {
          model: string;
          messages: Array<{ role: string; content: string }>;
        };
        body.model = "mutated-by-callback";
        body.messages = [{ role: "user", content: "tampered prompt" }];
      }
    });

    expect(actualBody).toEqual({
      model: "novel-analysis",
      messages: [{ role: "user", content: "提取丹药信息" }]
    });
    expect(result.requestBody).toEqual(actualBody);
  });

  it("keeps raw usage and normalizes OpenAI-compatible token details", async () => {
    const usage = {
      prompt_tokens: 100,
      completion_tokens: 40,
      total_tokens: 140,
      prompt_tokens_details: { cached_tokens: 25 },
      completion_tokens_details: { reasoning_tokens: 7 }
    };
    const client = new OpenAiCompatibleClient(
      createProvider(),
      { resolveApiKey: async () => "sk-usage-secret" },
      {
        fetch: vi.fn(async () => {
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: "丹药摘要" } }],
              usage
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        })
      }
    );

    const result = await client.chatCompletion({
      providerId: "deepseek-user",
      modelId: "novel-analysis",
      messages: [{ role: "user", content: "提取丹药信息" }]
    });

    expect(result.usage).toEqual(usage);
    expect(result).toMatchObject({
      normalizedUsage: {
        requestCount: 1,
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
        cacheHitTokens: 25,
        cacheMissTokens: 75,
        reasoningTokens: 7
      }
    });
  });

  it("normalizes prompt_cache_hit_tokens usage fields", async () => {
    const client = new OpenAiCompatibleClient(
      createProvider(),
      { resolveApiKey: async () => "sk-cache-secret" },
      {
        fetch: vi.fn(async () => {
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: "ok" } }],
              usage: {
                prompt_tokens: 16,
                completion_tokens: 3,
                total_tokens: 19,
                prompt_cache_hit_tokens: 20,
                reasoning_tokens: 2
              }
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        })
      }
    );

    const result = await client.chatCompletion({
      providerId: "deepseek-user",
      modelId: "novel-analysis",
      messages: [{ role: "user", content: "hello" }]
    });

    expect(result).toMatchObject({
      normalizedUsage: {
        requestCount: 1,
        inputTokens: 16,
        outputTokens: 3,
        totalTokens: 19,
        cacheHitTokens: 20,
        cacheMissTokens: 0,
        reasoningTokens: 2
      }
    });
  });

  it("keeps zero usage override values instead of falling back to detail fields", async () => {
    const usage = {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_cache_hit_tokens: 0,
      prompt_tokens_details: { cached_tokens: 25 },
      completion_tokens_details: { reasoning_tokens: 0 },
      reasoning_tokens: 8
    };
    const client = new OpenAiCompatibleClient(
      createProvider(),
      { resolveApiKey: async () => "sk-zero-usage-secret" },
      {
        fetch: vi.fn(async () => {
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: "ok" } }],
              usage
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        })
      }
    );

    const result = await client.chatCompletion({
      providerId: "deepseek-user",
      modelId: "novel-analysis",
      messages: [{ role: "user", content: "hello" }]
    });

    expect(result).toMatchObject({
      normalizedUsage: {
        requestCount: 1,
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 110,
        cacheHitTokens: 0,
        cacheMissTokens: 100,
        reasoningTokens: 0
      }
    });
  });

  it("parses OpenAI-compatible tool calls and JSON function arguments", async () => {
    const client = new OpenAiCompatibleClient(
      createProvider(),
      { resolveApiKey: async () => "sk-tool-secret" },
      {
        fetch: vi.fn(async () => {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: "call-1",
                        type: "function",
                        function: {
                          name: "record_pill",
                          arguments: "{\"name\":\"筑基丹\",\"rank\":2}"
                        }
                      }
                    ]
                  }
                }
              ]
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        })
      }
    );

    const result = await client.chatCompletion({
      providerId: "deepseek-user",
      modelId: "novel-analysis",
      messages: [{ role: "user", content: "提取丹药信息" }]
    });

    expect(result.content).toBe("");
    expect(result).toMatchObject({
      toolCalls: [
        {
          id: "call-1",
          name: "record_pill",
          arguments: { name: "筑基丹", rank: 2 }
        }
      ]
    });
  });

  it("skips malformed tool calls and only keeps explicit function calls with names", async () => {
    const client = new OpenAiCompatibleClient(
      createProvider(),
      { resolveApiKey: async () => "sk-malformed-tool-secret" },
      {
        fetch: vi.fn(async () => {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      "not-an-object",
                      {
                        id: "call-missing-name",
                        type: "function",
                        function: {
                          arguments: "{\"name\":\"无名丹\"}"
                        }
                      },
                      {
                        id: "call-not-function",
                        type: "not_function",
                        function: {
                          name: "record_invalid",
                          arguments: "{\"ignored\":true}"
                        }
                      },
                      {
                        id: "call-missing-type",
                        function: {
                          name: "record_missing_type",
                          arguments: "{\"ignored\":true}"
                        }
                      },
                      {
                        id: "call-valid",
                        type: "function",
                        function: {
                          name: "record_pill",
                          arguments: "{\"name\":\"筑基丹\"}"
                        }
                      }
                    ]
                  }
                }
              ]
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        })
      }
    );

    const result = await client.chatCompletion({
      providerId: "deepseek-user",
      modelId: "novel-analysis",
      messages: [{ role: "user", content: "提取丹药信息" }]
    });

    expect(result.toolCalls).toEqual([
      {
        id: "call-valid",
        name: "record_pill",
        arguments: { name: "筑基丹" }
      }
    ]);
  });

  it("keeps tool call arguments as strings when they are not valid JSON", async () => {
    const client = new OpenAiCompatibleClient(
      createProvider(),
      { resolveApiKey: async () => "sk-invalid-tool-secret" },
      {
        fetch: vi.fn(async () => {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: "需要工具",
                    tool_calls: [
                      {
                        id: "call-bad-json",
                        type: "function",
                        function: {
                          name: "record_pill",
                          arguments: "{not-json"
                        }
                      }
                    ]
                  }
                }
              ]
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        })
      }
    );

    const result = await client.chatCompletion({
      providerId: "deepseek-user",
      modelId: "novel-analysis",
      messages: [{ role: "user", content: "提取丹药信息" }]
    });

    expect(result).toMatchObject({
      toolCalls: [
        {
          id: "call-bad-json",
          name: "record_pill",
          arguments: "{not-json"
        }
      ]
    });
  });

  it("recovers tool call arguments prefixed by an empty object", async () => {
    const client = new OpenAiCompatibleClient(
      createProvider(),
      { resolveApiKey: async () => "sk-prefixed-tool-secret" },
      {
        fetch: vi.fn(async () => {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: "call-prefixed-json",
                        type: "function",
                        function: {
                          name: "write_file",
                          arguments: "{}{\"path\":\"[报告]NPC性格与代表事件.md\",\"content\":\"# NPC性格与代表事件\"}"
                        }
                      }
                    ]
                  }
                }
              ]
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        })
      }
    );

    const result = await client.chatCompletion({
      providerId: "deepseek-user",
      modelId: "novel-analysis",
      messages: [{ role: "user", content: "提取NPC信息" }]
    });

    expect(result.toolCalls).toEqual([
      {
        id: "call-prefixed-json",
        name: "write_file",
        arguments: {
          path: "[报告]NPC性格与代表事件.md",
          content: "# NPC性格与代表事件"
        }
      }
    ]);
  });

  it("serializes assistant tool calls and tool result messages in OpenAI-compatible request bodies", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "novel-analysis",
        messages: [
          { role: "user", content: "提取丹药信息" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-record-pill",
                type: "function",
                function: {
                  name: "record_pill",
                  arguments: "{\"name\":\"筑基丹\",\"rank\":2}"
                }
              }
            ]
          },
          {
            role: "tool",
            tool_call_id: "call-record-pill",
            name: "record_pill",
            content: "{\"ok\":true}"
          }
        ]
      });

      return new Response(JSON.stringify({ choices: [{ message: { content: "继续" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    const client = new OpenAiCompatibleClient(
      createProvider(),
      { resolveApiKey: async () => "sk-serialize-tool-secret" },
      { fetch: fetchMock }
    );

    await client.chatCompletion({
      providerId: "deepseek-user",
      modelId: "novel-analysis",
      messages: [
        { role: "user", content: "提取丹药信息" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-record-pill",
              name: "record_pill",
              arguments: { rank: 2, name: "筑基丹" }
            }
          ]
        },
        {
          role: "tool",
          toolCallId: "call-record-pill",
          name: "record_pill",
          content: "{\"ok\":true}"
        }
      ]
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps string tool call arguments unchanged when serializing request bodies", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.messages[1].tool_calls[0].function.arguments).toBe("{\"already\":\"json\"}");

      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    const client = new OpenAiCompatibleClient(
      createProvider(),
      { resolveApiKey: async () => "sk-string-arguments-secret" },
      { fetch: fetchMock }
    );

    await client.chatCompletion({
      providerId: "deepseek-user",
      modelId: "novel-analysis",
      messages: [
        { role: "user", content: "提取丹药信息" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-string-args",
              name: "record_pill",
              arguments: "{\"already\":\"json\"}"
            }
          ]
        }
      ]
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses /responses for cc-switch native Responses presets", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetcher: FetchLike = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "完成" }]
            },
            {
              type: "function_call",
              call_id: "call-write",
              name: "write_file",
              arguments: "{\"path\":\"丹药分析.md\",\"content\":\"# 丹药分析\"}"
            }
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15
          }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const client = new OpenAiCompatibleClient(
      createResponsesProvider(),
      { resolveApiKey: async () => "test-minimax-api-key" },
      { fetch: fetcher }
    );

    const result = await client.chatCompletion({
      providerId: "minimax-user",
      modelId: "MiniMax-M3",
      messages: [{ role: "user", content: "提取窗口 1" }],
      tools: [
        {
          name: "write_file",
          description: "写入报告文件。",
          inputSchema: { type: "object" }
        }
      ]
    });

    expect(calls[0].url).toBe("https://api.minimaxi.com/v1/responses");
    expect(calls[0].body).toMatchObject({
      model: "MiniMax-M3",
      input: [{ role: "user", content: "提取窗口 1" }],
      tools: [
        {
          type: "function",
          name: "write_file",
          description: "写入报告文件。",
          parameters: { type: "object" },
          strict: false
        }
      ]
    });
    expect(result.content).toBe("完成");
    expect(result.normalizedUsage).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15
    });
    expect(result.toolCalls).toEqual([
      {
        id: "call-write",
        name: "write_file",
        arguments: { path: "丹药分析.md", content: "# 丹药分析" }
      }
    ]);
  });

  it("serializes Responses function-call history for tool follow-up rounds", async () => {
    const fetcher: FetchLike = async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "MiniMax-M3",
        input: [
          { role: "user", content: "提取窗口 1" },
          {
            type: "function_call",
            call_id: "call-write",
            name: "write_file",
            arguments: "{\"content\":\"# 丹药分析\",\"path\":\"丹药分析.md\"}"
          },
          {
            type: "function_call_output",
            call_id: "call-write",
            output: "{\"ok\":true}"
          }
        ]
      });
      return new Response(JSON.stringify({ output_text: "继续" }), { status: 200 });
    };

    const client = new OpenAiCompatibleClient(
      createResponsesProvider(),
      { resolveApiKey: async () => "test-minimax-api-key" },
      { fetch: fetcher }
    );

    await client.chatCompletion({
      providerId: "minimax-user",
      modelId: "MiniMax-M3",
      messages: [
        { role: "user", content: "提取窗口 1" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-write",
              name: "write_file",
              arguments: { path: "丹药分析.md", content: "# 丹药分析" }
            }
          ]
        },
        {
          role: "tool",
          toolCallId: "call-write",
          name: "write_file",
          content: "{\"ok\":true}"
        }
      ]
    });
  });

  it("sends Anthropic native tools through the protocol adapter", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const client = new OpenAiCompatibleClient(
      createAnthropicProvider(),
      { resolveApiKey: async () => "sk-ant-test" },
      {
        fetch: vi.fn(async (url, init) => {
          calls.push({
            url: String(url),
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
            body: JSON.parse(String(init?.body)),
          });

          return new Response(JSON.stringify({ content: [{ type: "text", text: "完成" }] }), { status: 200 });
        }),
      },
    );

    const result = await client.chatCompletion({
      providerId: "anthropic-native",
      modelId: "claude-test",
      providerOptions: { max_tokens: 2048 },
      messages: [
        { role: "system", content: "你是小说资料抽取助手" },
        { role: "user", content: "处理窗口" },
      ],
      tools: [
        {
          name: "read_report_excerpt",
          description: "读取本批允许报告中的卡片字段块。",
          inputSchema: {
            type: "object",
            properties: { queries: { type: "array", items: { type: "object" } } },
            required: ["queries"],
          },
        },
      ],
    });

    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].headers["x-api-key"]).toBe("sk-ant-test");
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[0].body).toMatchObject({
      model: "claude-test",
      max_tokens: 2048,
      system: "你是小说资料抽取助手",
      messages: [{ role: "user", content: [{ type: "text", text: "处理窗口" }] }],
      tools: [
        {
          name: "read_report_excerpt",
          description: "读取本批允许报告中的卡片字段块。",
          input_schema: {
            properties: {
              queries: { type: "array", items: { type: "object" } },
            },
          },
        },
      ],
    });
    expect(result.content).toBe("完成");
  });

  it("blocks Bedrock Converse until SigV4 signing is implemented", async () => {
    const credentials: CredentialStore = { resolveApiKey: vi.fn(async () => "aws-secret") };
    const fetchMock = vi.fn();
    const client = new OpenAiCompatibleClient(createBedrockProvider(), credentials, {
      fetch: fetchMock as unknown as typeof fetch,
    });
    const request = {
      providerId: "bedrock-native",
      modelId: "anthropic.claude-test",
      messages: [{ role: "user" as const, content: "hello" }],
    };

    await expect(client.chatCompletion(request)).rejects.toThrow(/SigV4 signing/);
    const connection = await client.testConnection(request);

    expect(connection).toEqual({
      ok: false,
      error: "Bedrock Converse requires AWS SigV4 signing before native Bedrock requests can be sent.",
    });
    expect(credentials.resolveApiKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
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

  it("throws structured HTTP request errors with redacted details", async () => {
    const apiKey = "sk-" + "http-structured-secret";
    const statusText = `Too Many Requests Bearer ${apiKey}`;
    const client = new OpenAiCompatibleClient(
      createProvider(),
      { resolveApiKey: async () => apiKey },
      {
        fetch: vi.fn(async () => {
          return new Response(
            JSON.stringify({
              error: {
                message: `rate limit for Bearer ${apiKey}`
              }
            }),
            { status: 429, statusText }
          );
        }),
        retry: { maxAttempts: 1 }
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

    expect(thrown).toBeInstanceOf(OpenAiCompatibleRequestError);
    expect(thrown).toMatchObject({
      kind: "http",
      details: {
        status: 429,
        statusText: "Too Many Requests Bearer sk-***",
        body: {
          error: {
            message: "rate limit for Bearer sk-***"
          }
        }
      }
    });
    expect((thrown as Error).message).toContain("HTTP 429 Too Many Requests Bearer sk-***");
    expect((thrown as OpenAiCompatibleRequestError).details.statusText).not.toContain(apiKey);
    expect(JSON.stringify(thrown)).not.toContain(apiKey);
    expect((thrown as Error).message).not.toContain(apiKey);
  });

  it("throws structured network request errors after fetch failures", async () => {
    const client = new OpenAiCompatibleClient(
      createProvider(),
      { resolveApiKey: async () => "sk-timeout-secret" },
      {
        fetch: vi.fn(async () => {
          throw new Error("ETIMEDOUT");
        }),
        retry: { maxAttempts: 1 }
      }
    );

    await expect(
      client.chatCompletion({
        providerId: "deepseek-user",
        modelId: "novel-analysis",
        messages: [{ role: "user", content: "hello" }]
      })
    ).rejects.toMatchObject({
      kind: "network",
      details: {
        body: "ETIMEDOUT"
      }
    });
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

  it("retries terminated fetch failures with default retry options before returning a chat completion", async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("terminated");
      }

      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "重试后完成" } }],
          usage: { total_tokens: 9 }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    const client = new OpenAiCompatibleClient(
      createProvider(),
      { resolveApiKey: async () => "sk-retry-secret" },
      { fetch: fetchMock }
    );

    const result = await client.chatCompletion({
      providerId: "deepseek-user",
      modelId: "novel-analysis",
      messages: [{ role: "user", content: "hello" }]
    });

    expect(result.content).toBe("重试后完成");
    expect(result.usage).toEqual({ total_tokens: 9 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries terminated response body read failures before returning a chat completion", async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => {
            throw new Error("terminated");
          }
        } as unknown as Response;
      }

      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "正文读取重试后完成" } }],
          usage: { total_tokens: 11 }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    const client = new OpenAiCompatibleClient(
      createProvider(),
      { resolveApiKey: async () => "sk-retry-body-secret" },
      {
        fetch: fetchMock,
        retry: { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0 }
      }
    );

    const result = await client.chatCompletion({
      providerId: "deepseek-user",
      modelId: "novel-analysis",
      messages: [{ role: "user", content: "hello" }]
    });

    expect(result.content).toBe("正文读取重试后完成");
    expect(result.usage).toEqual({ total_tokens: 11 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("redacts secrets from response body read failures", async () => {
    const apiKey = "plain" + "secret12345";
    const statusText = `OK Bearer ${apiKey}`;
    const client = new OpenAiCompatibleClient(
      createProvider(),
      { resolveApiKey: async () => apiKey },
      {
        fetch: vi.fn(async () => {
          return {
            ok: true,
            status: 200,
            statusText,
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
    expect(thrown).toMatchObject({
      kind: "response_body",
      details: {
        status: 200,
        statusText: "OK Bearer ***",
        body: "failed to read response for api key ***"
      }
    });
    expect(JSON.stringify(thrown)).not.toContain(apiKey);
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
