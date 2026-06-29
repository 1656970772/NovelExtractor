import { describe, expectTypeOf, it } from "vitest";
import type { ProviderKind, ProviderPresetId } from "@novel-extractor/config";
import type { ProviderConfig } from "./provider";

describe("provider domain", () => {
  it("uses provider kinds and preset ids from config boundaries", () => {
    expectTypeOf<ProviderConfig["kind"]>().toEqualTypeOf<ProviderKind>();
    expectTypeOf<ProviderConfig["presetId"]>().toEqualTypeOf<ProviderPresetId>();
  });

  it("rejects provider preset ids outside the configured P0 set", () => {
    const provider = {
      id: "provider-1",
      presetId: "deepseek",
      displayName: "DeepSeek",
      kind: "openai-compatible",
      models: [],
      enabled: true
    } satisfies ProviderConfig;

    expectTypeOf(provider.presetId).toEqualTypeOf<"deepseek">();

    // @ts-expect-error P0 presets are limited by @novel-extractor/config.
    const invalidPresetId: ProviderConfig["presetId"] = "unknown";

    void invalidPresetId;
  });
});
