import { describe, expect, it } from "vitest";
import "./types";
import { parseProtocolToolArguments } from "./shared";
import type { LlmProtocolAdapter, ParsedProtocolResponse } from "./types";

type Assert<T extends true> = T;
type IsOptional<T, K extends keyof T> = Record<string, never> extends Pick<T, K> ? true : false;
type UsageMustBeRequired = Assert<IsOptional<ParsedProtocolResponse, "usage"> extends false ? true : false>;

describe("LlmProtocolAdapter contract", () => {
  it("allows adapters to compile provider-native request bodies and parse tool calls", () => {
    const adapter: LlmProtocolAdapter = {
      apiFormat: "openai_chat",
      path: () => "/chat/completions",
      buildBody: () => ({ model: "m", messages: [], tools: [] }),
      parseResponse: () => ({
        content: "",
        usage: undefined,
        toolCalls: [{ id: "call-1", name: "write_file", arguments: { path: "a.md" } }]
      })
    };

    const body: Record<string, unknown> = adapter.buildBody({
      modelId: "m",
      messages: [],
      tools: [],
      providerOptions: {}
    });

    expect(adapter.path({ baseUrl: "https://api.example.com", modelId: "m" })).toBe("/chat/completions");
    expect(body).toEqual({ model: "m", messages: [], tools: [] });
    expect(adapter.parseResponse({}).toolCalls[0].arguments).toEqual({ path: "a.md" });
  });
});

describe("parseProtocolToolArguments", () => {
  it("returns invalid JSON strings unchanged", () => {
    expect(parseProtocolToolArguments("{not-json")).toBe("{not-json");
  });

  it("recovers JSON object arguments prefixed with an empty object", () => {
    expect(parseProtocolToolArguments('{}{"path":"a.md"}')).toEqual({ path: "a.md" });
  });
});
