import { describe, expect, it } from "vitest";
import { openAiResponsesAdapter } from "./openaiResponses";

describe("openAiResponsesAdapter", () => {
  it("builds OpenAI Responses function tools with flat projected nested parameters", () => {
    const body = openAiResponsesAdapter.buildBody({
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
      input: [{ role: "user", content: "Extract facts." }],
      tools: [
        {
          type: "function",
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
          strict: false,
        },
      ],
    });
  });

  it("parses OpenAI Responses function_call output items into tool calls", () => {
    const parsed = openAiResponsesAdapter.parseResponse({
      output_text: "I need a tool.",
      output: [
        {
          type: "function_call",
          call_id: "call-1",
          name: "write_file",
          arguments: "{\"path\":\"notes.md\",\"tags\":[\"a\",\"b\"]}",
        },
        {
          type: "message",
          content: [{ type: "output_text", text: "ignored for tool calls" }],
        },
        {
          type: "function_call",
          call_id: "ignored-empty-name",
          name: "",
          arguments: "{}",
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });

    expect(parsed).toEqual({
      content: "I need a tool.",
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      toolCalls: [
        {
          id: "call-1",
          name: "write_file",
          arguments: { path: "notes.md", tags: ["a", "b"] },
        },
      ],
    });
  });

  it("replays assistant tool calls and tool messages in OpenAI Responses history shape", () => {
    const body = openAiResponsesAdapter.buildBody({
      modelId: "gpt-4.1-mini",
      tools: [],
      providerOptions: {},
      messages: [
        {
          role: "assistant",
          content: "Thinking.",
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
      input: [
        {
          role: "assistant",
          content: "Thinking.",
        },
        {
          type: "function_call",
          call_id: "call-1",
          name: "write_file",
          arguments: "{\"a\":[\"keep\",{\"b\":true}],\"z\":1}",
        },
        {
          type: "function_call",
          call_id: "call-2",
          name: "raw_args",
          arguments: "{\"already\":\"json\"}",
        },
        {
          type: "function_call_output",
          call_id: "call-1",
          output: "ok",
        },
      ],
    });
  });

  it("falls back to aggregated output content text when output_text is missing", () => {
    const parsed = openAiResponsesAdapter.parseResponse({
      output: [
        {
          type: "message",
          content: [
            { type: "output_text", text: "first " },
            { type: "refusal", text: "still text" },
          ],
        },
        {
          type: "message",
          content: [{ type: "output_text", text: "second" }],
        },
      ],
    });

    expect(parsed).toEqual({
      content: "first still textsecond",
      usage: undefined,
      toolCalls: [],
    });
  });
});
