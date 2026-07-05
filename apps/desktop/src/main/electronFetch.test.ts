import { describe, expect, it, vi } from "vitest";
import { createElectronFetch } from "./electronFetch";

describe("electron fetch adapter", () => {
  it("delegates requests to Electron net.fetch so desktop HTTP calls use Chromium networking", async () => {
    const response = new Response("ok");
    const source = {
      fetch: vi.fn(async () => response)
    };
    const desktopFetch = createElectronFetch(source);

    await expect(
      desktopFetch("https://api.example.com/v1/models", {
        headers: { Authorization: "Bearer test-key" }
      })
    ).resolves.toBe(response);

    expect(source.fetch).toHaveBeenCalledWith("https://api.example.com/v1/models", {
      headers: { Authorization: "Bearer test-key" }
    });
  });
});
