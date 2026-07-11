import type { LlmFailurePolicyDefaults } from "@novel-extractor/config";
import { OpenAiCompatibleRequestError } from "@novel-extractor/llm";
import { describe, expect, it } from "vitest";
import {
  classifyLlmFailure,
  isNonRetryableContextLimitFailure
} from "./llmFailureClassification";

const defaults: LlmFailurePolicyDefaults = {
  nonRetryableContextLimitFragments: [
    "context_length_exceeded",
    "maximum context length",
    "上下文长度超限"
  ],
  switchableHttpStatuses: [429],
  switchableMessageFragments: ["rate limit", "额度不足"],
  switchableNetworkErrorFragments: ["ETIMEDOUT"],
  maxAutoFallbackRoundsPerWindow: 2
};

describe("isNonRetryableContextLimitFailure", () => {
  it("recognizes configured context limit fragments in structured provider errors", () => {
    const error = new OpenAiCompatibleRequestError("HTTP 400 Bad Request", "http", {
      status: 400,
      body: {
        error: {
          code: "context_length_exceeded",
          message: "This model's maximum context length is 128000 tokens"
        }
      }
    });

    expect(isNonRetryableContextLimitFailure(error, defaults)).toBe(true);
  });

  it("keeps other parameter errors retryable by the window request loop", () => {
    const error = new OpenAiCompatibleRequestError("HTTP 400 Bad Request", "http", {
      status: 400,
      body: { error: { code: "invalid_parameter", message: "temperature must be between 0 and 2" } }
    });

    expect(isNonRetryableContextLimitFailure(error, defaults)).toBe(false);
  });
});

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

  it("does not treat echoed HTTP body fragments as switchable provider errors", () => {
    const error = new OpenAiCompatibleRequestError("HTTP 500 Internal Server Error", "http", {
      status: 500,
      statusText: "Internal Server Error",
      body: { echo: "用户正文提到了 rate limit，但不是供应商错误" }
    });

    expect(classifyLlmFailure(error, defaults)).toEqual({
      switchable: false,
      retryable: false,
      reason: "message_fragment"
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
