import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileProjectStore } from "./projectStore";

describe("file project store", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-project-store-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it("creates new projects under the currently configured project storage directory", async () => {
    const defaultProjectsRoot = path.join(tempRoot, "default-projects");
    const customProjectsRoot = path.join(tempRoot, "custom-projects");
    let currentProjectsRoot = defaultProjectsRoot;
    const projectStore = createFileProjectStore({
      workspaceRoot: tempRoot,
      projectsRoot: () => currentProjectsRoot,
      clock: { now: () => "2026-06-30T00:00:00.000Z" },
      idGenerator: createSequentialIdGenerator()
    });

    const firstProject = await projectStore.createProject({ displayName: "凡人资料" });
    currentProjectsRoot = customProjectsRoot;
    const secondProject = await projectStore.createProject({ displayName: "网文资料" });

    expect(firstProject.rootPath).toMatch(defaultProjectsRoot);
    expect(secondProject.rootPath).toMatch(customProjectsRoot);
    await expect(fs.stat(firstProject.rootPath)).resolves.toMatchObject({
      isDirectory: expect.any(Function)
    });
    await expect(fs.stat(secondProject.rootPath)).resolves.toMatchObject({
      isDirectory: expect.any(Function)
    });
  });
});

function createSequentialIdGenerator() {
  let nextValue = 0;

  return {
    createId(prefix = "id") {
      nextValue += 1;
      return `${prefix}-${nextValue}`;
    }
  };
}
