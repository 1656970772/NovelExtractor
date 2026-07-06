import { describe, expect, it } from "vitest";
import { getProtocolAdapter } from "./index";

describe("getProtocolAdapter", () => {
  it.each([
    ["openai_chat", "/chat/completions"],
    ["openai_responses", "/responses"],
    ["anthropic_messages", "/messages"],
  ] as const)("resolves %s", (apiFormat, expectedPath) => {
    expect(getProtocolAdapter(apiFormat).path({ baseUrl: "https://api.example.com", modelId: "m" })).toBe(
      expectedPath,
    );
  });

  it("resolves Gemini model-specific path", () => {
    expect(
      getProtocolAdapter("gemini_generate_content").path({
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        modelId: "gemini-2.5-pro",
      }),
    ).toBe("/models/gemini-2.5-pro:generateContent");
  });

  it("resolves Bedrock Converse model-specific path", () => {
    expect(
      getProtocolAdapter("bedrock_converse").path({
        baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        modelId: "anthropic.claude-test",
      }),
    ).toBe("/model/anthropic.claude-test/converse");
  });
});
