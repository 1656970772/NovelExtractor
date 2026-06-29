import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSafeProjectPath, SafePathError } from "./safePaths";

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "novel-safe-paths-"));
}

function detectDirectoryLinkType(): "junction" | "dir" | null {
  const probeRoot = makeTempRoot();
  const target = path.join(probeRoot, "target");
  const link = path.join(probeRoot, "link");
  fs.mkdirSync(target);

  for (const type of ["junction", "dir"] as const) {
    try {
      fs.symlinkSync(target, link, type);
      fs.rmSync(probeRoot, { recursive: true, force: true });
      return type;
    } catch {
      fs.rmSync(link, { recursive: true, force: true });
    }
  }

  fs.rmSync(probeRoot, { recursive: true, force: true });
  return null;
}

const directoryLinkType = detectDirectoryLinkType();

describe("safe project paths", () => {
  it("creates a path inside root and preserves Chinese file names", () => {
    const root = makeTempRoot();

    const safePath = createSafeProjectPath(root, "丹药分析.md");

    expect(path.dirname(safePath)).toBe(fs.realpathSync.native(root));
    expect(path.basename(safePath)).toBe("丹药分析.md");
  });

  it.each([
    "../secrets.txt",
    "..\\secrets.txt",
    "C:/Users/me/token.txt",
    "\\\\server\\share\\x.md",
    "nested/report.md",
    "nested\\report.md",
    "",
    "."
  ])("rejects unsafe path segment %s", (candidate) => {
    const root = makeTempRoot();

    expect(() => createSafeProjectPath(root, candidate)).toThrow(SafePathError);
  });

  it("rejects empty segments in nested paths", () => {
    const root = makeTempRoot();

    expect(() => createSafeProjectPath(root, "books", "", "report.md")).toThrow(SafePathError);
  });

  it.skipIf(directoryLinkType === null)(
    "rejects symlink or junction escapes through an existing parent",
    () => {
      const workspace = makeTempRoot();
      const reportsRoot = path.join(workspace, "reports");
      const outsideRoot = path.join(workspace, "outside");
      const linkPath = path.join(reportsRoot, "linked-out");
      fs.mkdirSync(reportsRoot);
      fs.mkdirSync(outsideRoot);
      fs.symlinkSync(outsideRoot, linkPath, directoryLinkType ?? "dir");

      expect(() => createSafeProjectPath(reportsRoot, "linked-out", "x.md")).toThrow(
        SafePathError
      );
    }
  );
});
