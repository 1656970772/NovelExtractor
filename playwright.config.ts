import { defineConfig } from "@playwright/test";
import path from "node:path";

const workspaceRoot = process.cwd();

export default defineConfig({
  testDir: path.join(workspaceRoot, "e2e"),
  timeout: 120_000,
  expect: {
    timeout: 15_000
  },
  workers: 1,
  reporter: [["list"]],
  globalSetup: path.join(workspaceRoot, "e2e", "globalSetup.ts")
});
