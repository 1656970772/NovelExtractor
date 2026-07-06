import { describe, expect, it } from "vitest";
import { bedrockConverseAdapter } from "./bedrockConverse";

describe("bedrockConverseAdapter", () => {
  it("builds the model-specific Converse path", () => {
    expect(
      bedrockConverseAdapter.path({
        baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        modelId: "anthropic.claude 3/sonnet",
      }),
    ).toBe("/model/anthropic.claude%203%2Fsonnet/converse");
  });

  it("lowers system messages and tools to Bedrock toolSpec inputSchema.json", () => {
    const body = bedrockConverseAdapter.buildBody({
      modelId: "anthropic.claude-test",
      messages: [
        { role: "system", content: "你是小说资料抽取助手" },
        { role: "user", content: "处理窗口" },
      ],
      providerOptions: {},
      tools: [
        {
          name: "multi_edit",
          description: "Apply a list of edits to a single file atomically.",
          inputSchema: {
            type: "object",
            properties: {
              edits: { type: "array", items: { type: "object" } },
            },
            required: ["path", "edits"],
          },
        },
      ],
    });

    expect(body).toEqual({
      modelId: "anthropic.claude-test",
      system: [{ text: "你是小说资料抽取助手" }],
      messages: [{ role: "user", content: [{ text: "处理窗口" }] }],
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: "multi_edit",
              description: "Apply a list of edits to a single file atomically.",
              inputSchema: {
                json: {
                  type: "object",
                  properties: {
                    edits: { type: "array", items: { type: "object" } },
                  },
                  required: ["path", "edits"],
                },
              },
            },
          },
        ],
      },
    });
  });

  it("replays assistant toolUse blocks and toolResult history", () => {
    const body = bedrockConverseAdapter.buildBody({
      modelId: "anthropic.claude-test",
      messages: [
        {
          role: "assistant",
          content: "需要工具",
          toolCalls: [
            {
              id: "bedrock-tool-1",
              name: "multi_edit",
              arguments: {
                path: "a.md",
                edits: [{ old_string: "旧", new_string: "新" }],
              },
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "bedrock-tool-1",
          name: "multi_edit",
          content: "ok",
        },
      ],
      providerOptions: {},
      tools: [],
    });

    expect(body).toEqual({
      modelId: "anthropic.claude-test",
      messages: [
        {
          role: "assistant",
          content: [
            { text: "需要工具" },
            {
              toolUse: {
                toolUseId: "bedrock-tool-1",
                name: "multi_edit",
                input: {
                  path: "a.md",
                  edits: [{ old_string: "旧", new_string: "新" }],
                },
              },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              toolResult: {
                toolUseId: "bedrock-tool-1",
                content: [{ text: "ok" }],
              },
            },
          ],
        },
      ],
    });
  });

  it("parses Bedrock text and toolUse blocks", () => {
    const parsed = bedrockConverseAdapter.parseResponse({
      output: {
        message: {
          content: [
            { text: "需要编辑" },
            {
              toolUse: {
                toolUseId: "bedrock-tool-1",
                name: "multi_edit",
                input: { path: "a.md", edits: [{ old_string: "旧", new_string: "新" }] },
              },
            },
            { text: "继续" },
          ],
        },
      },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });

    expect(parsed).toEqual({
      content: "需要编辑继续",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      toolCalls: [
        {
          id: "bedrock-tool-1",
          name: "multi_edit",
          arguments: { path: "a.md", edits: [{ old_string: "旧", new_string: "新" }] },
        },
      ],
    });
  });
});
