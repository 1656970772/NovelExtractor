import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      name: "desktop",
      root: "apps/desktop",
      include: ["src/**/*.test.{ts,tsx}"],
      environment: "node"
    }
  },
  {
    test: {
      name: "config",
      root: "packages/config",
      include: ["src/**/*.test.ts"],
      environment: "node"
    }
  },
  {
    test: {
      name: "domain",
      root: "packages/domain",
      include: ["src/**/*.test.ts"],
      environment: "node"
    }
  },
  {
    test: {
      name: "persistence",
      root: "packages/persistence",
      include: ["src/**/*.test.ts"],
      environment: "node"
    }
  },
  {
    test: {
      name: "extraction",
      root: "packages/extraction",
      include: ["src/**/*.test.ts"],
      environment: "node"
    }
  },
  {
    test: {
      name: "llm",
      root: "packages/llm",
      include: ["src/**/*.test.ts"],
      environment: "node"
    }
  },
  {
    test: {
      name: "tools",
      root: "packages/tools",
      include: ["src/**/*.test.ts"],
      environment: "node"
    }
  },
  {
    test: {
      name: "markdown",
      root: "packages/markdown",
      include: ["src/**/*.test.ts"],
      environment: "node"
    }
  },
  {
    test: {
      name: "jobs",
      root: "packages/jobs",
      include: ["src/**/*.test.ts"],
      environment: "node"
    }
  }
]);
