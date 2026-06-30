import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileDesktopSettingsStore } from "./desktopSettings";

describe("desktop settings store", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-settings-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it("uses the default project storage directory until the user saves an override", async () => {
    const defaultProjectStorageDirectory = path.join(tempRoot, "default-projects");
    const customProjectStorageDirectory = path.join(tempRoot, "custom-projects");
    const store = createFileDesktopSettingsStore({
      filePath: path.join(tempRoot, "settings.json"),
      defaultProjectStorageDirectory
    });

    await expect(store.getSettings()).resolves.toEqual({
      defaultProjectStorageDirectory,
      effectiveProjectStorageDirectory: defaultProjectStorageDirectory,
      projectStorageDirectory: undefined
    });

    await expect(
      store.saveSettings({ projectStorageDirectory: customProjectStorageDirectory })
    ).resolves.toEqual({
      defaultProjectStorageDirectory,
      effectiveProjectStorageDirectory: customProjectStorageDirectory,
      projectStorageDirectory: customProjectStorageDirectory
    });
    await expect(fs.stat(customProjectStorageDirectory)).resolves.toMatchObject({
      isDirectory: expect.any(Function)
    });

    await expect(store.saveSettings({ projectStorageDirectory: "   " })).resolves.toEqual({
      defaultProjectStorageDirectory,
      effectiveProjectStorageDirectory: defaultProjectStorageDirectory,
      projectStorageDirectory: undefined
    });
  });
});
