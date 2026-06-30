import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Reasonix edit_file tool parity", () => {
  it("exposes execute and preview on the concrete edit_file tool while provider definitions stay schema-only", async () => {
    const { createEditFileTool, Registry, Workspace } = await import("../index");
    const dir = await tempDir();
    const workspace = new Workspace({ dir });
    const [definition] = workspace.tools(["edit_file"]);
    const tool = createEditFileTool(workspace);
    const registry = new Registry();
    registry.add(tool);

    expect("execute" in definition).toBe(false);
    expect("preview" in definition).toBe(false);
    expect(typeof tool.execute).toBe("function");
    expect(typeof (tool as PreviewableEditFileTool).preview).toBe("function");
    expect(registry.schemas()[0]).toMatchObject({
      name: "edit_file",
      parameters: {
        required: ["new_string", "old_string", "path"],
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" }
        }
      }
    });
    expect("preview" in registry.schemas()[0]).toBe(false);
  });

  it("edits exactly once, deletes with empty or missing new_string, and leaves files unchanged on errors", async () => {
    const { createEditFileTool, Workspace } = await import("../index");
    const dir = await tempDir();
    const target = path.join(dir, "notes.txt");
    await writeFile(target, "hello world\nkeep\n", "utf8");
    const tool = createEditFileTool(new Workspace({ dir }));

    await expect(tool.execute({ path: "notes.txt", old_string: "world", new_string: "reasonix" })).resolves.toBe(
      `edited ${target}`
    );
    await expect(readFile(target, "utf8")).resolves.toBe("hello reasonix\nkeep\n");

    await expect(tool.execute({ path: "notes.txt", old_string: "hello reasonix\n" })).resolves.toBe(`edited ${target}`);
    await expect(readFile(target, "utf8")).resolves.toBe("keep\n");

    await expect(tool.execute({ path: "notes.txt", old_string: "missing", new_string: "x" })).rejects.toThrow(
      `old_string not found in ${target}`
    );
    await expect(readFile(target, "utf8")).resolves.toBe("keep\n");

    await writeFile(target, "x x x", "utf8");
    await expect(tool.execute({ path: "notes.txt", old_string: "x", new_string: "y" })).rejects.toThrow(
      `old_string is not unique in ${target} (3 matches); add more surrounding context`
    );
    await expect(readFile(target, "utf8")).resolves.toBe("x x x");
  });

  it("formats missing file, required field, and Go-style JSON errors like Reasonix", async () => {
    const { createEditFileTool, Workspace } = await import("../index");
    const dir = await tempDir();
    const target = path.join(dir, "a.txt");
    await writeFile(target, "content", "utf8");
    const missing = path.join(dir, "missing.txt");
    const tool = createEditFileTool(new Workspace({ dir }));
    const goEditStruct =
      'struct { Path string "json:\\"path\\""; OldString string "json:\\"old_string\\""; NewString string "json:\\"new_string\\"" }';

    await expect(tool.execute({ path: "missing.txt", old_string: "x", new_string: "y" })).rejects.toThrow(
      `read ${missing}: open ${missing}: no such file or directory`
    );
    await expect(tool.execute({ old_string: "x", new_string: "y" })).rejects.toThrow("path is required");
    await expect(tool.execute({ path: "a.txt", new_string: "y" })).rejects.toThrow("old_string is required");
    await expect(tool.execute("null")).rejects.toThrow("path is required");
    await expect(tool.execute("{invalid")).rejects.toThrow("invalid args: invalid character 'i' looking for beginning of object key string");
    await expect(tool.execute("1")).rejects.toThrow(`invalid args: json: cannot unmarshal number into Go value of type ${goEditStruct}`);
    await expect(tool.execute('{"Path":"a.txt","OLD_STRING":"content","NEW_STRING":"ok"}')).resolves.toBe(`edited ${target}`);
    await expect(readFile(target, "utf8")).resolves.toBe("ok");
    await expect(tool.execute('{"path":1,"path":"a.txt","old_string":"ok","new_string":"x"}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal number into Go struct field .path of type string"
    );
    await expect(tool.execute('{"path":"a.txt","old_string":1,"old_string":"ok","new_string":"x"}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal number into Go struct field .old_string of type string"
    );
    await expect(tool.execute({ path: "a.txt", old_string: "ok", new_string: 1 })).rejects.toThrow(
      "invalid args: json: cannot unmarshal number into Go struct field .new_string of type string"
    );
  });

  it("matches Go raw JSON null no-op semantics for duplicate string fields", async () => {
    const { createEditFileTool, Workspace } = await import("../index");
    const dir = await tempDir();
    const target = path.join(dir, "a.txt");
    const tool = createEditFileTool(new Workspace({ dir }));

    await writeFile(target, "alpha beta", "utf8");
    await expect(tool.execute('{"path":"a.txt","path":null,"old_string":"alpha","new_string":"ALPHA"}')).resolves.toBe(
      `edited ${target}`
    );
    await expect(readFile(target, "utf8")).resolves.toBe("ALPHA beta");

    await writeFile(target, "alpha beta", "utf8");
    await expect(tool.execute('{"path":"a.txt","old_string":"alpha","old_string":null,"new_string":"ALPHA"}')).resolves.toBe(
      `edited ${target}`
    );
    await expect(readFile(target, "utf8")).resolves.toBe("ALPHA beta");

    await writeFile(target, "alpha beta", "utf8");
    await expect(tool.execute('{"path":"a.txt","old_string":"alpha","new_string":"ALPHA","new_string":null}')).resolves.toBe(
      `edited ${target}`
    );
    await expect(readFile(target, "utf8")).resolves.toBe("ALPHA beta");

    await writeFile(target, "alpha beta", "utf8");
    await expect(tool.execute('{"path":"a.txt","old_string":"alpha","new_string":null}')).resolves.toBe(`edited ${target}`);
    await expect(readFile(target, "utf8")).resolves.toBe(" beta");

    await writeFile(target, "alpha beta", "utf8");
    await expect(tool.execute('{"path":null,"old_string":"alpha","new_string":"ALPHA"}')).rejects.toThrow("path is required");
    await expect(tool.execute('{"path":"a.txt","old_string":null,"new_string":"ALPHA"}')).rejects.toThrow("old_string is required");
    await expect(tool.execute('{"path":1,"path":null,"old_string":"alpha","new_string":"ALPHA"}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal number into Go struct field .path of type string"
    );
    await expect(tool.execute('{"path":"a.txt","old_string":1,"old_string":null,"new_string":"ALPHA"}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal number into Go struct field .old_string of type string"
    );
    await expect(tool.execute('{"path":"a.txt","old_string":"alpha","new_string":1,"new_string":null}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal number into Go struct field .new_string of type string"
    );
    await expect(readFile(target, "utf8")).resolves.toBe("alpha beta");
  });

  it("binds workspace-relative paths, confines execute writes, and lets preview resolve without write-root confinement", async () => {
    const { createEditFileTool, Workspace } = await import("../index");
    const dir = await tempDir();
    const outsideDir = await tempDir();
    const outside = path.join(outsideDir, "outside.txt");
    await writeFile(path.join(dir, "inside.txt"), "inside", "utf8");
    await writeFile(outside, "outside", "utf8");
    const tool = createEditFileTool(new Workspace({ dir })) as PreviewableEditFileTool;

    await expect(tool.execute({ path: "inside.txt", old_string: "inside", new_string: "ok" })).resolves.toBe(
      `edited ${path.join(dir, "inside.txt")}`
    );
    await expect(tool.execute({ path: outside, old_string: "outside", new_string: "blocked" })).rejects.toThrow(/outside the writable roots/u);

    const change = await tool.preview({ path: outside, old_string: "outside", new_string: "preview-only" });
    expect(change).toMatchObject({
      path: outside,
      kind: "modify",
      oldText: "outside",
      newText: "preview-only"
    });
    await expect(readFile(outside, "utf8")).resolves.toBe("outside");
  });

  it("preserves CRLF, LF, GB18030 CRLF, and UTF-16 encodings", async () => {
    const { createEditFileTool, Workspace } = await import("../index");
    const dir = await tempDir();
    const tool = createEditFileTool(new Workspace({ dir }));

    await writeFile(path.join(dir, "win.txt"), "one\r\ntwo\r\nthree\r\n", "utf8");
    await tool.execute({ path: "win.txt", old_string: "one\ntwo", new_string: "ONE\nTWO" });
    await expect(readFile(path.join(dir, "win.txt"), "utf8")).resolves.toBe("ONE\r\nTWO\r\nthree\r\n");

    await writeFile(path.join(dir, "lf.txt"), "alpha\nbeta\ngamma\n", "utf8");
    await tool.execute({ path: "lf.txt", old_string: "alpha\nbeta", new_string: "ALPHA\nBETA" });
    await expect(readFile(path.join(dir, "lf.txt"), "utf8")).resolves.toBe("ALPHA\nBETA\ngamma\n");

    const gbkPath = path.join(dir, "gbk.txt");
    await writeFile(gbkPath, Buffer.from([181, 218, 210, 187, 208, 208, 32, 104, 101, 108, 108, 111, 13, 10, 181, 218, 182, 254, 208, 208, 32, 119, 111, 114, 108, 100, 13, 10]));
    await tool.execute({ path: "gbk.txt", old_string: "第一行 hello\n第二行 world", new_string: "第一行 HELLO\n第二行 WORLD" });
    const gbkRaw = await readFile(gbkPath);
    expect(new TextDecoder("gb18030", { fatal: true }).decode(gbkRaw)).toBe("第一行 HELLO\r\n第二行 WORLD\r\n");

    const utf16Path = path.join(dir, "utf16le.txt");
    await writeFile(utf16Path, encodeUtf16("before\n", "le", true));
    await tool.execute({ path: "utf16le.txt", old_string: "before", new_string: "after" });
    expect(await readFile(utf16Path)).toEqual(encodeUtf16("after\n", "le", true));
  });

  it("preserves untouched LossyUTF8 bytes while applying local edits", async () => {
    const { createEditFileTool, Workspace } = await import("../index");
    const dir = await tempDir();
    const target = path.join(dir, "lossy.bin");
    const previewTarget = path.join(dir, "lossy-preview.bin");
    const original = Buffer.from([0x61, 0xff, 0x62, 0x20, ...Buffer.from("target c")]);
    await writeFile(target, original);
    await writeFile(previewTarget, original);
    const expected = Buffer.from([0x61, 0xff, 0x62, 0x20, ...Buffer.from("TARGET c")]);
    const tool = createEditFileTool(new Workspace({ dir })) as PreviewableEditFileTool;

    const change = await tool.preview({ path: "lossy-preview.bin", old_string: "target", new_string: "TARGET" });
    expect(Buffer.from(change.newText, "latin1")).toEqual(expected);
    expect(await readFile(previewTarget)).toEqual(original);

    await tool.execute({ path: "lossy.bin", old_string: "target", new_string: "TARGET" });

    expect(await readFile(target)).toEqual(expected);
  });

  it("supports fuzzy edit modes, reports fuzzy output, and never writes ambiguous or leading-indent drift matches", async () => {
    const { createEditFileTool, Workspace } = await import("../index");
    const dir = await tempDir();
    const tool = createEditFileTool(new Workspace({ dir }));

    await writeFile(path.join(dir, "fuzzy.txt"), "func main() {   \n\tfmt.Println(\"hello\")  \n}\n", "utf8");
    await expect(
      tool.execute({
        path: "fuzzy.txt",
        old_string: "func main() {\n\tfmt.Println(\"hello\")\n}",
        new_string: "func main() {\n\tfmt.Println(\"bye\")\n}"
      })
    ).resolves.toBe(`edited ${path.join(dir, "fuzzy.txt")} (fuzzy match)`);
    await expect(readFile(path.join(dir, "fuzzy.txt"), "utf8")).resolves.toBe("func main() {\n\tfmt.Println(\"bye\")\n}\n");

    await writeFile(path.join(dir, "prefixed.txt"), "alpha\nbeta\ngamma\n", "utf8");
    await tool.execute({ path: "prefixed.txt", old_string: "1\u2192alpha\n2\u2192beta", new_string: "ALPHA\nBETA" });
    await expect(readFile(path.join(dir, "prefixed.txt"), "utf8")).resolves.toBe("ALPHA\nBETA\ngamma\n");

    await writeFile(path.join(dir, "dup.txt"), "target   \ntarget   \n", "utf8");
    await expect(tool.execute({ path: "dup.txt", old_string: "target\n", new_string: "updated\n" })).rejects.toThrow(
      `old_string is not unique in ${path.join(dir, "dup.txt")} (2 matches); add more surrounding context`
    );
    await expect(readFile(path.join(dir, "dup.txt"), "utf8")).resolves.toBe("target   \ntarget   \n");

    await writeFile(path.join(dir, "indent.go"), "func f() {\n    if ok {\n        return nil\n    }\n}\n", "utf8");
    await expect(
      tool.execute({ path: "indent.go", old_string: "if ok {\n    return nil\n}", new_string: "if ok {\n    return err\n}" })
    ).rejects.toThrow(`old_string not found in ${path.join(dir, "indent.go")}`);
    await expect(readFile(path.join(dir, "indent.go"), "utf8")).resolves.toBe(
      "func f() {\n    if ok {\n        return nil\n    }\n}\n"
    );
  });

  it("previews without side effects, mirrors execute errors, and matches execute output for exact and fuzzy edits", async () => {
    const { createEditFileTool, Workspace } = await import("../index");
    const dir = await tempDir();
    const tool = createEditFileTool(new Workspace({ dir })) as PreviewableEditFileTool;
    const previewPath = path.join(dir, "preview.txt");
    const executePath = path.join(dir, "execute.txt");
    await writeFile(previewPath, "one\ntwo\nthree\n", "utf8");
    await writeFile(executePath, "one\ntwo\nthree\n", "utf8");

    const change = await tool.preview({ path: "preview.txt", old_string: "two", new_string: "TWO" });
    expect(change).toMatchObject({
      path: previewPath,
      kind: "modify",
      oldText: "one\ntwo\nthree\n",
      newText: "one\nTWO\nthree\n",
      added: 1,
      removed: 1,
      binary: false
    });
    await expect(readFile(previewPath, "utf8")).resolves.toBe("one\ntwo\nthree\n");
    await tool.execute({ path: "execute.txt", old_string: "two", new_string: "TWO" });
    await expect(readFile(executePath, "utf8")).resolves.toBe(change.newText);

    await writeFile(path.join(dir, "preview-fuzzy.txt"), "alpha   \nbeta   \n", "utf8");
    await writeFile(path.join(dir, "execute-fuzzy.txt"), "alpha   \nbeta   \n", "utf8");
    const fuzzy = await tool.preview({ path: "preview-fuzzy.txt", old_string: "alpha\nbeta", new_string: "ALPHA\nBETA" });
    await tool.execute({ path: "execute-fuzzy.txt", old_string: "alpha\nbeta", new_string: "ALPHA\nBETA" });
    await expect(readFile(path.join(dir, "execute-fuzzy.txt"), "utf8")).resolves.toBe(fuzzy.newText);
    await expect(readFile(path.join(dir, "preview-fuzzy.txt"), "utf8")).resolves.toBe("alpha   \nbeta   \n");

    await expect(tool.preview({ path: "preview.txt", old_string: "missing", new_string: "x" })).rejects.toThrow(
      `old_string not found in ${previewPath}`
    );
    await expect(tool.preview({ path: "missing.txt", old_string: "x", new_string: "y" })).rejects.toThrow(
      `read ${path.join(dir, "missing.txt")}: open ${path.join(dir, "missing.txt")}: no such file or directory`
    );
  });
});

interface PreviewableEditFileTool {
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
  return mkdtemp(path.join(os.tmpdir(), "reasonix-edit-file-"));
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
