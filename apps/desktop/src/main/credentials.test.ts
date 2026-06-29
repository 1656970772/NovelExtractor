import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileCredentialStore } from "./credentials";

describe("file credential store", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-credentials-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it("persists API keys across store instances without exposing the value in refs", () => {
    const filePath = path.join(tempRoot, "api-keys.json");
    const store = createFileCredentialStore({
      filePath,
      idFactory: () => "api-key-1"
    });

    const ref = store.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-local-persist"
    });

    const reopenedStore = createFileCredentialStore({ filePath });
    expect(ref).toEqual({ id: "api-key-1", providerConfigId: "provider-1" });
    expect(JSON.stringify(ref)).not.toContain("sk-local-persist");
    expect(reopenedStore.hasApiKey(ref)).toBe(true);
    expect(reopenedStore.readApiKey(ref)).toBe("sk-local-persist");
  });

  it("uses the configured secret codec before writing API keys to disk", async () => {
    const filePath = path.join(tempRoot, "encoded-api-keys.json");
    const store = createFileCredentialStore({
      filePath,
      idFactory: () => "api-key-encoded",
      encodeSecret: (apiKey) => Buffer.from(apiKey, "utf8").toString("base64"),
      decodeSecret: (encodedApiKey) => Buffer.from(encodedApiKey, "base64").toString("utf8")
    });

    const ref = store.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-encoded-persist"
    });
    const rawFile = await fs.readFile(filePath, "utf8");
    const reopenedStore = createFileCredentialStore({
      filePath,
      decodeSecret: (encodedApiKey) => Buffer.from(encodedApiKey, "base64").toString("utf8")
    });

    expect(rawFile).not.toContain("sk-encoded-persist");
    expect(reopenedStore.readApiKey(ref)).toBe("sk-encoded-persist");
  });
});
