import { describe, expect, it } from "vitest";
import { resolveBuildInfo } from "./buildInfo";

describe("build info", () => {
  it("uses runtime app version before injected and environment fallbacks", () => {
    expect(
      resolveBuildInfo({
        appVersion: "runtime-version",
        env: {
          NOVEL_EXTRACTOR_APP_VERSION: "env-version",
          NOVEL_EXTRACTOR_BUILD_COMMIT: "env-commit",
          NOVEL_EXTRACTOR_BUILD_TIME: "env-time"
        },
        injected: {
          appVersion: "injected-version",
          commit: "injected-commit",
          time: "injected-time"
        }
      })
    ).toEqual({
      appVersion: "runtime-version",
      commit: "injected-commit",
      time: "injected-time"
    });
  });

  it("uses runtime app version before env and falls back to unknown without blocking dev and test", () => {
    expect(
      resolveBuildInfo({
        appVersion: "runtime-version",
        env: {
          NOVEL_EXTRACTOR_APP_VERSION: "env-version",
          NOVEL_EXTRACTOR_BUILD_COMMIT: "env-commit",
          NOVEL_EXTRACTOR_BUILD_TIME: "env-time"
        },
        injected: {}
      })
    ).toEqual({
      appVersion: "runtime-version",
      commit: "env-commit",
      time: "env-time"
    });

    expect(resolveBuildInfo({ env: {}, injected: {} })).toEqual({
      appVersion: "unknown",
      commit: "unknown",
      time: "unknown"
    });
  });
});
