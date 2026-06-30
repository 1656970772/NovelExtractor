import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const canCreateDirectorySymlink = (() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "reasonix-symlink-probe-"));
  try {
    const outside = path.join(base, "outside");
    const link = path.join(base, "link");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
})();

describe("Reasonix path resolver parity", () => {
  it("resolves workspace paths like Reasonix resolveIn", async () => {
    const { resolveInWorkspace } = await import("./pathResolver");
    const workDir = path.join("C:\\tmp", "proj");
    const absolute = path.join("C:\\tmp", "etc", "passwd");

    expect(resolveInWorkspace("", "foo.go")).toBe("foo.go");
    expect(resolveInWorkspace("", "")).toBe("");
    expect(resolveInWorkspace(workDir, "foo.go")).toBe(path.join(workDir, "foo.go"));
    expect(resolveInWorkspace(workDir, "a/b.go")).toBe(path.join(workDir, "a", "b.go"));
    expect(resolveInWorkspace(workDir, ".")).toBe(workDir);
    expect(resolveInWorkspace(workDir, "")).toBe(workDir);
    expect(resolveInWorkspace(workDir, absolute)).toBe(absolute);
    expect(resolveInWorkspace(workDir, "../escape")).toBe(path.join(path.dirname(workDir), "escape"));
  });

  it("normalizes read aliases, resolves subpaths, and hides local roots in display helpers", async () => {
    const { PathResolver } = await import("./pathResolver");
    const resolver = new PathResolver();
    const root = path.join("C:\\external", "Readable");

    resolver.registerReadRoot("@__reasonix_external_folder/abc/External/", root);
    const resolved = resolver.resolve("__reasonix_external_folder/abc/External/src/outside.txt");

    expect(resolved).toMatchObject({
      path: path.join(root, "src", "outside.txt"),
      displayPath: "__reasonix_external_folder/abc/External/src/outside.txt",
      root,
      displayRoot: "__reasonix_external_folder/abc/External",
      external: true
    });
    expect(resolved?.displayFor(path.join(root, "src", "outside.txt"))).toBe("__reasonix_external_folder/abc/External/src/outside.txt");
    expect(resolved?.displayFor(root)).toBe("__reasonix_external_folder/abc/External");
    expect(resolved?.errorText(new Error(`open ${root}: no such file`))).toBe(
      "open __reasonix_external_folder/abc/External: no such file"
    );

    const resolvedDoubleSlash = resolver.resolve("__reasonix_external_folder/abc/External//src/outside.txt");
    expect(resolvedDoubleSlash).toMatchObject({
      path: path.join(root, "src", "outside.txt"),
      displayPath: "__reasonix_external_folder/abc/External/src/outside.txt",
      root,
      displayRoot: "__reasonix_external_folder/abc/External",
      external: true
    });
  });

  it("rejects alias subpaths that escape the registered read root", async () => {
    const { PathResolver } = await import("./pathResolver");
    const resolver = new PathResolver();

    resolver.registerReadRoot("__reasonix_external_folder/abc/External", path.join("C:\\external", "Readable"));

    expect(resolver.resolve("__reasonix_external_folder/abc/External/../secret.txt")).toBeUndefined();
  });

  it("rejects Windows absolute and rooted alias subpaths like filepath.IsLocal", async () => {
    const { PathResolver } = await import("./pathResolver");
    const resolver = new PathResolver();

    resolver.registerReadRoot("__reasonix_external_folder/abc/External", path.join("C:\\external", "Readable"));

    expect(resolver.resolve("__reasonix_external_folder/abc/External/C:secret.txt")).toBeUndefined();
    expect(resolver.resolve("__reasonix_external_folder/abc/External/C:/secret.txt")).toBeUndefined();
    expect(resolver.resolve("__reasonix_external_folder/abc/External/C:\\secret.txt")).toBeUndefined();
    expect(resolver.resolve("__reasonix_external_folder/abc/External/C:/../secret.txt")).toBeUndefined();
    expect(resolver.resolve("__reasonix_external_folder/abc/External//server/share/secret.txt")).toMatchObject({
      path: path.join("C:\\external", "Readable", "server", "share", "secret.txt"),
      displayPath: "__reasonix_external_folder/abc/External/server/share/secret.txt"
    });
    expect(resolver.resolve("__reasonix_external_folder/abc/External///server/share/secret.txt")).toBeUndefined();
    expect(resolver.resolve("__reasonix_external_folder/abc/External/\\server\\share\\secret.txt")).toMatchObject({
      path: path.join("C:\\external", "Readable", "server", "share", "secret.txt"),
      displayPath: "__reasonix_external_folder/abc/External/server/share/secret.txt"
    });
    expect(resolver.resolve("__reasonix_external_folder/abc/External/..")).toBeUndefined();
    expect(resolver.resolve("__reasonix_external_folder/abc/External/../x")).toBeUndefined();
  });

  it("confines writes to real configured roots without prefix or parent escapes", async () => {
    const { assertWritablePath, realRoots } = await import("./pathResolver");
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "reasonix-confine-"));
    const root = path.join(base, "workspace");
    const sibling = path.join(base, "workspace-other");
    fs.mkdirSync(root);
    fs.mkdirSync(sibling);
    const roots = realRoots([root]);

    try {
      expect(roots).toHaveLength(1);
      expect(() => assertWritablePath([], path.join(base, "anywhere", "file.txt"))).not.toThrow();
      expect(() => assertWritablePath(roots, path.join(root, "src", "main.ts"))).not.toThrow();
      expect(() => assertWritablePath(roots, path.join(root, "..", "escape.txt"))).toThrow(/outside the writable roots/u);
      expect(() => assertWritablePath(roots, path.join(sibling, "file.txt"))).toThrow(/outside the writable roots/u);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it.skipIf(!canCreateDirectorySymlink)("rejects writes through a symlinked directory that escapes the root", async () => {
    const { assertWritablePath, realRoots } = await import("./pathResolver");
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "reasonix-confine-link-"));
    const root = path.join(base, "workspace");
    const outside = path.join(base, "outside");
    const link = path.join(root, "out");
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    const roots = realRoots([root]);

    try {
      expect(roots).toHaveLength(1);
      expect(() => assertWritablePath(roots, path.join(link, "evil.txt"))).toThrow(/outside the writable roots/u);
      expect(() => assertWritablePath(roots, path.join(root, "ok.txt"))).not.toThrow();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("confines read roots with real directories and leaves outside paths readable", async () => {
    const { confineRead, realRoots } = await import("./pathResolver");
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "reasonix-confine-read-"));
    const forbidden = path.join(base, "secret");
    const allowed = path.join(base, "public");
    fs.mkdirSync(forbidden);
    fs.mkdirSync(allowed);
    const forbidRoots = realRoots([forbidden]);

    try {
      expect(forbidRoots).toHaveLength(1);
      expect(confineRead(forbidRoots, path.join(forbidden, "key.pem"))).toBe(true);
      expect(confineRead(forbidRoots, path.join(allowed, "ok.txt"))).toBe(false);
      expect(confineRead([], path.join(forbidden, "key.pem"))).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
