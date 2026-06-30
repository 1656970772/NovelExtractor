import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Reasonix write_file tool parity", () => {
  it("creates parent directories, writes new files, overwrites files, and reports UTF-8 byte counts", async () => {
    const { createWriteFileTool } = await import("./writeFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();
    const tool = createWriteFileTool(new Workspace({ dir }));

    const nestedPath = path.join(dir, "nested", "out.txt");
    const chinese = "新文件中文\n";
    await expect(tool.execute({ path: "nested/out.txt", content: chinese })).resolves.toBe(
      `wrote ${Buffer.byteLength(chinese, "utf8")} bytes to ${nestedPath}`
    );
    await expect(readFile(nestedPath, "utf8")).resolves.toBe(chinese);

    const overwritePath = path.join(dir, "overwrite.txt");
    await writeFile(overwritePath, "old", "utf8");
    await expect(tool.execute({ path: "overwrite.txt", content: "new" })).resolves.toBe(`wrote 3 bytes to ${overwritePath}`);
    await expect(readFile(overwritePath, "utf8")).resolves.toBe("new");
  });

  it("returns the Reasonix no-op message and does not touch identical content", async () => {
    const { createWriteFileTool } = await import("./writeFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();
    const target = path.join(dir, "same.txt");
    await writeFile(target, "same", "utf8");
    const oldDate = new Date("2001-02-03T04:05:06.000Z");
    await utimes(target, oldDate, oldDate);
    const before = await stat(target);

    const tool = createWriteFileTool(new Workspace({ dir }));
    await expect(tool.execute({ path: "same.txt", content: "same" })).resolves.toBe(
      `${target} already contains the exact content; no changes made`
    );

    await expect(readFile(target, "utf8")).resolves.toBe("same");
    expect((await stat(target)).mtimeMs).toBe(before.mtimeMs);
  });

  it("exposes preview on the concrete write_file tool while workspace definitions stay provider-only", async () => {
    const { createWriteFileTool } = await import("./writeFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();
    const workspace = new Workspace({ dir });
    const [definition] = workspace.tools(["write_file"]);
    const tool = createWriteFileTool(workspace);

    expect("execute" in definition).toBe(false);
    expect("preview" in definition).toBe(false);
    expect(typeof tool.execute).toBe("function");
    expect(typeof (tool as PreviewableWriteFileTool).preview).toBe("function");
  });

  it("previews a create without touching disk and returns Reasonix diff metadata", async () => {
    const { createWriteFileTool } = await import("./writeFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();
    const target = path.join(dir, "new.txt");
    const tool = createWriteFileTool(new Workspace({ dir })) as PreviewableWriteFileTool;

    const change = await tool.preview({ path: "new.txt", content: "a\nb\nc\n" });

    expect(change).toMatchObject({
      path: target,
      kind: "create",
      oldText: "",
      newText: "a\nb\nc\n",
      added: 3,
      removed: 0,
      binary: false
    });
    expect(change.diff).toContain(`--- a/${target}\n+++ b/${target}\n`);
    expect(change.diff).toContain("@@ -0,0 +1,3 @@\n+a\n+b\n+c\n");
    await expect(stat(target)).rejects.toThrow();
  });

  it("previews a modify without mutating the existing file", async () => {
    const { createWriteFileTool } = await import("./writeFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();
    const target = path.join(dir, "existing.txt");
    await writeFile(target, "one\ntwo\nthree\n", "utf8");
    const tool = createWriteFileTool(new Workspace({ dir })) as PreviewableWriteFileTool;

    const change = await tool.preview({ path: "existing.txt", content: "one\nTWO\nthree\n" });

    expect(change).toMatchObject({
      path: target,
      kind: "modify",
      oldText: "one\ntwo\nthree\n",
      newText: "one\nTWO\nthree\n",
      added: 1,
      removed: 1,
      binary: false
    });
    expect(change.diff).toContain("@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n");
    await expect(readFile(target, "utf8")).resolves.toBe("one\ntwo\nthree\n");
  });

  it("keeps preview newText aligned with execute for creates and overwrites", async () => {
    const { createWriteFileTool } = await import("./writeFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();
    const tool = createWriteFileTool(new Workspace({ dir })) as PreviewableWriteFileTool;

    const createPreview = await tool.preview({ path: "preview-create.txt", content: "fresh\nfile\n" });
    await tool.execute({ path: "execute-create.txt", content: "fresh\nfile\n" });
    expect(await readFile(path.join(dir, "execute-create.txt"), "utf8")).toBe(createPreview.newText);
    await expect(stat(path.join(dir, "preview-create.txt"))).rejects.toThrow();

    await writeFile(path.join(dir, "preview-overwrite.txt"), "old content\n", "utf8");
    await writeFile(path.join(dir, "execute-overwrite.txt"), "old content\n", "utf8");
    const modifyPreview = await tool.preview({ path: "preview-overwrite.txt", content: "new content\n" });
    await tool.execute({ path: "execute-overwrite.txt", content: "new content\n" });
    expect(await readFile(path.join(dir, "execute-overwrite.txt"), "utf8")).toBe(modifyPreview.newText);
    await expect(readFile(path.join(dir, "preview-overwrite.txt"), "utf8")).resolves.toBe("old content\n");
  });

  it("binds preview relative paths to the workspace and mirrors execute arg errors", async () => {
    const { createWriteFileTool } = await import("./writeFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();
    const tool = createWriteFileTool(new Workspace({ dir })) as PreviewableWriteFileTool;
    const goWriteStruct = 'struct { Path string "json:\\"path\\""; Content string "json:\\"content\\"" }';

    await expect(tool.preview({ path: "inside.txt", content: "a\n" })).resolves.toMatchObject({
      path: path.join(dir, "inside.txt"),
      newText: "a\n"
    });
    await expect(tool.preview("{invalid")).rejects.toThrow("invalid args: invalid character 'i' looking for beginning of object key string");
    await expect(tool.preview("1")).rejects.toThrow(`invalid args: json: cannot unmarshal number into Go value of type ${goWriteStruct}`);
    await expect(tool.preview({ content: "x" })).rejects.toThrow("path is required");
    await expect(tool.preview('{"path":1,"content":"x"}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal number into Go struct field .path of type string"
    );
  });

  it("decodes existing GB18030 content for preview oldText", async () => {
    const { createWriteFileTool } = await import("./writeFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();
    const target = path.join(dir, "gbk.txt");
    await writeFile(target, Buffer.from([212, 173, 202, 188, 196, 218, 200, 221, 10]));
    const tool = createWriteFileTool(new Workspace({ dir })) as PreviewableWriteFileTool;

    const change = await tool.preview({ path: "gbk.txt", content: "全新中文内容\n" });

    expect(change.kind).toBe("modify");
    expect(change.oldText).toBe("原始内容\n");
    expect(change.newText).toBe("全新中文内容\n");
    await expect(readFile(target)).resolves.toEqual(Buffer.from([212, 173, 202, 188, 196, 218, 200, 221, 10]));
  });

  it("uses Go struct zero values for missing/null content but still requires path", async () => {
    const { createWriteFileTool } = await import("./writeFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();
    const tool = createWriteFileTool(new Workspace({ dir }));

    await expect(tool.execute({ content: "x" })).rejects.toThrow("path is required");
    await expect(tool.execute("null")).rejects.toThrow("path is required");
    await expect(tool.execute({ path: null, content: "x" })).rejects.toThrow("path is required");

    await expect(tool.execute('{"path":"missing-content.txt"}')).resolves.toBe(`wrote 0 bytes to ${path.join(dir, "missing-content.txt")}`);
    await expect(readFile(path.join(dir, "missing-content.txt"))).resolves.toHaveLength(0);

    await expect(tool.execute({ path: "null-content.txt", content: null })).resolves.toBe(`wrote 0 bytes to ${path.join(dir, "null-content.txt")}`);
    await expect(readFile(path.join(dir, "null-content.txt"))).resolves.toHaveLength(0);
  });

  it("matches Go raw JSON null no-op semantics for duplicate string fields", async () => {
    const { createWriteFileTool } = await import("./writeFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();
    const tool = createWriteFileTool(new Workspace({ dir }));

    await expect(tool.execute('{"path":"path-kept.txt","path":null,"content":"ok"}')).resolves.toBe(
      `wrote 2 bytes to ${path.join(dir, "path-kept.txt")}`
    );
    await expect(readFile(path.join(dir, "path-kept.txt"), "utf8")).resolves.toBe("ok");

    await expect(tool.execute('{"path":"content-kept.txt","content":"ALPHA","content":null}')).resolves.toBe(
      `wrote 5 bytes to ${path.join(dir, "content-kept.txt")}`
    );
    await expect(readFile(path.join(dir, "content-kept.txt"), "utf8")).resolves.toBe("ALPHA");

    await expect(tool.execute('{"path":"empty-content.txt","content":null}')).resolves.toBe(
      `wrote 0 bytes to ${path.join(dir, "empty-content.txt")}`
    );
    await expect(readFile(path.join(dir, "empty-content.txt"))).resolves.toHaveLength(0);
    await expect(tool.execute('{"path":null,"content":"x"}')).rejects.toThrow("path is required");
    await expect(tool.execute('{"path":1,"path":null,"content":"x"}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal number into Go struct field .path of type string"
    );
    await expect(tool.execute('{"path":"bad-content.txt","content":1,"content":null}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal number into Go struct field .content of type string"
    );
  });

  it("formats raw JSON syntax, top-level type, field type, case, and duplicate-field behavior like Go encoding/json", async () => {
    const { createWriteFileTool } = await import("./writeFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();
    const tool = createWriteFileTool(new Workspace({ dir }));
    const goWriteStruct = 'struct { Path string "json:\\"path\\""; Content string "json:\\"content\\"" }';

    await expect(tool.execute("{invalid")).rejects.toThrow("invalid args: invalid character 'i' looking for beginning of object key string");
    await expect(tool.execute("1")).rejects.toThrow(`invalid args: json: cannot unmarshal number into Go value of type ${goWriteStruct}`);
    await expect(tool.execute("[]")).rejects.toThrow(`invalid args: json: cannot unmarshal array into Go value of type ${goWriteStruct}`);
    await expect(tool.execute("true")).rejects.toThrow(`invalid args: json: cannot unmarshal bool into Go value of type ${goWriteStruct}`);

    await expect(tool.execute('{"path":1,"content":"x"}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal number into Go struct field .path of type string"
    );
    await expect(tool.execute('{"path":"bad-content.txt","content":1}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal number into Go struct field .content of type string"
    );
    await expect(tool.execute('{"path":null,"content":1}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal number into Go struct field .content of type string"
    );
    await expect(tool.execute({ path: null, content: 1 })).rejects.toThrow(
      "invalid args: json: cannot unmarshal number into Go struct field .content of type string"
    );

    await expect(tool.execute('{"Path":"case.txt","CONTENT":"ok"}')).resolves.toBe(`wrote 2 bytes to ${path.join(dir, "case.txt")}`);
    await expect(readFile(path.join(dir, "case.txt"), "utf8")).resolves.toBe("ok");
    await expect(tool.execute(new TextEncoder().encode('{"PATH":"bytes.txt","content":"ok"}'))).resolves.toBe(
      `wrote 2 bytes to ${path.join(dir, "bytes.txt")}`
    );

    await expect(tool.execute('{"path":1,"path":"dup-path.txt","content":"x"}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal number into Go struct field .path of type string"
    );
    await expect(tool.execute('{"path":"dup-content.txt","content":1,"content":"x"}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal number into Go struct field .content of type string"
    );
  });

  it("resolves relative paths in the workspace and confines absolute writes to writable roots", async () => {
    const { createWriteFileTool } = await import("./writeFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();
    const outside = path.join(await tempDir(), "outside.txt");
    const tool = createWriteFileTool(new Workspace({ dir }));

    await expect(tool.execute({ path: "ok.txt", content: "inside" })).resolves.toBe(`wrote 6 bytes to ${path.join(dir, "ok.txt")}`);
    await expect(readFile(path.join(dir, "ok.txt"), "utf8")).resolves.toBe("inside");

    await expect(tool.execute({ path: path.join(dir, "absolute.txt"), content: "absolute" })).resolves.toBe(
      `wrote 8 bytes to ${path.join(dir, "absolute.txt")}`
    );
    await expect(tool.execute({ path: outside, content: "x" })).rejects.toThrow(/outside the writable roots/u);
  });

  it("preserves GB18030 on overwrite and writes new Chinese files as UTF-8", async () => {
    const { createWriteFileTool } = await import("./writeFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();
    const tool = createWriteFileTool(new Workspace({ dir }));
    const gbkPath = path.join(dir, "gbk.txt");
    await writeFile(gbkPath, Buffer.from([212, 173, 202, 188, 196, 218, 200, 221, 10]));

    await expect(tool.execute({ path: "gbk.txt", content: "全新中文内容\n第二行\n" })).resolves.toBe(
      `wrote ${Buffer.byteLength("全新中文内容\n第二行\n", "utf8")} bytes to ${gbkPath}`
    );

    const raw = await readFile(gbkPath);
    expect(raw).toEqual(Buffer.from([200, 171, 208, 194, 214, 208, 206, 196, 196, 218, 200, 221, 10, 181, 218, 182, 254, 208, 208, 10]));
    expect(new TextDecoder("gb18030", { fatal: true }).decode(raw)).toBe("全新中文内容\n第二行\n");

    const utf8Path = path.join(dir, "new.txt");
    await expect(tool.execute({ path: "new.txt", content: "新文件中文\n" })).resolves.toBe(
      `wrote ${Buffer.byteLength("新文件中文\n", "utf8")} bytes to ${utf8Path}`
    );
    expect(await readFile(utf8Path)).toEqual(Buffer.from("新文件中文\n", "utf8"));
  });

  it("preserves UTF-16 BOM and BOM-less encodings on overwrite", async () => {
    const { createWriteFileTool } = await import("./writeFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();
    const tool = createWriteFileTool(new Workspace({ dir }));
    const cases: Array<[string, "le" | "be", boolean]> = [
      ["utf16le.txt", "le", true],
      ["utf16be.txt", "be", true],
      ["utf16le-nobom.txt", "le", false],
      ["utf16be-nobom.txt", "be", false]
    ];

    for (const [filename, endian, withBom] of cases) {
      await writeFile(path.join(dir, filename), encodeUtf16("original UTF16 text\n", endian, withBom));

      await tool.execute({ path: filename, content: "写回UTF16\n" });

      expect(await readFile(path.join(dir, filename))).toEqual(encodeUtf16("写回UTF16\n", endian, withBom));
    }
  });

  it("can be registered as the concrete write_file tool while schemas remain provider-visible only", async () => {
    const { createWriteFileTool } = await import("./writeFileTool");
    const { Registry, Workspace } = await import("../index");
    const dir = await tempDir();
    const registry = new Registry();

    registry.add(createWriteFileTool(new Workspace({ dir })));
    const tool = registry.get("write_file");

    expect(registry.schemas()[0]).toMatchObject({
      name: "write_file",
      parameters: {
        required: ["content", "path"],
        properties: {
          content: { type: "string" },
          path: { type: "string" }
        }
      }
    });
    expect(tool?.readOnly()).toBe(false);
    expect(tool).toBeDefined();
    expect("execute" in tool!).toBe(true);
    expect("preview" in registry.schemas()[0]).toBe(false);
    await expect((tool as ReturnType<typeof createWriteFileTool>).execute({ path: "registry.txt", content: "ok" })).resolves.toBe(
      `wrote 2 bytes to ${path.join(dir, "registry.txt")}`
    );
  });
});

interface PreviewableWriteFileTool {
  execute(args: unknown): Promise<string> | string;
  preview(args: unknown): Promise<PreviewChange> | PreviewChange;
}

interface PreviewChange {
  path: string;
  kind: "create" | "modify" | "delete";
  oldText: string;
  newText: string;
  added: number;
  removed: number;
  diff: string;
  binary: boolean;
}

function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "reasonix-write-file-"));
}

function encodeUtf16(text: string, endian: "le" | "be", withBom: boolean): Buffer {
  const body = Buffer.from(text, "utf16le");
  const out = Buffer.alloc(body.length);
  for (let index = 0; index < body.length; index += 2) {
    out[index] = endian === "le" ? body[index] : body[index + 1];
    out[index + 1] = endian === "le" ? body[index + 1] : body[index];
  }
  return withBom ? Buffer.concat([Buffer.from(endian === "le" ? [0xff, 0xfe] : [0xfe, 0xff]), out]) : out;
}
