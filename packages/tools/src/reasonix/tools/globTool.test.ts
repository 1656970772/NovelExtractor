import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

describe("Reasonix glob tool parity", () => {
  it("exposes execute on the concrete glob tool while workspace definitions stay provider-only", async () => {
    const { Registry, Workspace } = await import("../index");
    const dir = await tempDir();
    const workspace = new Workspace({ dir });
    const [definition] = workspace.tools(["glob"]);
    const tool = await createTool(workspace);
    const registry = new Registry();
    registry.add(tool);

    expect("execute" in definition).toBe(false);
    expect(typeof tool.execute).toBe("function");
    expect(tool.readOnly()).toBe(true);
    expect(registry.schemas()[0]).toMatchObject({
      name: "glob",
      parameters: {
        required: ["pattern"],
        properties: {
          pattern: { type: "string", description: "Glob pattern (supports ** for recursive matching)" }
        }
      }
    });
  });

  it("matches Go-style glob args for required fields, invalid JSON, type errors, and case-insensitive keys", async () => {
    const { Workspace } = await import("../index");
    const dir = await tempDir();
    await mkfile(path.join(dir, "a.txt"), "a");
    const tool = await createTool(new Workspace({ dir }));
    const goGlobStruct = 'struct { Pattern string "json:\\"pattern\\"" }';

    await expect(tool.execute({})).rejects.toThrow("pattern is required");
    await expect(tool.execute("null")).rejects.toThrow("pattern is required");
    await expect(tool.execute({ pattern: null })).rejects.toThrow("pattern is required");
    await expect(tool.execute("1")).rejects.toThrow(`invalid args: json: cannot unmarshal number into Go value of type ${goGlobStruct}`);
    await expect(tool.execute("{invalid")).rejects.toThrow("invalid args: invalid character 'i' looking for beginning of object key string");
    await expect(tool.execute('{"pattern":1}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal number into Go struct field .pattern of type string"
    );

    await expect(tool.execute('{"PATTERN":"*.txt"}')).resolves.toBe(path.join(dir, "a.txt"));
    await expect(tool.execute(new TextEncoder().encode('{"Pattern":"*.txt"}'))).resolves.toBe(path.join(dir, "a.txt"));
  });

  it("matches plain glob metacharacters and reports no matches or invalid patterns like Reasonix", async () => {
    const { Workspace } = await import("../index");
    const dir = await tempDir();
    await mkfile(path.join(dir, "a.txt"), "a");
    await mkfile(path.join(dir, "b.txt"), "b");
    await mkfile(path.join(dir, "ab.txt"), "ab");
    await mkfile(path.join(dir, "c.log"), "c");
    const tool = await createTool(new Workspace({ dir }));

    expect(await tool.execute({ pattern: "[ab].txt" })).toBe([path.join(dir, "a.txt"), path.join(dir, "b.txt")].join("\n"));
    expect(await tool.execute({ pattern: "?.txt" })).toBe([path.join(dir, "a.txt"), path.join(dir, "b.txt")].join("\n"));
    await expect(tool.execute({ pattern: "*.xyz" })).resolves.toBe("(no matches)");
    await expect(tool.execute({ pattern: "[" })).rejects.toThrow(`glob ${JSON.stringify(path.join(dir, "["))}: syntax error in pattern`);
  });

  it("matches recursive ** patterns, forward-slash patterns, bare ** files, and UTF-8 byte lexical order", async () => {
    const { Workspace } = await import("../index");
    const dir = await tempDir();
    await mkfile(path.join(dir, "a.go"), "package a");
    await mkfile(path.join(dir, "sub", "b.go"), "package b");
    await mkfile(path.join(dir, "sub", "deep", "c.go"), "package c");
    await mkfile(path.join(dir, "sub", "deep", "c.txt"), "text");
    await mkfile(path.join(dir, "\uE000.txt"), "private-use");
    await mkfile(path.join(dir, "\u{10000}.txt"), "non-bmp");
    const tool = await createTool(new Workspace({ dir }));

    const goOut = await tool.execute({ pattern: "**/*.go" });
    expect(relLines(dir, goOut)).toEqual(["a.go", "sub/b.go", "sub/deep/c.go"]);

    const allOut = await tool.execute({ pattern: "**" });
    expect(relLines(dir, allOut)).toEqual([
      "a.go",
      "sub/b.go",
      "sub/deep/c.go",
      "sub/deep/c.txt",
      "\uE000.txt",
      "\u{10000}.txt"
    ]);
    await expect(tool.execute({ pattern: "**/*.py" })).resolves.toBe("(no matches)");
    await expect(tool.execute({ pattern: "**/[" })).resolves.toBe("(no matches)");
  });

  it("surfaces context cancellation before starting a recursive glob walk", async () => {
    const { Workspace } = await import("../index");
    const dir = await tempDir();
    await mkfile(path.join(dir, "sub", "a.go"), "package a");
    const tool = await createTool(new Workspace({ dir }));
    const controller = new AbortController();
    controller.abort();

    await expect(tool.execute({ pattern: "**/*.go" }, { signal: controller.signal })).rejects.toThrow("context canceled");
  });

  it("falls back from a bare filename to recursive search and skips only vendor entries", async () => {
    const { Workspace } = await import("../index");
    const dir = await tempDir();
    await mkdir(path.join(dir, ".git"));
    await mkfile(path.join(dir, ".gitignore"), "*.ignored\n");
    await mkfile(path.join(dir, "sub", "deep", "target.go"), "x");
    await mkfile(path.join(dir, "node_modules", "pkg", "target.go"), "x");
    await mkfile(path.join(dir, ".hidden", "target.go"), "x");
    await mkfile(path.join(dir, "sub", "drop.ignored"), "x");
    const tool = await createTool(new Workspace({ dir }));

    const out = await tool.execute({ pattern: "target.go" });

    expect(relLines(dir, out)).toEqual([".hidden/target.go", "sub/deep/target.go"]);
    expect(relLines(dir, await tool.execute({ pattern: "*.go" }))).toEqual([".hidden/target.go", "sub/deep/target.go"]);
    expect(relLines(dir, await tool.execute({ pattern: "drop.ignored" }))).toEqual(["sub/drop.ignored"]);
  });

  it("recursive glob includes hidden and gitignored files while pruning nested vendor directories", async () => {
    const { Workspace } = await import("../index");
    const dir = await tempDir();
    await mkdir(path.join(dir, ".git"));
    await mkfile(path.join(dir, ".gitignore"), "ignored.txt\n");
    await mkfile(path.join(dir, "visible.txt"), "visible");
    await mkfile(path.join(dir, "ignored.txt"), "ignored");
    await mkfile(path.join(dir, ".hidden.txt"), "hidden");
    await mkfile(path.join(dir, ".hiddenDir", "nested.txt"), "nested");
    await mkfile(path.join(dir, "node_modules", "pkg", "dep.txt"), "dep");
    const tool = await createTool(new Workspace({ dir }));

    const out = await tool.execute({ pattern: "**/*.txt" });

    expect(relLines(dir, out)).toEqual([".hidden.txt", ".hiddenDir/nested.txt", "ignored.txt", "visible.txt"]);
  });

  it("recursive glob includes symlink file entries without following symlink directories", async () => {
    const { Workspace } = await import("../index");
    const dir = await tempDir();
    await mkfile(path.join(dir, "target.txt"), "target");
    await symlink(path.join(dir, "target.txt"), path.join(dir, "link.txt"), "file");
    const tool = await createTool(new Workspace({ dir }));

    const out = await tool.execute({ pattern: "**/*.txt" });

    expect(relLines(dir, out)).toEqual(["link.txt", "target.txt"]);
  });

  it("recursive glob prunes macOS protected home directories by absolute path only", async () => {
    const home = await tempDir();
    await mkfile(path.join(home, "Music", "song.txt"), "song");
    await mkfile(path.join(home, "Pictures", "photo.txt"), "photo");
    await mkfile(path.join(home, "Movies", "movie.txt"), "movie");
    await mkfile(path.join(home, "Library", "cache.txt"), "cache");
    await mkfile(path.join(home, "code", "proj", "Music", "project.txt"), "project");

    await withDarwinHome(home, async () => {
      const { Workspace } = await import("../index");
      const tool = await createTool(new Workspace({ dir: home }));

      expect(relLines(home, await tool.execute({ pattern: "**/*.txt" }))).toEqual(["code/proj/Music/project.txt"]);
      expect(relLines(path.join(home, "Music"), await tool.execute({ pattern: "Music/**/*.txt" }))).toEqual(["song.txt"]);
    });
  });

  it("plain literal glob includes dangling symlink entries when the pattern has a path separator", async () => {
    const { Workspace } = await import("../index");
    const dir = await tempDir();
    await mkdir(path.join(dir, "sub"), { recursive: true });
    const link = path.join(dir, "sub", "broken.txt");
    await symlink(path.join(dir, "missing.txt"), link, "file");
    const tool = await createTool(new Workspace({ dir }));

    expect(await tool.execute({ pattern: "sub/broken.txt" })).toBe(link);
  });

  it("filters forbid-read roots for plain and recursive glob matches", async () => {
    const { Workspace } = await import("../index");
    const dir = await tempDir();
    const secret = path.join(dir, "secret");
    await mkfile(path.join(dir, "allowed", "public.go"), "package public");
    await mkfile(path.join(secret, "secret.go"), "package secret");
    const tool = await createTool(new Workspace({ dir, forbidReadRoots: [secret] }));

    await expect(tool.execute({ pattern: "secret/*.go" })).resolves.toBe("(no matches)");
    await expect(tool.execute({ pattern: "**/*.go" })).resolves.toBe(path.join(dir, "allowed", "public.go"));
  });

  it("uses external read aliases in glob output and errors without leaking local roots", async () => {
    const { PathResolver, Workspace } = await import("../index");
    const dir = await tempDir();
    const external = await tempDir();
    await mkfile(path.join(external, "src", "outside.txt"), "outside");
    const token = "__reasonix_external_folder/abc123/External";
    const resolver = new PathResolver();
    resolver.registerReadRoot(token, external);
    const tool = await createTool(new Workspace({ dir, readPaths: resolver }));

    const out = await tool.execute({ pattern: `${token}/**/*.txt` });

    expect(out).toBe(`${token}/src/outside.txt`);
    expect(out).not.toContain(external);
    await expect(tool.execute({ pattern: `${token}/missing/**/*.go` })).rejects.toThrow(`glob "${token}/missing/**/*.go":`);
    await expect(tool.execute({ pattern: `${token}/missing/**/*.go` })).rejects.not.toThrow(external);
  });

  it("truncates plain and recursive glob output at 1000 results", async () => {
    const { Workspace } = await import("../index");
    const dir = await tempDir();
    for (let index = 0; index < 1001; index += 1) {
      await mkfile(path.join(dir, `file-${String(index).padStart(4, "0")}.txt`), "x");
    }
    const tool = await createTool(new Workspace({ dir }));

    const plain = await tool.execute({ pattern: "*.txt" });
    expect(plain.split("\n")).toHaveLength(1001);
    expect(plain).toContain("file-0999.txt");
    expect(plain).not.toContain("file-1000.txt");
    expect(plain).toContain("... (truncated at 1000 results)");

    const recursive = await tool.execute({ pattern: "**/*.txt" });
    expect(recursive.split("\n")).toHaveLength(1001);
    expect(recursive).toContain("file-0999.txt");
    expect(recursive).not.toContain("file-1000.txt");
    expect(recursive).toContain("... (truncated at 1000 results)");
  });
});

type GlobTool = {
  name: string;
  description(): string;
  schema(): unknown;
  readOnly(): boolean;
  execute(args: unknown, context?: { signal?: AbortSignal }): Promise<string> | string;
};

async function createTool(workspace: unknown): Promise<GlobTool> {
  const mod = (await import("../index")) as typeof import("../index") & { createGlobTool: (workspace: unknown) => GlobTool };
  return mod.createGlobTool(workspace);
}

function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "reasonix-glob-"));
}

async function mkfile(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

function relLines(root: string, output: string): string[] {
  return output.split("\n").map((line) => path.relative(root, line).replace(/\\/gu, "/"));
}

async function withDarwinHome<T>(home: string, callback: () => Promise<T>): Promise<T> {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "darwin" });
  vi.spyOn(os, "homedir").mockReturnValue(home);
  await vi.resetModules();
  try {
    return await callback();
  } finally {
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", { value: originalPlatform });
    await vi.resetModules();
  }
}
