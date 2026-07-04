import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createBuildMetadataDefine } from "./buildInfo";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = join(desktopRoot, "..", "..");

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

const listSourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return listSourceFiles(path);
    }
    return entry.isFile() && path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });

const workspacePackageEntryUsesTypeScript = (packageName: string): boolean => {
  const packageDir = packageName.replace("@novel-extractor/", "");
  const packageJsonPath = join(repoRoot, "packages", packageDir, "package.json");
  const packageJson = readJson<{
    exports?: Record<string, string>;
    main?: string;
  }>(packageJsonPath);

  return [packageJson.main, packageJson.exports?.["."]].some((entry) => entry?.endsWith(".ts"));
};

const readMainExternalizeExclude = (): string[] => {
  const configSource = readFileSync(join(desktopRoot, "electron.vite.config.ts"), "utf8");
  const mainConfig = /main:\s*\{(?<main>[\s\S]*?)preload:\s*\{/u.exec(configSource)?.groups?.main;
  const excludeSource = /externalizeDepsPlugin\(\s*\{\s*exclude:\s*\[(?<exclude>[\s\S]*?)\]/u.exec(
    mainConfig ?? ""
  )?.groups?.exclude;

  if (!excludeSource) {
    throw new Error("Missing main externalizeDepsPlugin exclude list in electron.vite.config.ts");
  }

  return [...excludeSource.matchAll(/"(?<packageName>@novel-extractor\/[^"]+|[^"]+)"/gu)].map(
    (match) => match.groups?.packageName ?? ""
  );
};

const readMainRuntimeWorkspaceImports = (): string[] => {
  const imports = new Set<string>();
  const runtimeImportPattern =
    /import\s+(?!type\b)(?:[\s\S]*?\s+from\s+)?["'](?<packageName>@novel-extractor\/[^/"']+)/gu;

  for (const file of listSourceFiles(join(desktopRoot, "src", "main"))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(runtimeImportPattern)) {
      const packageName = match.groups?.packageName;
      if (packageName && workspacePackageEntryUsesTypeScript(packageName)) {
        imports.add(packageName);
      }
    }
  }

  return [...imports].sort();
};

describe("electron vite main bundle config", () => {
  it("allows unknown commit and time in dev when git and env are unavailable", () => {
    expect(
      createBuildMetadataDefine({
        command: "serve",
        env: {},
        readGitCommit: () => undefined,
        now: () => "2026-07-03T00:00:00.000Z"
      })
    ).toEqual({
      __NOVEL_EXTRACTOR_BUILD_COMMIT__: JSON.stringify("unknown"),
      __NOVEL_EXTRACTOR_BUILD_TIME__: JSON.stringify("unknown")
    });
  });

  it("rejects build metadata when build cannot resolve commit and time", () => {
    expect(() =>
      createBuildMetadataDefine({
        command: "build",
        env: {},
        readGitCommit: () => undefined,
        now: () => "2026-07-03T00:00:00.000Z"
      })
    ).toThrow(/build metadata/i);
  });

  it("rejects literal unknown build metadata from environment in build mode", () => {
    expect(() =>
      createBuildMetadataDefine({
        command: "build",
        env: {
          NOVEL_EXTRACTOR_BUILD_COMMIT: " unknown ",
          NOVEL_EXTRACTOR_BUILD_TIME: "UNKNOWN"
        },
        readGitCommit: () => undefined,
        now: () => "2026-07-03T00:00:00.000Z"
      })
    ).toThrow(/build metadata/i);
  });

  it("rejects literal unknown git commit in build mode", () => {
    expect(() =>
      createBuildMetadataDefine({
        command: "build",
        env: {},
        readGitCommit: () => "UnKnOwN",
        now: () => "2026-07-03T00:00:00.000Z"
      })
    ).toThrow(/build metadata/i);
  });

  it("uses environment build metadata in build mode without git", () => {
    expect(
      createBuildMetadataDefine({
        command: "build",
        env: {
          NOVEL_EXTRACTOR_BUILD_COMMIT: "env-commit",
          NOVEL_EXTRACTOR_BUILD_TIME: "env-time"
        },
        readGitCommit: () => undefined,
        now: () => "2026-07-03T00:00:00.000Z"
      })
    ).toEqual({
      __NOVEL_EXTRACTOR_BUILD_COMMIT__: JSON.stringify("env-commit"),
      __NOVEL_EXTRACTOR_BUILD_TIME__: JSON.stringify("env-time")
    });
  });

  it("uses git commit and current time in build mode when env is absent", () => {
    expect(
      createBuildMetadataDefine({
        command: "build",
        env: {},
        readGitCommit: () => "git-commit",
        now: () => "2026-07-03T00:00:00.000Z"
      })
    ).toEqual({
      __NOVEL_EXTRACTOR_BUILD_COMMIT__: JSON.stringify("git-commit"),
      __NOVEL_EXTRACTOR_BUILD_TIME__: JSON.stringify("2026-07-03T00:00:00.000Z")
    });
  });

  it("bundles runtime workspace packages that still export TypeScript source", () => {
    const externalizeExclude = readMainExternalizeExclude();
    const runtimeWorkspaceTypeScriptImports = readMainRuntimeWorkspaceImports();
    const missingPackages = runtimeWorkspaceTypeScriptImports.filter(
      (packageName) => !externalizeExclude.includes(packageName)
    );

    expect(missingPackages, `missing main bundle exclude for ${relative(repoRoot, desktopRoot)}`).toEqual([]);
  });
});
