import { describe, expect, it } from "vitest";
import { anthropicMessagesAdapter } from "./anthropicMessages";

describe("anthropicMessagesAdapter", () => {
  it("lowers system messages and tools to Anthropic Messages body shape", () => {
    const body = anthropicMessagesAdapter.buildBody({
      modelId: "claude-test",
      messages: [
        { role: "system", content: "你是小说资料抽取助手" },
        { role: "system", content: "只输出必要的工具调用" },
        { role: "user", content: "处理当前窗口" },
      ],
      providerOptions: {},
      tools: [
        {
          name: "read_report_excerpt",
          description: "读取本批允许报告中的卡片字段块。",
          inputSchema: {
            type: "object",
            properties: {
              queries: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    cardName: { type: "string" },
                    fields: {
                      type: "array",
                      items: { type: "string" },
                    },
                  },
                  required: ["cardName", "fields"],
                  additionalProperties: false,
                },
              },
            },
            required: ["queries"],
            additionalProperties: false,
          },
        },
      ],
    });

    expect(body).toEqual({
      model: "claude-test",
      system: "你是小说资料抽取助手\n\n只输出必要的工具调用",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "处理当前窗口" }],
        },
      ],
      tools: [
        {
          name: "read_report_excerpt",
          description: "读取本批允许报告中的卡片字段块。",
          input_schema: {
            type: "object",
            properties: {
              queries: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    cardName: { type: "string" },
                    fields: {
                      type: "array",
                      items: { type: "string" },
                    },
                  },
                  required: ["cardName", "fields"],
                  additionalProperties: false,
                },
              },
            },
            required: ["queries"],
            additionalProperties: false,
          },
        },
      ],
    });
  });

  it("replays assistant tool_use blocks and tool_result history", () => {
    const body = anthropicMessagesAdapter.buildBody({
      modelId: "claude-test",
      providerOptions: {},
      tools: [],
      messages: [
        {
          role: "assistant",
          content: "需要读取已有报告。",
          toolCalls: [
            {
              id: "toolu-1",
              name: "read_report_excerpt",
              arguments: {
                queries: [{ cardName: "韩立", fields: ["核心性格"] }],
              },
            },
            {
              id: "toolu-2",
              name: "raw_args",
              arguments: "{\"already\":\"json\"}",
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "toolu-1",
          name: "read_report_excerpt",
          content: "### 韩立\n\n- 核心性格：谨慎。",
        },
      ],
    });

    expect(body).toEqual({
      model: "claude-test",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "需要读取已有报告。" },
            {
              type: "tool_use",
              id: "toolu-1",
              name: "read_report_excerpt",
              input: {
                queries: [{ cardName: "韩立", fields: ["核心性格"] }],
              },
            },
            {
              type: "tool_use",
              id: "toolu-2",
              name: "raw_args",
              input: "{\"already\":\"json\"}",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu-1",
              content: "### 韩立\n\n- 核心性格：谨慎。",
            },
          ],
        },
      ],
    });
  });

  it("parses text and tool_use blocks from Anthropic responses", () => {
    const parsed = anthropicMessagesAdapter.parseResponse({
      content: [
        { type: "text", text: "需要更新" },
        { type: "text", text: "报告。" },
        {
          type: "tool_use",
          id: "toolu-1",
          name: "upsert_report_section",
          input: {
            outputFileName: "[报告]NPC性格与代表事件.md",
            updates: [
              {
                cardName: "韩立",
                fieldName: "核心性格",
                content: "谨慎但会冒险。",
              },
            ],
          },
        },
        { type: "tool_use", id: "ignored-empty-name", name: "", input: {} },
      ],
      usage: { input_tokens: 10, output_tokens: 4 },
    });

    expect(parsed).toEqual({
      content: "需要更新报告。",
      usage: { input_tokens: 10, output_tokens: 4 },
      toolCalls: [
        {
          id: "toolu-1",
          name: "upsert_report_section",
          arguments: {
            outputFileName: "[报告]NPC性格与代表事件.md",
            updates: [
              {
                cardName: "韩立",
                fieldName: "核心性格",
                content: "谨慎但会冒险。",
              },
            ],
          },
        },
      ],
    });
  });
});
