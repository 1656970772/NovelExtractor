import { describe, expect, it } from "vitest";
import { classifyLlmFailure } from "./llmFailureClassification";

describe("classifyLlmFailure", () => {
  it("does not treat echoed user body fragments as switchable HTTP errors", () => {
    const classification = classifyLlmFailure(
      new Error(
        'OpenAI-compatible request failed with HTTP 500 Internal Server Error: {"echo":"用户正文提到了 rate limit，但不是供应商错误"}'
      )
    );

    expect(classification.switchable).toBe(false);
  });

  it("treats HTTP error.message quota fragments as switchable", () => {
    const classification = classifyLlmFailure(
      new Error(
        'OpenAI-compatible request failed with HTTP 400 Bad Request: {"error":{"message":"额度不足，请充值后重试"}}'
      )
    );

    expect(classification.switchable).toBe(true);
  });
});
