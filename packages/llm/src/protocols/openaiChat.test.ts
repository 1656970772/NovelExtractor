import { describe, expect, it } from "vitest";
import { openAiChatAdapter } from "./openaiChat";

describe("openAiChatAdapter", () => {
  it("builds OpenAI Chat function tools with projected nested parameters", () => {
    const body = openAiChatAdapter.buildBody({
      modelId: "gpt-4.1-mini",
      messages: [{ role: "user", content: "Extract facts." }],
      providerOptions: {},
      tools: [
        {
          name: "extract_cards",
          description: "Extract structured cards.",
          inputSchema: {
            type: "object",
            properties: {
              outputFileName: { type: "string" },
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
            required: ["outputFileName", "queries"],
            additionalProperties: false,
          },
        },
      ],
    });

    expect(body).toEqual({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: "Extract facts." }],
      tools: [
        {
          type: "function",
          function: {
            name: "extract_cards",
            description: "Extract structured cards.",
            parameters: {
              type: "object",
              properties: {
                outputFileName: { type: "string" },
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
              required: ["outputFileName", "queries"],
              additionalProperties: false,
            },
          },
        },
      ],
    });
  });

  it("parses OpenAI Chat function tool call arguments from response JSON strings", () => {
    const parsed = openAiChatAdapter.parseResponse({
      choices: [
        {
          message: {
            content: "I need a tool.",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: "{\"path\":\"notes.md\",\"tags\":[\"a\",\"b\"]}",
                },
              },
              {
                id: "ignored-non-function",
                type: "custom",
                function: {
                  name: "skip_me",
                  arguments: "{}",
                },
              },
              {
                id: "ignored-empty-name",
                type: "function",
                function: {
                  name: "",
                  arguments: "{}",
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    expect(parsed).toEqual({
      content: "I need a tool.",
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      toolCalls: [
        {
          id: "call-1",
          name: "write_file",
          arguments: { path: "notes.md", tags: ["a", "b"] },
        },
      ],
    });
  });

  it("replays assistant tool calls and tool messages in OpenAI Chat history shape", () => {
    const body = openAiChatAdapter.buildBody({
      modelId: "gpt-4.1-mini",
      tools: [],
      providerOptions: {},
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-1",
              name: "write_file",
              arguments: { z: 1, a: ["keep", { b: true }] },
            },
            {
              id: "call-2",
              name: "raw_args",
              arguments: "{\"already\":\"json\"}",
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call-1",
          name: "write_file",
          content: "ok",
        },
      ],
    });

    expect(body).toEqual({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "write_file",
                arguments: "{\"a\":[\"keep\",{\"b\":true}],\"z\":1}",
              },
            },
            {
              id: "call-2",
              type: "function",
              function: {
                name: "raw_args",
                arguments: "{\"already\":\"json\"}",
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call-1",
          name: "write_file",
          content: "ok",
        },
      ],
    });
  });
});
