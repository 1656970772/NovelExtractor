import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Reasonix ls tool parity", () => {
  it("exposes execute on the concrete ls tool while workspace definitions stay provider-only", async () => {
    const { Registry, Workspace } = await import("../index");
    const dir = await tempDir();
    const workspace = new Workspace({ dir });
    const [definition] = workspace.tools(["ls"]);
    const tool = await createTool(workspace);
    const registry = new Registry();
    registry.add(tool);

    expect("execute" in definition).toBe(false);
    expect(typeof tool.execute).toBe("function");
    expect(tool.name).toBe("ls");
    expect(tool.readOnly()).toBe(true);
    expect(registry.schemas()[0]).toEqual({
      name: "ls",
      description:
        "List the entries of a directory. Directories are shown with a trailing slash; files show their byte size. Set recursive=true to list all nested files depth-first (skips .git/node_modules).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: 'Directory path (default ".")' },
          recursive: { type: "boolean", description: "When true, recursively list all nested files (default false)" }
        }
      }
    });
  });

  it("matches Go-style ls args for defaults, nulls, invalid JSON, type errors, and case-insensitive keys", async () => {
    const { Workspace } = await import("../index");
    const dir = await tempDir();
    await mkfile(path.join(dir, "a.txt"), "a");
    const tool = await createTool(new Workspace({ dir }));
    const goLsStruct = 'struct { Path string "json:\\"path\\""; Recursive bool "json:\\"recursive\\"" }';

    await expect(tool.execute({})).resolves.toBe("a.txt\t1\n");
    await expect(tool.execute(null)).resolves.toBe("a.txt\t1\n");
    await expect(tool.execute("null")).resolves.toBe("a.txt\t1\n");
    await expect(tool.execute({ path: "" })).resolves.toBe("a.txt\t1\n");
    await expect(tool.execute('{"path":".","path":null}')).resolves.toBe("a.txt\t1\n");
    await expect(tool.execute('{"path":null,"Path":"."}')).resolves.toBe("a.txt\t1\n");
    await expect(tool.execute('{"PATH":".","RECURSIVE":true}')).resolves.toBe("a.txt\t1\n");
    await expect(tool.execute(new TextEncoder().encode('{"Path":"."}'))).resolves.toBe("a.txt\t1\n");

    await expect(tool.execute("1")).rejects.toThrow(`invalid args: json: cannot unmarshal number into Go value of type ${goLsStruct}`);
    await expect(tool.execute("{invalid")).rejects.toThrow("invalid args: invalid character 'i' looking for beginning of object key string");
    await expect(tool.execute('{"path":1}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal number into Go struct field .path of type string"
    );
    await expect(tool.execute('{"recursive":"yes"}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal string into Go struct field .recursive of type bool"
    );
    await expect(tool.execute({ recursive: "yes" })).rejects.toThrow(
      "invalid args: json: cannot unmarshal string into Go struct field .recursive of type bool"
    );
    await expect(tool.execute('{"path":1,"path":"."}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal number into Go struct field .path of type string"
    );
  });

  it("lists non-recursive directory entries with Go ReadDir sorting, directory suffixes, file sizes, and empty output", async () => {
    const { Workspace } = await import("../index");
    const dir = await tempDir();
    await mkdir(path.join(dir, "b-dir"));
    await mkdir(path.join(dir, "a-dir"));
    await mkfile(path.join(dir, "z.txt"), "hello");
    await mkfile(path.join(dir, "a.txt"), "xy");
    const tool = await createTool(new Workspace({ dir }));

    expect(await tool.execute({ path: "." })).toBe("a-dir/\na.txt\t2\nb-dir/\nz.txt\t5\n");
    await expect(tool.execute({ path: "a-dir" })).resolves.toBe("(empty directory)");
  });

  it("recursively lists depth-first relative slash paths, skips noise directories, and reports empty trees", async () => {
    const { Workspace } = await import("../index");
    const dir = await tempDir();
    await mkfile(path.join(dir, "top.txt"), "x");
    await mkfile(path.join(dir, "a", "b", "nested.txt"), "yy");
    await mkfile(path.join(dir, ".git", "HEAD"), "ref");
    await mkfile(path.join(dir, "node_modules", "pkg", "dep.txt"), "dep");
    await mkfile(path.join(dir, ".DS_Store", "ignored.txt"), "ignored");
    await mkfile(path.join(dir, "__pycache__", "cache.pyc"), "ignored");
    await mkfile(path.join(dir, ".idea", "workspace.xml"), "ignored");
    await mkfile(path.join(dir, ".vscode", "settings.json"), "ignored");
    const tool = await createTool(new Workspace({ dir }));

    expect(await tool.execute({ path: ".", recursive: true })).toBe("a/\na/b/\na/b/nested.txt\t2\ntop.txt\t1\n");

    const empty = await tempDir();
    await expect(createTool(new Workspace({ dir: empty })).then((ls) => ls.execute({ recursive: true }))).resolves.toBe(
      "(empty directory tree)"
    );
  });

  it("does not follow symlink directories during recursive WalkDir-style listing", async () => {
    const { Workspace } = await import("../index");
    const dir = await tempDir();
    const outside = await tempDir();
    await mkfile(path.join(outside, "hidden.txt"), "secret");
    await symlink(outside, path.join(dir, "linked-dir"), "dir");
    const tool = await createTool(new Workspace({ dir }));

    const out = await tool.execute({ path: ".", recursive: true });

    expect(out).toContain("linked-dir\t");
    expect(out).not.toContain("hidden.txt");
  });

  it("keeps recursive depth capped at Reasonix's 50 separator guard", async () => {
    const { Workspace } = await import("../index");
    const dir = await tempDir();
    let current = dir;
    for (let depth = 0; depth <= 52; depth += 1) {
      current = path.join(current, `d${String(depth).padStart(2, "0")}`);
      await mkdir(current, { recursive: true });
      await writeFile(path.join(current, `f${depth}.txt`), "x", "utf8");
    }
    const tool = await createTool(new Workspace({ dir }));
    const out = await tool.execute({ recursive: true });

    expect(out).toContain("d00/d01/d02");
    expect(out).toContain("f49.txt\t1");
    expect(out).not.toContain("f50.txt");
    expect(out).not.toContain("f51.txt");
    expect(out).not.toContain("f52.txt");
  });

  it("uses external read aliases in ls output and errors without leaking local roots", async () => {
    const { PathResolver, Workspace } = await import("../index");
    const dir = await tempDir();
    const external = await tempDir();
    await mkfile(path.join(external, "src", "outside.txt"), "outside");
    const token = "__reasonix_external_folder/abc123/External";
    const resolver = new PathResolver();
    resolver.registerReadRoot(token, external);
    const tool = await createTool(new Workspace({ dir, readPaths: resolver }));

    const out = await tool.execute({ path: `${token}/src` });

    expect(out).toBe("outside.txt\t7\n");
    expect(out).not.toContain(external);
    await expect(tool.execute({ path: `${token}/missing` })).rejects.toThrow(`ls ${token}/missing: open ${token}/missing: no such file or directory`);
    await expect(tool.execute({ path: `${token}/missing` })).rejects.not.toThrow(external);
    await expect(tool.execute({ path: `${token}/missing`, recursive: true })).rejects.toThrow(
      `ls -R ${token}/missing: lstat ${token}/missing: no such file or directory`
    );
    await expect(tool.execute({ path: `${token}/missing`, recursive: true })).rejects.not.toThrow(external);
  });

  it("returns empty directory for forbid-read roots and skips forbidden recursive child directories", async () => {
    const { Workspace } = await import("../index");
    const dir = await tempDir();
    const secret = path.join(dir, "secret");
    await mkfile(path.join(secret, "hidden.txt"), "hidden");
    await mkfile(path.join(dir, "public", "visible.txt"), "visible");
    const tool = await createTool(new Workspace({ dir, forbidReadRoots: [secret] }));

    await expect(tool.execute({ path: "secret" })).resolves.toBe("(empty directory)");
    await expect(tool.execute({ path: "secret", recursive: true })).resolves.toBe("(empty directory)");
    await expect(tool.execute({ path: ".", recursive: true })).resolves.toBe("public/\npublic/visible.txt\t7\n");
  });

  it("wraps ordinary missing path errors with ls and ls -R prefixes", async () => {
    const { Workspace } = await import("../index");
    const dir = await tempDir();
    const missing = path.join(dir, "missing");
    const tool = await createTool(new Workspace({ dir }));

    await expect(tool.execute({ path: "missing" })).rejects.toThrow(`ls ${missing}: open ${missing}: no such file or directory`);
    await expect(tool.execute({ path: "missing", recursive: true })).rejects.toThrow(
      `ls -R ${missing}: lstat ${missing}: no such file or directory`
    );
  });
});

type LsTool = {
  name: string;
  description(): string;
  schema(): unknown;
  readOnly(): boolean;
  execute(args: unknown): Promise<string> | string;
};

async function createTool(workspace: unknown): Promise<LsTool> {
  const mod = (await import("../index")) as typeof import("../index") & { createLsTool: (workspace: unknown) => LsTool };
  return mod.createLsTool(workspace);
}

function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "reasonix-ls-"));
}

async function mkfile(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}
