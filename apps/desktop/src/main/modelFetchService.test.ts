import { describe, expect, it, vi } from "vitest";
import {
  buildModelListUrlCandidates,
  fetchModelsFromProvider,
  parseFetchedModels
} from "./modelFetchService";

describe("model fetch service", () => {
  it("builds model list URL candidates from provider base URLs", () => {
    expect(
      buildModelListUrlCandidates({ baseUrl: "https://api.example.com/v1" })
    ).toEqual(["https://api.example.com/v1/models"]);

    expect(
      buildModelListUrlCandidates({ baseUrl: "https://open.bigmodel.cn/api/paas" })
    ).toEqual([
      "https://open.bigmodel.cn/api/paas/v1/models"
    ]);

    expect(
      buildModelListUrlCandidates({ baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" })
    ).toEqual([
      "https://open.bigmodel.cn/api/coding/paas/v4/models",
      "https://open.bigmodel.cn/api/coding/paas/v4/v1/models"
    ]);

    expect(
      buildModelListUrlCandidates({ baseUrl: "https://api.deepseek.com/anthropic" })
    ).toEqual([
      "https://api.deepseek.com/anthropic/v1/models",
      "https://api.deepseek.com/v1/models",
      "https://api.deepseek.com/models"
    ]);

    expect(
      buildModelListUrlCandidates({
        baseUrl: "https://api.example.com/v1",
        modelsUrl: "https://models.example.com/list"
      })
    ).toEqual(["https://models.example.com/list"]);
  });

  it("builds model list URL candidates from full API URLs and compatibility suffixes", () => {
    expect(
      buildModelListUrlCandidates({
        baseUrl: "https://api.example.com/v1/chat/completions",
        isFullUrl: true
      })
    ).toEqual(["https://api.example.com/v1/models"]);

    expect(
      buildModelListUrlCandidates({
        baseUrl: "https://host.example.com/api/coding"
      })
    ).toEqual([
      "https://host.example.com/api/coding/v1/models",
      "https://host.example.com/v1/models",
      "https://host.example.com/models"
    ]);

    expect(
      buildModelListUrlCandidates({
        baseUrl: "https://host.example.com/api/anthropic"
      })
    ).toEqual([
      "https://host.example.com/api/anthropic/v1/models",
      "https://host.example.com/v1/models",
      "https://host.example.com/models"
    ]);

    expect(
      buildModelListUrlCandidates({
        baseUrl: "https://host.example.com/claude"
      })
    ).toEqual([
      "https://host.example.com/claude/v1/models",
      "https://host.example.com/v1/models",
      "https://host.example.com/models"
    ]);
  });

  it("parses OpenAI model list responses and sorts models by id", () => {
    expect(
      parseFetchedModels({
        data: [
          { id: "z-model", owned_by: "provider-b" },
          { id: "a-model", owned_by: "provider-a" }
        ]
      })
    ).toEqual([
      { id: "a-model", ownedBy: "provider-a" },
      { id: "z-model", ownedBy: "provider-b" }
    ]);
  });

  it("falls back on 404 or 405 responses and sends bearer auth with optional user agent", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("not found with sk-secret", { status: 404 }))
      .mockResolvedValueOnce(new Response("method denied", { status: 405 }))
      .mockResolvedValueOnce(
        Response.json({
          data: [{ id: "deepseek-v4-pro", owned_by: "deepseek" }]
        })
      );

    await expect(
      fetchModelsFromProvider({
        baseUrl: "https://api.deepseek.com/anthropic",
        apiKey: "sk-secret",
        userAgent: "NovelExtractor/0.0.0",
        fetch
      })
    ).resolves.toEqual([{ id: "deepseek-v4-pro", ownedBy: "deepseek" }]);

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      "https://api.deepseek.com/anthropic/v1/models",
      "https://api.deepseek.com/v1/models",
      "https://api.deepseek.com/models"
    ]);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        Authorization: "Bearer sk-secret",
        "User-Agent": "NovelExtractor/0.0.0"
      }
    });
  });

  it("redacts API keys from failed HTTP responses", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response("invalid sk-secret token", {
        status: 500,
        statusText: "Internal Server Error"
      })
    );

    let error: unknown;
    try {
      await fetchModelsFromProvider({
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-secret",
        fetch
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("HTTP 500 Internal Server Error");
    expect((error as Error).message).not.toContain("sk-secret");
  });

  it("keeps sanitized HTTP details when all fallback candidates fail", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response("bad sk-secret", {
        status: 404
      })
    );

    let error: unknown;
    try {
      await fetchModelsFromProvider({
        baseUrl: "https://api.example.com/v1",
        modelsUrl: "https://api.example.com/v1/models",
        apiKey: "sk-secret",
        fetch
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("HTTP 404");
    expect((error as Error).message).toContain("[REDACTED]");
    expect((error as Error).message).not.toContain("sk-secret");
  });
});
