import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderConfig } from "@novel-extractor/domain";
import { createFileProviderStore } from "./providerStore";

describe("file provider store", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-providers-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it("persists provider configs across store instances", async () => {
    const filePath = path.join(tempRoot, "providers.json");
    const providerConfig: ProviderConfig = {
      id: "provider-1",
      presetId: "deepseek",
      displayName: "DeepSeek",
      kind: "openai-compatible",
      baseUrl: "https://api.deepseek.com",
      models: [
        {
          id: "deepseek-chat",
          displayName: "deepseek-chat",
          enabled: true,
          isDefault: true
        }
      ],
      enabled: true,
      apiKeyRef: {
        id: "api-key-1",
        providerConfigId: "provider-1"
      }
    };

    const store = createFileProviderStore({ filePath });
    await store.saveProviderConfig(providerConfig);

    const reopenedStore = createFileProviderStore({ filePath });
    await expect(reopenedStore.listProviderConfigs()).resolves.toEqual([providerConfig]);
  });
});
