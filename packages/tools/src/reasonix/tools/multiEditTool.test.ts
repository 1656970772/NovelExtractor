import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Reasonix multi_edit tool parity", () => {
  it("exposes execute and preview on the concrete multi_edit tool while provider definitions stay schema-only", async () => {
    const { createMultiEditTool, Registry, Workspace } = await import("../index");
    const dir = await tempDir();
    const workspace = new Workspace({ dir });
    const [definition] = workspace.tools(["multi_edit"]);
    const tool = createMultiEditTool(workspace);
    const registry = new Registry();
    registry.add(tool);

    expect("execute" in definition).toBe(false);
    expect("preview" in definition).toBe(false);
    expect(typeof tool.execute).toBe("function");
    expect(typeof (tool as PreviewableMultiEditTool).preview).toBe("function");
    expect(registry.schemas()[0]).toMatchObject({
      name: "multi_edit",
      parameters: {
        required: ["edits", "path"],
        properties: {
          path: { type: "string" },
          edits: {
            type: "array",
            minItems: 1,
            items: {
              required: ["new_string", "old_string"],
              properties: {
                old_string: { type: "string" },
                new_string: { type: "string" },
                replace_all: { type: "boolean" }
              }
            }
          }
        }
      }
    });
    expect("preview" in registry.schemas()[0]).toBe(false);
  });

  it("formats required field, empty edits, and Go-style JSON errors like Reasonix", async () => {
    const { createMultiEditTool, Workspace } = await import("../index");
    const dir = await tempDir();
    const target = path.join(dir, "a.txt");
    await writeFile(target, "content", "utf8");
    const tool = createMultiEditTool(new Workspace({ dir }));
    const goMultiEditStruct =
      'struct { Path string "json:\\"path\\""; Edits []builtin.editStep "json:\\"edits\\"" }';

    await expect(tool.execute({ edits: [{ old_string: "content", new_string: "ok" }] })).rejects.toThrow("path is required");
    await expect(tool.execute({ path: "a.txt" })).rejects.toThrow("edits must not be empty");
    await expect(tool.execute({ path: "a.txt", edits: null })).rejects.toThrow("edits must not be empty");
    await expect(tool.execute({ path: "a.txt", edits: [] })).rejects.toThrow("edits must not be empty");
    await expect(tool.execute({ path: "a.txt", edits: [{ new_string: "x" }] })).rejects.toThrow(
      "edit 1: old_string is required"
    );
    await expect(tool.execute({ path: "a.txt", edits: [null] })).rejects.toThrow("edit 1: old_string is required");
    await expect(tool.execute("{invalid")).rejects.toThrow("invalid args: invalid character 'i' looking for beginning of object key string");
    await expect(tool.execute("1")).rejects.toThrow(`invalid args: json: cannot unmarshal number into Go value of type ${goMultiEditStruct}`);
    await expect(tool.execute("[]")).rejects.toThrow(`invalid args: json: cannot unmarshal array into Go value of type ${goMultiEditStruct}`);
    await expect(tool.execute("true")).rejects.toThrow(`invalid args: json: cannot unmarshal bool into Go value of type ${goMultiEditStruct}`);

    await expect(tool.execute('{"path":1,"edits":[]}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal number into Go struct field .path of type string"
    );
    await expect(tool.execute('{"path":"a.txt","edits":1}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal number into Go struct field .edits of type []builtin.editStep"
    );
    await expect(tool.execute('{"path":"a.txt","edits":[1]}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal number into Go struct field .edits of type builtin.editStep"
    );
    await expect(tool.execute('{"path":"a.txt","edits":[{"old_string":1,"new_string":"x"}]}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal number into Go struct field .edits.old_string of type string"
    );
    await expect(tool.execute({ path: "a.txt", edits: [{ old_string: "content", new_string: "x", replace_all: 1 }] })).rejects.toThrow(
      "invalid args: json: cannot unmarshal number into Go struct field .edits.replace_all of type bool"
    );

    await expect(tool.execute('{"Path":"a.txt","EDITS":[{"OLD_STRING":"content","NEW_STRING":"ok"}]}')).resolves.toBe(
      `multi_edit ${target}: 1 edits applied (1 total replacements)`
    );
    await expect(readFile(target, "utf8")).resolves.toBe("ok");

    await expect(tool.execute('{"path":1,"path":"a.txt","edits":[{"old_string":"ok","new_string":"x"}]}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal number into Go struct field .path of type string"
    );
    await expect(tool.execute('{"path":"a.txt","edits":[{"old_string":1,"old_string":"ok","new_string":"x"}]}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal number into Go struct field .edits.old_string of type string"
    );
  });

  it("matches Go raw JSON null handling for repeated multi_edit fields", async () => {
    const { createMultiEditTool, Workspace } = await import("../index");
    const dir = await tempDir();
    const target = path.join(dir, "a.txt");
    const tool = createMultiEditTool(new Workspace({ dir }));

    await writeFile(target, "alpha beta", "utf8");
    await expect(
      tool.execute('{"path":"a.txt","path":null,"edits":[{"old_string":"alpha","new_string":"ALPHA"}]}')
    ).resolves.toBe(`multi_edit ${target}: 1 edits applied (1 total replacements)`);
    await expect(readFile(target, "utf8")).resolves.toBe("ALPHA beta");

    await writeFile(target, "alpha beta", "utf8");
    await expect(tool.execute('{"path":null,"edits":[{"old_string":"alpha","new_string":"ALPHA"}]}')).rejects.toThrow(
      "path is required"
    );
    await expect(readFile(target, "utf8")).resolves.toBe("alpha beta");

    await writeFile(target, "alpha beta", "utf8");
    await expect(
      tool.execute('{"path":"a.txt","edits":[{"old_string":"alpha","old_string":null,"new_string":"ALPHA"}]}')
    ).resolves.toBe(`multi_edit ${target}: 1 edits applied (1 total replacements)`);
    await expect(readFile(target, "utf8")).resolves.toBe("ALPHA beta");

    await writeFile(target, "alpha beta", "utf8");
    await expect(tool.execute('{"path":"a.txt","edits":[{"old_string":null,"new_string":"ALPHA"}]}')).rejects.toThrow(
      "edit 1: old_string is required"
    );
    await expect(readFile(target, "utf8")).resolves.toBe("alpha beta");

    await writeFile(target, "alpha beta", "utf8");
    await expect(
      tool.execute('{"path":"a.txt","edits":[{"old_string":"alpha","new_string":"ALPHA","new_string":null}]}')
    ).resolves.toBe(`multi_edit ${target}: 1 edits applied (1 total replacements)`);
    await expect(readFile(target, "utf8")).resolves.toBe("ALPHA beta");

    await writeFile(target, "alpha beta", "utf8");
    await expect(tool.execute('{"path":"a.txt","edits":[{"old_string":"alpha","new_string":null}]}')).resolves.toBe(
      `multi_edit ${target}: 1 edits applied (1 total replacements)`
    );
    await expect(readFile(target, "utf8")).resolves.toBe(" beta");

    await writeFile(target, "alpha alpha", "utf8");
    await expect(
      tool.execute('{"path":"a.txt","edits":[{"old_string":"alpha","new_string":"ALPHA","replace_all":true,"replace_all":null}]}')
    ).resolves.toBe(`multi_edit ${target}: 1 edits applied (2 total replacements)`);
    await expect(readFile(target, "utf8")).resolves.toBe("ALPHA ALPHA");

    await writeFile(target, "alpha alpha", "utf8");
    await expect(
      tool.execute('{"path":"a.txt","edits":[{"old_string":"alpha","new_string":"ALPHA","replace_all":null}]}')
    ).rejects.toThrow("edit 1: old_string is not unique; add more surrounding context or set replace_all");
    await expect(readFile(target, "utf8")).resolves.toBe("alpha alpha");

    await writeFile(target, "alpha beta", "utf8");
    await expect(tool.execute('{"path":"a.txt","edits":null}')).rejects.toThrow("edits must not be empty");
    await expect(readFile(target, "utf8")).resolves.toBe("alpha beta");

    await writeFile(target, "alpha beta", "utf8");
    await expect(tool.execute('{"path":"a.txt","edits":[{"old_string":"alpha","new_string":"ALPHA"}],"edits":null}')).rejects.toThrow(
      "edits must not be empty"
    );
    await expect(readFile(target, "utf8")).resolves.toBe("alpha beta");
  });

  it("applies chained edits in memory, counts replacements, and leaves the file untouched on any step error", async () => {
    const { createMultiEditTool, Workspace } = await import("../index");
    const dir = await tempDir();
    const target = path.join(dir, "code.go");
    const seed = "package old\n\nfunc old() {\n\told()\n}\n";
    await writeFile(target, seed, "utf8");
    const tool = createMultiEditTool(new Workspace({ dir }));

    await expect(
      tool.execute({
        path: "code.go",
        edits: [
          { old_string: "package old", new_string: "package new" },
          { old_string: "old", new_string: "reasonix", replace_all: true }
        ]
      })
    ).resolves.toBe(`multi_edit ${target}: 2 edits applied (3 total replacements)`);
    await expect(readFile(target, "utf8")).resolves.toBe("package new\n\nfunc reasonix() {\n\treasonix()\n}\n");

    await writeFile(target, "alpha\nbeta\n", "utf8");
    await expect(
      tool.execute({
        path: "code.go",
        edits: [
          { old_string: "alpha", new_string: "ALPHA" },
          { old_string: "missing", new_string: "x" }
        ]
      })
    ).rejects.toThrow("edit 2: old_string not found");
    await expect(readFile(target, "utf8")).resolves.toBe("alpha\nbeta\n");

    await writeFile(target, "x x x", "utf8");
    await expect(tool.execute({ path: "code.go", edits: [{ old_string: "x", new_string: "y" }] })).rejects.toThrow(
      "edit 1: old_string is not unique; add more surrounding context or set replace_all"
    );
    await expect(readFile(target, "utf8")).resolves.toBe("x x x");

    await expect(tool.execute({ path: "code.go", edits: [{ old_string: "missing", new_string: "y", replace_all: true }] })).rejects.toThrow(
      "edit 1: old_string not found"
    );
    await expect(readFile(target, "utf8")).resolves.toBe("x x x");
  });

  it("preserves CRLF and supports fuzzy replace_all without accepting ambiguous indentation drift", async () => {
    const { createMultiEditTool, Workspace } = await import("../index");
    const dir = await tempDir();
    const tool = createMultiEditTool(new Workspace({ dir }));

    await writeFile(path.join(dir, "win.txt"), "one\r\ntwo\r\nthree\r\nfour\r\n", "utf8");
    await expect(
      tool.execute({
        path: "win.txt",
        edits: [
          { old_string: "one\ntwo", new_string: "ONE\nTWO" },
          { old_string: "three", new_string: "THREE" }
        ]
      })
    ).resolves.toBe(`multi_edit ${path.join(dir, "win.txt")}: 2 edits applied (2 total replacements)`);
    await expect(readFile(path.join(dir, "win.txt"), "utf8")).resolves.toBe("ONE\r\nTWO\r\nTHREE\r\nfour\r\n");

    await writeFile(path.join(dir, "list.txt"), "item   \nitem\t\n", "utf8");
    await expect(
      tool.execute({ path: "list.txt", edits: [{ old_string: "item\n", new_string: "thing\n", replace_all: true }] })
    ).resolves.toBe(`multi_edit ${path.join(dir, "list.txt")}: 1 edits applied (2 total replacements) (fuzzy match)`);
    await expect(readFile(path.join(dir, "list.txt"), "utf8")).resolves.toBe("thing\nthing\n");

    await writeFile(path.join(dir, "indent.go"), "func f() {\n    if ok {\n        return nil\n    }\n}\n", "utf8");
    await expect(
      tool.execute({
        path: "indent.go",
        edits: [{ old_string: "if ok {\n    return nil\n}", new_string: "if ok {\n    return err\n}" }]
      })
    ).rejects.toThrow("edit 1: old_string not found");
    await expect(readFile(path.join(dir, "indent.go"), "utf8")).resolves.toBe(
      "func f() {\n    if ok {\n        return nil\n    }\n}\n"
    );
  });

  it("binds workspace-relative paths, confines execute writes, and lets preview read outside without write-root confinement", async () => {
    const { createMultiEditTool, Workspace } = await import("../index");
    const dir = await tempDir();
    const outsideDir = await tempDir();
    const outside = path.join(outsideDir, "outside.txt");
    await writeFile(path.join(dir, "inside.txt"), "inside", "utf8");
    await writeFile(outside, "outside", "utf8");
    const tool = createMultiEditTool(new Workspace({ dir })) as PreviewableMultiEditTool;

    await expect(tool.execute({ path: "inside.txt", edits: [{ old_string: "inside", new_string: "ok" }] })).resolves.toBe(
      `multi_edit ${path.join(dir, "inside.txt")}: 1 edits applied (1 total replacements)`
    );
    await expect(tool.execute({ path: outside, edits: [{ old_string: "outside", new_string: "blocked" }] })).rejects.toThrow(
      /outside the writable roots/u
    );

    const change = await tool.preview({ path: outside, edits: [{ old_string: "outside", new_string: "preview-only" }] });
    expect(change).toMatchObject({
      path: outside,
      kind: "modify",
      oldText: "outside",
      newText: "preview-only"
    });
    await expect(readFile(outside, "utf8")).resolves.toBe("outside");
  });

  it("preserves GB18030, UTF-16, and LossyUTF8 raw bytes while applying multi-step edits", async () => {
    const { createMultiEditTool, Workspace } = await import("../index");
    const dir = await tempDir();
    const tool = createMultiEditTool(new Workspace({ dir })) as PreviewableMultiEditTool;

    const gbkPath = path.join(dir, "gbk.txt");
    await writeFile(gbkPath, Buffer.from([181, 218, 210, 187, 208, 208, 32, 104, 101, 108, 108, 111, 13, 10, 181, 218, 182, 254, 208, 208, 32, 119, 111, 114, 108, 100, 13, 10]));
    await tool.execute({
      path: "gbk.txt",
      edits: [{ old_string: "第一行 hello\n第二行 world", new_string: "第一行 HELLO\n第二行 WORLD" }]
    });
    const gbkRaw = await readFile(gbkPath);
    expect(new TextDecoder("gb18030", { fatal: true }).decode(gbkRaw)).toBe("第一行 HELLO\r\n第二行 WORLD\r\n");

    const utf16Path = path.join(dir, "utf16le.txt");
    await writeFile(utf16Path, encodeUtf16("before\nagain\n", "le", true));
    await tool.execute({
      path: "utf16le.txt",
      edits: [
        { old_string: "before", new_string: "after" },
        { old_string: "again", new_string: "done" }
      ]
    });
    expect(await readFile(utf16Path)).toEqual(encodeUtf16("after\ndone\n", "le", true));

    const lossyPath = path.join(dir, "lossy.bin");
    const lossyPreviewPath = path.join(dir, "lossy-preview.bin");
    const original = Buffer.from([0x61, 0xff, 0x62, 0x20, ...Buffer.from("target c target")]);
    const expected = Buffer.from([0x61, 0xff, 0x62, 0x20, ...Buffer.from("TARGET c done")]);
    await writeFile(lossyPath, original);
    await writeFile(lossyPreviewPath, original);

    const change = await tool.preview({
      path: "lossy-preview.bin",
      edits: [
        { old_string: "target c", new_string: "TARGET c" },
        { old_string: "target", new_string: "done" }
      ]
    });
    expect(Buffer.from(change.newText, "latin1")).toEqual(expected);
    await expect(readFile(lossyPreviewPath)).resolves.toEqual(original);

    await tool.execute({
      path: "lossy.bin",
      edits: [
        { old_string: "target c", new_string: "TARGET c" },
        { old_string: "target", new_string: "done" }
      ]
    });
    expect(await readFile(lossyPath)).toEqual(expected);
  });

  it("previews without side effects, mirrors execute errors, and matches execute output for exact and fuzzy batches", async () => {
    const { createMultiEditTool, Workspace } = await import("../index");
    const dir = await tempDir();
    const tool = createMultiEditTool(new Workspace({ dir })) as PreviewableMultiEditTool;

    await writeFile(path.join(dir, "preview.txt"), "package old\n\nfunc old() {\n\told()\n}\n", "utf8");
    await writeFile(path.join(dir, "execute.txt"), "package old\n\nfunc old() {\n\told()\n}\n", "utf8");
    const args = (file: string) => ({
      path: file,
      edits: [
        { old_string: "package old", new_string: "package new" },
        { old_string: "old", new_string: "reasonix", replace_all: true }
      ]
    });

    const change = await tool.preview(args("preview.txt"));
    expect(change).toMatchObject({
      path: path.join(dir, "preview.txt"),
      kind: "modify",
      oldText: "package old\n\nfunc old() {\n\told()\n}\n",
      newText: "package new\n\nfunc reasonix() {\n\treasonix()\n}\n",
      added: 3,
      removed: 3,
      binary: false
    });
    await expect(readFile(path.join(dir, "preview.txt"), "utf8")).resolves.toBe("package old\n\nfunc old() {\n\told()\n}\n");
    await tool.execute(args("execute.txt"));
    await expect(readFile(path.join(dir, "execute.txt"), "utf8")).resolves.toBe(change.newText);

    await writeFile(path.join(dir, "preview-fuzzy.txt"), "item   \nitem\t\n", "utf8");
    await writeFile(path.join(dir, "execute-fuzzy.txt"), "item   \nitem\t\n", "utf8");
    const fuzzy = await tool.preview({
      path: "preview-fuzzy.txt",
      edits: [{ old_string: "item\n", new_string: "thing\n", replace_all: true }]
    });
    await tool.execute({ path: "execute-fuzzy.txt", edits: [{ old_string: "item\n", new_string: "thing\n", replace_all: true }] });
    await expect(readFile(path.join(dir, "execute-fuzzy.txt"), "utf8")).resolves.toBe(fuzzy.newText);
    await expect(readFile(path.join(dir, "preview-fuzzy.txt"), "utf8")).resolves.toBe("item   \nitem\t\n");

    await expect(tool.preview({ path: "preview.txt", edits: [{ old_string: "missing", new_string: "x" }] })).rejects.toThrow(
      "edit 1: old_string not found"
    );
    await expect(tool.preview({ path: "missing.txt", edits: [{ old_string: "x", new_string: "y" }] })).rejects.toThrow(
      `read ${path.join(dir, "missing.txt")}: open ${path.join(dir, "missing.txt")}: no such file or directory`
    );
  });
});

interface PreviewableMultiEditTool {
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
  return mkdtemp(path.join(os.tmpdir(), "reasonix-multi-edit-"));
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
