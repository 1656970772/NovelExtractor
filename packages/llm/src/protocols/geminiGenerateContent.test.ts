import { describe, expect, it } from "vitest";
import { geminiGenerateContentAdapter } from "./geminiGenerateContent";

describe("geminiGenerateContentAdapter", () => {
  it("uses the Gemini GenerateContent api format and model path", () => {
    expect(geminiGenerateContentAdapter.apiFormat).toBe("gemini_generate_content");
    expect(geminiGenerateContentAdapter.path({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      modelId: "publishers/google/models/gemini test",
    })).toBe("/models/publishers%2Fgoogle%2Fmodels%2Fgemini%20test:generateContent");
  });

  it("lowers system messages and function tools to Gemini GenerateContent body", () => {
    const body = geminiGenerateContentAdapter.buildBody({
      modelId: "gemini-test",
      messages: [
        { role: "system", content: "你是小说资料抽取助手" },
        { role: "system", content: "只返回必要工具调用" },
        { role: "user", content: "处理窗口" },
      ],
      providerOptions: {},
      tools: [
        {
          name: "wait",
          description: "Block until background jobs finish.",
          inputSchema: {
            type: "object",
            properties: {
              job_ids: { type: "array", items: { type: "string" } },
            },
            required: ["job_ids"],
            additionalProperties: false,
          },
        },
      ],
    });

    expect(body).toEqual({
      systemInstruction: {
        parts: [{ text: "你是小说资料抽取助手\n\n只返回必要工具调用" }],
      },
      contents: [{ role: "user", parts: [{ text: "处理窗口" }] }],
      tools: [
        {
          functionDeclarations: [
            {
              name: "wait",
              description: "Block until background jobs finish.",
              parameters: {
                type: "object",
                properties: {
                  job_ids: { type: "array", items: { type: "string" } },
                },
                required: ["job_ids"],
              },
            },
          ],
        },
      ],
    });
  });

  it("parses text, usageMetadata, and functionCall parts from the first candidate", () => {
    const parsed = geminiGenerateContentAdapter.parseResponse({
      candidates: [
        {
          content: {
            parts: [
              { text: "调用" },
              {
                functionCall: {
                  name: "wait",
                  args: { job_ids: ["bash-1"], timeout_seconds: 10 },
                },
              },
              { text: "工具" },
              {
                functionCall: {
                  name: "mark_no_update",
                  args: { outputFileName: "[报告]NPC.md", reason: "本窗口无新增信息" },
                },
              },
            ],
          },
        },
        {
          content: {
            parts: [
              { text: "ignored" },
              { functionCall: { name: "ignored", args: {} } },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 },
    });

    expect(parsed).toEqual({
      content: "调用工具",
      usage: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 },
      toolCalls: [
        {
          id: "gemini-call-1",
          name: "wait",
          arguments: { job_ids: ["bash-1"], timeout_seconds: 10 },
        },
        {
          id: "gemini-call-2",
          name: "mark_no_update",
          arguments: { outputFileName: "[报告]NPC.md", reason: "本窗口无新增信息" },
        },
      ],
    });
  });

  it("preserves provider functionCall ids when parsing Gemini tool calls", () => {
    const parsed = geminiGenerateContentAdapter.parseResponse({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  id: "provider-call-7",
                  name: "wait",
                  args: { job_ids: ["a"] },
                },
              },
            ],
          },
        },
      ],
    });

    expect(parsed.toolCalls).toEqual([
      {
        id: "provider-call-7",
        name: "wait",
        arguments: { job_ids: ["a"] },
      },
    ]);
  });

  it("replays Gemini tool messages with their provider functionCall id", () => {
    const body = geminiGenerateContentAdapter.buildBody({
      modelId: "gemini-test",
      providerOptions: {},
      tools: [],
      messages: [
        {
          role: "tool",
          toolCallId: "provider-call-7",
          name: "wait",
          content: "done",
        },
      ],
    });

    expect(body).toEqual({
      contents: [
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: "provider-call-7",
                name: "wait",
                response: {
                  name: "wait",
                  content: "done",
                },
              },
            },
          ],
        },
      ],
    });
  });

  it("replays assistant tool calls and tool messages in Gemini history shape", () => {
    const body = geminiGenerateContentAdapter.buildBody({
      modelId: "gemini-test",
      providerOptions: {},
      tools: [],
      messages: [
        {
          role: "assistant",
          content: "Thinking.",
          toolCalls: [
            {
              id: "call-1",
              name: "wait",
              arguments: { job_ids: ["bash-1"] },
            },
            {
              id: "call-2",
              name: "mark_no_update",
              arguments: { outputFileName: "[报告]NPC.md", reason: "本窗口无新增信息" },
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call-1",
          name: "wait",
          content: "background jobs finished",
        },
      ],
    });

    expect(body).toEqual({
      contents: [
        {
          role: "model",
          parts: [
            { text: "Thinking." },
            { functionCall: { id: "call-1", name: "wait", args: { job_ids: ["bash-1"] } } },
            {
              functionCall: {
                id: "call-2",
                name: "mark_no_update",
                args: { outputFileName: "[报告]NPC.md", reason: "本窗口无新增信息" },
              },
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: "call-1",
                name: "wait",
                response: {
                  name: "wait",
                  content: "background jobs finished",
                },
              },
            },
          ],
        },
      ],
    });
  });
});
