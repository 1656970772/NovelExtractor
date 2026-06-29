import { describe, expect, it } from "vitest";
import { getDefaultConfig } from "./defaults";
import { ConfigInvariantError, assertValidConfigInvariants } from "./configInvariants";
import type { NovelExtractorConfig } from "./schema";

function expectInvariantViolation(config: NovelExtractorConfig, messagePattern: RegExp): void {
  expect(() => assertValidConfigInvariants(config)).toThrow(ConfigInvariantError);
  expect(() => assertValidConfigInvariants(config)).toThrow(messagePattern);
}

describe("config invariants", () => {
  it("accepts the default config", () => {
    expect(() => assertValidConfigInvariants(getDefaultConfig())).not.toThrow();
  });

  it("requires provider ids to be unique", () => {
    const config = getDefaultConfig();
    config.providerPresets.push({ ...config.providerPresets[0] });

    expectInvariantViolation(config, /provider preset id/i);
  });

  it("requires model ids to be non-empty", () => {
    const config = getDefaultConfig();
    config.providerPresets[0].models[0].id = " ";

    expectInvariantViolation(config, /model id/i);
  });

  it("requires template names and default output file names to be non-empty", () => {
    const missingName = getDefaultConfig();
    missingName.builtInTemplates[0].name = "";
    expectInvariantViolation(missingName, /template name/i);

    const missingOutputFile = getDefaultConfig();
    missingOutputFile.builtInTemplates[0].defaultOutputFileName = " ";
    expectInvariantViolation(missingOutputFile, /default output file name/i);
  });

  it("requires menu item ids to be unique across menus", () => {
    const config = getDefaultConfig();
    config.menu.userMenu.push({ ...config.menu.mainNavigation[0] });

    expectInvariantViolation(config, /menu item id/i);
  });

  it("requires task actions to be allowed by schema", () => {
    const config = getDefaultConfig();
    (config.taskStatus.pending.allowedActions as string[]).push("archive");

    expectInvariantViolation(config, /task action/i);
  });
});
