import { describe, expect, it, vi } from "vitest";
import { getDefaultConfig } from "@novel-extractor/config";
import type { ApiKeyRef } from "@novel-extractor/domain";
import { OpenAiCompatibleRequestError } from "@novel-extractor/llm";
import { createMiniMaxTokenPlanWaitGate } from "./minimaxTokenPlanWaitGate";

const apiKeyRef: ApiKeyRef = {
  id: "api-key-1",
  providerConfigId: "provider-minimax"
};

const context = {
  apiKeyRef,
  baseUrl: "https://api.minimaxi.com/v1",
  modelId: "MiniMax-M3",
  presetId: "minimax",
  providerConfigId: "provider-minimax"
};

function tokenPlanLimitError(): OpenAiCompatibleRequestError {
  return new OpenAiCompatibleRequestError(
    "HTTP 500 Internal Server Error: 已达到 Token Plan 用量上限",
    "http",
    {
      status: 500,
      body: { error: { message: "已达到 Token Plan 用量上限" } }
    }
  );
}

describe("createMiniMaxTokenPlanWaitGate", () => {
  it("queries the official quota endpoint and waits for the matching text window", async () => {
    const now = Date.UTC(2026, 6, 12, 0, 0, 0);
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          base_resp: { status_code: 0, status_msg: "success" },
          model_remains: [
            {
              model_name: "video",
              remains_time: 12 * 60 * 60 * 1000,
              current_interval_status: 2,
              current_interval_total_count: 3,
              current_interval_usage_count: 3
            },
            {
              model_name: "general",
              remains_time: 3 * 60 * 60 * 1000 + 16 * 60 * 1000,
              current_interval_status: 2,
              current_interval_total_count: 0,
              current_interval_usage_count: 0,
              current_interval_remaining_percent: 0
            }
          ]
        }),
        { headers: { "Content-Type": "application/json" }, status: 200 }
      )
    );
    const defaults = getDefaultConfig().minimaxTokenPlanWaitDefaults;
    const gate = createMiniMaxTokenPlanWaitGate({
      defaults,
      fetch,
      now: () => now,
      resolveApiKey: () => "sk-test-secret"
    });

    const delayMs = await gate.recordFailure(context, tokenPlanLimitError());

    expect(delayMs).toBe(3 * 60 * 60 * 1000 + 16 * 60 * 1000 + defaults.retrySafetyBufferMs);
    expect(gate.getRemainingDelayMs(context)).toBe(delayMs);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.minimaxi.com/v1/token_plan/remains");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer sk-test-secret");
  });

  it("deduplicates concurrent quota probes and shares the resulting wait", async () => {
    let releaseResponse: (() => void) | undefined;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          releaseResponse = () =>
            resolve(
              new Response(
                JSON.stringify({
                  model_remains: [
                    {
                      model_name: "MiniMax-M*",
                      remains_time: 60_000,
                      current_interval_total_count: 1500,
                      current_interval_usage_count: 1500
                    }
                  ]
                }),
                { headers: { "Content-Type": "application/json" }, status: 200 }
              )
            );
        })
    );
    const gate = createMiniMaxTokenPlanWaitGate({
      defaults: getDefaultConfig().minimaxTokenPlanWaitDefaults,
      fetch,
      now: () => 1_000,
      resolveApiKey: () => "sk-test-secret"
    });

    const first = gate.recordFailure(context, tokenPlanLimitError());
    const second = gate.recordFailure(context, tokenPlanLimitError());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    releaseResponse?.();

    await expect(Promise.all([first, second])).resolves.toEqual([90_000, 90_000]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not probe quota for unrelated provider failures", async () => {
    const fetch = vi.fn();
    const gate = createMiniMaxTokenPlanWaitGate({
      defaults: getDefaultConfig().minimaxTokenPlanWaitDefaults,
      fetch,
      resolveApiKey: () => "sk-test-secret"
    });
    const error = new OpenAiCompatibleRequestError("temporary provider failure", "http", {
      status: 500
    });

    await expect(gate.recordFailure(context, error)).resolves.toBeUndefined();
    await expect(
      gate.recordFailure({ ...context, presetId: "custom-openai-compatible" }, tokenPlanLimitError())
    ).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});
