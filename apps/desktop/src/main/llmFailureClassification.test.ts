import { describe, expect, it } from "vitest";
import type { LlmFailurePolicyDefaults } from "@novel-extractor/config";
import { OpenAiCompatibleRequestError } from "@novel-extractor/llm";
import { classifyLlmFailure } from "./llmFailureClassification";

const defaults: LlmFailurePolicyDefaults = {
  switchableHttpStatuses: [429],
  switchableMessageFragments: ["rate limit", "额度不足"],
  switchableNetworkErrorFragments: ["ETIMEDOUT"],
  maxAutoFallbackRoundsPerWindow: 2
};

describe("classifyLlmFailure", () => {
  it("marks configured HTTP statuses as switchable and retryable", () => {
    const error = new OpenAiCompatibleRequestError("HTTP 429 rate limit", "http", {
      status: 429,
      statusText: "Too Many Requests",
      body: { error: { message: "rate limit" } }
    });

    expect(classifyLlmFailure(error, defaults)).toEqual({
      switchable: true,
      retryable: true,
      reason: "http_status",
      detail: "429"
    });
  });

  it("marks HTTP body message fragments as switchable when status is not configured", () => {
    const error = new OpenAiCompatibleRequestError("HTTP 402 Payment Required", "http", {
      status: 402,
      statusText: "Payment Required",
      body: { error: { message: "额度不足，请充值" } }
    });

    expect(classifyLlmFailure(error, defaults)).toEqual({
      switchable: true,
      retryable: true,
      reason: "message_fragment",
      detail: "额度不足"
    });
  });

  it("marks configured network fragments as switchable", () => {
    const error = new OpenAiCompatibleRequestError("ETIMEDOUT", "network", {
      body: "ETIMEDOUT"
    });

    expect(classifyLlmFailure(error, defaults)).toEqual({
      switchable: true,
      retryable: true,
      reason: "network_fragment",
      detail: "ETIMEDOUT"
    });
  });

  it("does not classify network errors by HTTP message fragments", () => {
    const error = new OpenAiCompatibleRequestError("rate limit from proxy", "network", {
      body: "rate limit from proxy"
    });

    expect(classifyLlmFailure(error, defaults)).toEqual({
      switchable: false,
      retryable: false,
      reason: "network_fragment"
    });
  });

  it("does not classify ordinary errors as switchable LLM request failures", () => {
    expect(classifyLlmFailure(new Error("tool schema invalid"), defaults)).toEqual({
      switchable: false,
      retryable: false,
      reason: "not_llm_request_error"
    });
  });
});
