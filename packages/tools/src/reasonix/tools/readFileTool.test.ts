import fs from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

describe("Reasonix read_file tool parity", () => {
  it("formats line-numbered text windows and pagination hints like Reasonix", async () => {
    const { createReadFileTool } = await import("./readFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();
    const file = path.join(dir, "many.txt");
    await writeFile(file, Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n") + "\n", "utf8");

    const tool = createReadFileTool(new Workspace({ dir }));
    await expect(tool.execute({ path: "many.txt", offset: 10, limit: 5 })).resolves.toBe(
      "11→line 11\n12→line 12\n13→line 13\n14→line 14\n15→line 15\n\n[more lines below; pass offset=15 to continue]\n"
    );
  });

  it("handles empty files, offset past EOF, negative offset, and nonpositive limit", async () => {
    const { createReadFileTool } = await import("./readFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();
    await writeFile(path.join(dir, "empty.txt"), "");
    await writeFile(path.join(dir, "short.txt"), "one\ntwo\n", "utf8");

    const tool = createReadFileTool(new Workspace({ dir }));
    await expect(tool.execute({ path: "empty.txt" })).resolves.toBe("(empty file)");
    await expect(tool.execute({ path: "short.txt", offset: 100, limit: 10 })).resolves.toBe(
      "(offset 100 is past EOF — file has 2 lines)"
    );
    await expect(tool.execute({ path: "short.txt", offset: -5, limit: 0 })).resolves.toContain("1→one");
  });

  it("preserves final bare CR while stripping CR from CRLF lines like bufio.ScanLines", async () => {
    const { createReadFileTool } = await import("./readFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();
    await writeFile(path.join(dir, "raw-final-cr.txt"), Buffer.from("foo\r", "binary"));
    await writeFile(path.join(dir, "raw-crlf.txt"), Buffer.from("foo\r\n", "binary"));
    await writeFile(path.join(dir, "utf16-final-cr.txt"), encodeUtf16("foo\r", "le", true));
    await writeFile(path.join(dir, "utf16-crlf.txt"), encodeUtf16("foo\r\n", "le", true));

    const tool = createReadFileTool(new Workspace({ dir }));
    await expect(tool.execute({ path: "raw-final-cr.txt" })).resolves.toBe("1→foo\r\n");
    await expect(tool.execute({ path: "raw-crlf.txt" })).resolves.toBe("1→foo\n");
    await expect(tool.execute({ path: "utf16-final-cr.txt" })).resolves.toBe("1→foo\r\n");
    await expect(tool.execute({ path: "utf16-crlf.txt" })).resolves.toBe("1→foo\n");
  });

  it("returns Reasonix-compatible argument and filesystem errors", async () => {
    const { createReadFileTool } = await import("./readFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();
    await mkdir(path.join(dir, "folder"));
    const missing = path.join(dir, "missing.txt");

    const tool = createReadFileTool(new Workspace({ dir }));
    await expect(tool.execute("{invalid")).rejects.toThrow(/^invalid args: /u);
    await expect(tool.execute({})).rejects.toThrow("path is required");
    await expect(tool.execute({ path: "folder" })).rejects.toThrow(
      `${path.join(dir, "folder")} is a directory, not a file — use the ls tool to list it, or read a specific file inside it`
    );
    await expect(tool.execute({ path: "missing.txt" })).rejects.toThrow(
      `read ${missing}: open ${missing}: no such file or directory`
    );
  });

  it("treats JSON null args like Reasonix zero values", async () => {
    const { createReadFileTool } = await import("./readFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();
    await writeFile(path.join(dir, "short.txt"), "one\ntwo\n", "utf8");

    const tool = createReadFileTool(new Workspace({ dir }));
    await expect(tool.execute("null")).rejects.toThrow("path is required");
    await expect(tool.execute(null)).rejects.toThrow("path is required");
    await expect(tool.execute({ path: null })).rejects.toThrow("path is required");
    await expect(tool.execute({ path: "short.txt", offset: null, limit: null })).resolves.toBe("1→one\n2→two\n");
  });

  it("matches Go raw JSON null no-op semantics for duplicate struct fields", async () => {
    const { createReadFileTool } = await import("./readFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();
    await writeFile(path.join(dir, "short.txt"), "one\ntwo\nthree\n", "utf8");

    const tool = createReadFileTool(new Workspace({ dir }));
    await expect(tool.execute('{"path":"short.txt","path":null}')).resolves.toBe("1→one\n2→two\n3→three\n");
    await expect(tool.execute('{"path":null,"path":"short.txt","limit":1}')).resolves.toBe(
      "1→one\n\n[more lines below; pass offset=1 to continue]\n"
    );
    await expect(tool.execute('{"path":"short.txt","offset":1,"offset":null,"limit":1}')).resolves.toBe(
      "2→two\n\n[more lines below; pass offset=2 to continue]\n"
    );
    await expect(tool.execute('{"path":"short.txt","offset":0,"limit":1,"limit":null}')).resolves.toBe(
      "1→one\n\n[more lines below; pass offset=1 to continue]\n"
    );
    await expect(tool.execute('{"path":"short.txt","offset":null,"limit":null}')).resolves.toBe("1→one\n2→two\n3→three\n");

    await expect(tool.execute('{"path":1,"path":null}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal number into Go struct field .path of type string"
    );
    await expect(tool.execute('{"path":"short.txt","offset":"bad","offset":null}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal string into Go struct field .offset of type int"
    );
    await expect(tool.execute('{"path":"short.txt","limit":"bad","limit":null}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal string into Go struct field .limit of type int"
    );
  });

  it("preserves raw JSON int64 literals for offset and limit like Go int unmarshalling", async () => {
    const { createReadFileTool } = await import("./readFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();
    await writeFile(path.join(dir, "short.txt"), "one\ntwo\n", "utf8");

    const tool = createReadFileTool(new Workspace({ dir }));
    await expect(tool.execute('{"path":"short.txt","offset":9007199254740993,"limit":1}')).resolves.toBe(
      "(offset 9007199254740993 is past EOF — file has 2 lines)"
    );
    await expect(tool.execute('{"path":"short.txt","offset":9223372036854775807,"limit":1}')).resolves.toBe(
      "(offset 9223372036854775807 is past EOF — file has 2 lines)"
    );
    await expect(tool.execute(new TextEncoder().encode('{"path":"short.txt","offset":9007199254740993,"limit":1}'))).resolves.toBe(
      "(offset 9007199254740993 is past EOF — file has 2 lines)"
    );
    await expect(tool.execute('{"path":"short.txt","offset":-9223372036854775808,"limit":1}')).resolves.toBe(
      "1→one\n\n[more lines below; pass offset=1 to continue]\n"
    );
    await expect(tool.execute('{"path":"short.txt","offset":1,"limit":9223372036854775807}')).resolves.toBe("2→two\n");
  });

  it("formats common JSON syntax errors like Go encoding/json", async () => {
    const { createReadFileTool } = await import("./readFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();

    const tool = createReadFileTool(new Workspace({ dir }));
    const cases: Array<[string, string]> = [
      ["{invalid", "invalid args: invalid character 'i' looking for beginning of object key string"],
      ["{]", "invalid args: invalid character ']' looking for beginning of object key string"],
      ['{"path":"short.txt",}', "invalid args: invalid character '}' looking for beginning of object key string"],
      ['{"path" "short.txt"}', "invalid args: invalid character '\"' after object key"],
      ['{"path":"short.txt","extra":{"x":}}', "invalid args: invalid character '}' looking for beginning of value"],
      ['{"path":"short.txt","extra":[1,]}', "invalid args: invalid character ']' looking for beginning of value"],
      ['{"path":"short.txt","extra":{"x" "y"}}', "invalid args: invalid character '\"' after object key"],
      ["", "invalid args: unexpected end of JSON input"],
      ['{"path":"unterminated}', "invalid args: unexpected end of JSON input"]
    ];

    for (const [input, message] of cases) {
      await expect(tool.execute(input)).rejects.toThrow(message);
    }
  });

  it("formats bad argument types like Go encoding/json", async () => {
    const { createReadFileTool } = await import("./readFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();
    await writeFile(path.join(dir, "short.txt"), "one\ntwo\n", "utf8");

    const tool = createReadFileTool(new Workspace({ dir }));
    const cases: Array<[unknown, string]> = [
      [
        "1",
        'invalid args: json: cannot unmarshal number into Go value of type struct { Path string "json:\\"path\\""; Offset int "json:\\"offset,omitempty\\""; Limit int "json:\\"limit,omitempty\\"" }'
      ],
      [
        '"x"',
        'invalid args: json: cannot unmarshal string into Go value of type struct { Path string "json:\\"path\\""; Offset int "json:\\"offset,omitempty\\""; Limit int "json:\\"limit,omitempty\\"" }'
      ],
      [
        "[]",
        'invalid args: json: cannot unmarshal array into Go value of type struct { Path string "json:\\"path\\""; Offset int "json:\\"offset,omitempty\\""; Limit int "json:\\"limit,omitempty\\"" }'
      ],
      [
        "true",
        'invalid args: json: cannot unmarshal bool into Go value of type struct { Path string "json:\\"path\\""; Offset int "json:\\"offset,omitempty\\""; Limit int "json:\\"limit,omitempty\\"" }'
      ],
      ['{"offset":"1"}', "invalid args: json: cannot unmarshal string into Go struct field .offset of type int"],
      ['{"limit":"1"}', "invalid args: json: cannot unmarshal string into Go struct field .limit of type int"],
      ['{"path":null,"offset":"1"}', "invalid args: json: cannot unmarshal string into Go struct field .offset of type int"],
      ['{"path":"","limit":1.0}', "invalid args: json: cannot unmarshal number 1.0 into Go struct field .limit of type int"],
      ['{"path":1}', "invalid args: json: cannot unmarshal number into Go struct field .path of type string"],
      [
        '{"path":"short.txt","offset":"1"}',
        "invalid args: json: cannot unmarshal string into Go struct field .offset of type int"
      ],
      [
        '{"path":"short.txt","offset":1.0}',
        "invalid args: json: cannot unmarshal number 1.0 into Go struct field .offset of type int"
      ],
      [
        '{"path":"short.txt","offset":1e0}',
        "invalid args: json: cannot unmarshal number 1e0 into Go struct field .offset of type int"
      ],
      [
        '{"path":"short.txt","offset":1.5}',
        "invalid args: json: cannot unmarshal number 1.5 into Go struct field .offset of type int"
      ],
      [
        '{"path":"short.txt","offset":9223372036854775808}',
        "invalid args: json: cannot unmarshal number 9223372036854775808 into Go struct field .offset of type int"
      ],
      [
        '{"path":"short.txt","limit":"1"}',
        "invalid args: json: cannot unmarshal string into Go struct field .limit of type int"
      ],
      [
        '{"path":"short.txt","limit":1.0}',
        "invalid args: json: cannot unmarshal number 1.0 into Go struct field .limit of type int"
      ],
      [
        '{"path":"short.txt","limit":1e0}',
        "invalid args: json: cannot unmarshal number 1e0 into Go struct field .limit of type int"
      ],
      [
        '{"path":"short.txt","limit":1.5}',
        "invalid args: json: cannot unmarshal number 1.5 into Go struct field .limit of type int"
      ],
      [
        '{"path":"short.txt","limit":9223372036854775808}',
        "invalid args: json: cannot unmarshal number 9223372036854775808 into Go struct field .limit of type int"
      ]
    ];

    for (const [input, message] of cases) {
      await expect(tool.execute(input)).rejects.toThrow(message);
    }

    await expect(tool.execute(new TextEncoder().encode('{"offset":"1"}'))).rejects.toThrow(
      "invalid args: json: cannot unmarshal string into Go struct field .offset of type int"
    );
    await expect(tool.execute({ offset: "1" })).rejects.toThrow(
      "invalid args: json: cannot unmarshal string into Go struct field .offset of type int"
    );
    await expect(tool.execute({ path: null, offset: "1" })).rejects.toThrow(
      "invalid args: json: cannot unmarshal string into Go struct field .offset of type int"
    );
  });

  it("keeps the earliest raw JSON struct field type error across duplicate keys like Go encoding/json", async () => {
    const { createReadFileTool } = await import("./readFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();
    await writeFile(path.join(dir, "short.txt"), "one\ntwo\n", "utf8");

    const tool = createReadFileTool(new Workspace({ dir }));
    const cases: Array<[string, string]> = [
      [
        '{"path":"short.txt","offset":"bad","offset":1,"limit":1}',
        "invalid args: json: cannot unmarshal string into Go struct field .offset of type int"
      ],
      [
        '{"path":"short.txt","limit":1.0,"limit":1}',
        "invalid args: json: cannot unmarshal number 1.0 into Go struct field .limit of type int"
      ],
      ['{"path":1,"path":"short.txt"}', "invalid args: json: cannot unmarshal number into Go struct field .path of type string"]
    ];

    for (const [input, message] of cases) {
      await expect(tool.execute(input)).rejects.toThrow(message);
    }
  });

  it("matches Go struct JSON fields case-insensitively for raw JSON args", async () => {
    const { createReadFileTool } = await import("./readFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();
    await writeFile(path.join(dir, "short.txt"), "one\ntwo\n", "utf8");

    const tool = createReadFileTool(new Workspace({ dir }));
    await expect(tool.execute('{"Path":"short.txt"}')).resolves.toBe("1→one\n2→two\n");
    await expect(tool.execute('{"path":"missing.txt","PATH":"short.txt"}')).resolves.toBe("1→one\n2→two\n");
    await expect(tool.execute(new TextEncoder().encode('{"PATH":"short.txt","LIMIT":1}'))).resolves.toBe(
      "1→one\n\n[more lines below; pass offset=1 to continue]\n"
    );
    await expect(tool.execute('{"path":"short.txt","Limit":"1"}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal string into Go struct field .limit of type int"
    );
    await expect(tool.execute('{"Path":1,"path":"short.txt"}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal number into Go struct field .path of type string"
    );
    await expect(tool.execute('{"path":"short.txt","OFFSET":"bad","offset":1,"limit":1}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal string into Go struct field .offset of type int"
    );
  });

  it("matches Go struct JSON fields case-insensitively for structured args", async () => {
    const { createReadFileTool } = await import("./readFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();
    await writeFile(path.join(dir, "short.txt"), "one\ntwo\n", "utf8");

    const tool = createReadFileTool(new Workspace({ dir }));
    await expect(tool.execute({ Path: "short.txt" })).resolves.toBe("1→one\n2→two\n");
    await expect(tool.execute({ path: "missing.txt", PATH: "short.txt" })).resolves.toBe("1→one\n2→two\n");
    await expect(tool.execute({ PATH: "short.txt", LIMIT: 1 })).resolves.toBe(
      "1→one\n\n[more lines below; pass offset=1 to continue]\n"
    );
    await expect(tool.execute({ path: "short.txt", Limit: "1" })).rejects.toThrow(
      "invalid args: json: cannot unmarshal string into Go struct field .limit of type int"
    );
    await expect(tool.execute({ Path: 1, path: "short.txt" })).rejects.toThrow(
      "invalid args: json: cannot unmarshal number into Go struct field .path of type string"
    );
    await expect(tool.execute({ path: "short.txt", OFFSET: "bad", offset: 1, limit: 1 })).rejects.toThrow(
      "invalid args: json: cannot unmarshal string into Go struct field .offset of type int"
    );
  });

  it("rejects lines longer than Reasonix bufio.Scanner token limit", async () => {
    const { createReadFileTool } = await import("./readFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();
    await writeFile(path.join(dir, "too-long.txt"), Buffer.alloc(1024 * 1024 + 1, 0x61));

    await expect(createReadFileTool(new Workspace({ dir })).execute({ path: "too-long.txt" })).rejects.toThrow(
      "scan: bufio.Scanner: token too long"
    );
  });

  it("rejects a 1MiB line even when the delimiter arrives next like bufio.Scanner", async () => {
    const { createReadFileTool } = await import("./readFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();
    await writeFile(path.join(dir, "max-plus-newline.txt"), Buffer.concat([Buffer.alloc(1024 * 1024, 0x61), Buffer.from("\n")]));

    await expect(createReadFileTool(new Workspace({ dir })).execute({ path: "max-plus-newline.txt", limit: 1 })).rejects.toThrow(
      "scan: bufio.Scanner: token too long"
    );
  });

  it("decodes UTF BOMs, BOM-less UTF-16, and GB18030 content without leaking BOM or NUL bytes", async () => {
    const { createReadFileTool } = await import("./readFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();

    await writeFile(path.join(dir, "utf8bom.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello\nsecond")]));
    await writeFile(path.join(dir, "utf16le.txt"), encodeUtf16("hello\nsecond", "le", true));
    await writeFile(path.join(dir, "utf16be.txt"), encodeUtf16("hello\nsecond", "be", true));
    await writeFile(path.join(dir, "nobom.cpp"), encodeUtf16('// Created by 69431 on 2024/12/31\n#include "x.h"\n', "le", false));
    await writeFile(path.join(dir, "gbk.txt"), Buffer.from([196, 227, 186, 195, 202, 192, 189, 231, 10, 181, 218, 182, 254, 208, 208]));

    const tool = createReadFileTool(new Workspace({ dir }));
    for (const file of ["utf8bom.txt", "utf16le.txt", "utf16be.txt"]) {
      const out = await tool.execute({ path: file });
      expect(out).toContain("hello");
      expect(out).toContain("second");
      expect(out).not.toContain("\ufeff");
      expect(out).not.toContain("\0");
    }
    await expect(tool.execute({ path: "nobom.cpp" })).resolves.toContain("Created by 69431");
    await expect(tool.execute({ path: "gbk.txt" })).resolves.toContain("你好世界");
    await expect(tool.execute({ path: "gbk.txt" })).resolves.toContain("第二行");
  });

  it("replaces isolated UTF-16 surrogate code units like Go string conversion", async () => {
    const { createReadFileTool } = await import("./readFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();

    await writeFile(path.join(dir, "isolated-high.txt"), Buffer.from([0xff, 0xfe, 0x00, 0xd8]));
    await writeFile(path.join(dir, "isolated-low.txt"), Buffer.from([0xff, 0xfe, 0x00, 0xdc]));

    const tool = createReadFileTool(new Workspace({ dir }));
    await expect(tool.execute({ path: "isolated-high.txt" })).resolves.toBe("1→�\n");
    await expect(tool.execute({ path: "isolated-low.txt" })).resolves.toBe("1→�\n");
  });

  it("streams large GB18030 reads far beyond the detection sample", async () => {
    const { createReadFileTool } = await import("./readFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();
    const repeated = Buffer.from([181, 218, 210, 187, 208, 208, 214, 208, 206, 196, 32, 108, 105, 110, 101, 32, 111, 110, 101, 32, 196, 227, 186, 195, 202, 192, 189, 231, 10]);
    const end = Buffer.from([214, 213, 181, 227, 177, 234, 188, 199, 32, 84, 72, 69, 45, 69, 78, 68, 10]);
    await writeFile(path.join(dir, "big.gbk"), Buffer.concat([...Array.from({ length: 20000 }, () => repeated), end]));

    const out = await createReadFileTool(new Workspace({ dir })).execute({ path: "big.gbk", offset: 19999, limit: 2 });

    expect(out).toContain("你好世界");
    expect(out).toContain("终点标记 THE-END");
  });

  it("keeps UTF-8 streaming reads byte-based after a valid detection sample", async () => {
    const { createReadFileTool } = await import("./readFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();
    const validLines = Buffer.from(Array.from({ length: 30000 }, (_, index) => `valid-${index.toString().padStart(5, "0")}\n`).join(""));
    await writeFile(path.join(dir, "late-invalid.txt"), Buffer.concat([validLines, Buffer.from([0xff, 0xff, 0xff, 0x0a])]));

    const out = await createReadFileTool(new Workspace({ dir })).execute({ path: "late-invalid.txt", offset: 30000, limit: 1 });

    expect(out).toBe("30001→ÿÿÿ\n");
    expect(out).not.toContain("\ufffd");
    expect(Array.from(out).map((char) => char.codePointAt(0))).toEqual([51, 48, 48, 48, 49, 8594, 255, 255, 255, 10]);
  });

  it("continues streaming from the initially opened file handle after detection", async () => {
    vi.resetModules();
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();
    const target = path.join(dir, "reopened.txt");
    const head = Buffer.from("x\n".repeat(128 * 1024));
    await writeFile(target, Buffer.concat([head, Buffer.from("ORIGINAL_AFTER_HEAD\n")]));
    type CreateReadStreamOptions = Parameters<typeof actualFs.createReadStream>[1];
    const createReadStream = vi.fn((streamPath: fs.PathLike, options?: CreateReadStreamOptions) => {
      const start = typeof options === "object" && options !== null && typeof options.start === "number" ? options.start : 0;
      fs.writeFileSync(target, Buffer.concat([Buffer.alloc(start, 0x78), Buffer.from("SECRET_AFTER_REOPEN\n")]));
      return actualFs.createReadStream(streamPath, options);
    });
    const actualFsDefault = (actualFs as typeof actualFs & { default?: typeof fs }).default ?? actualFs;
    vi.doMock("node:fs", () => ({
      ...actualFs,
      createReadStream,
      default: actualFsDefault
    }));

    try {
      const { createReadFileTool } = await import("./readFileTool");
      const out = await createReadFileTool(new Workspace({ dir })).execute({ path: "reopened.txt", offset: 128 * 1024, limit: 1 });

      expect(out).toBe("131073→ORIGINAL_AFTER_HEAD\n");
      expect(createReadStream).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("rejects binary files after BOM and BOM-less UTF-16 checks with alias-specific messages", async () => {
    const { createReadFileTool } = await import("./readFileTool");
    const { PathResolver, Workspace } = await import("../index");
    const dir = await tempDir();
    const external = await tempDir();
    await writeFile(path.join(dir, "blob"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0]));
    await writeFile(path.join(external, "blob"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0]));

    await expect(createReadFileTool(new Workspace({ dir })).execute({ path: "blob" })).rejects.toThrow(
      `binary file ${path.join(dir, "blob")} (NUL byte detected); use \`bash hexdump\` or another tool`
    );

    const resolver = new PathResolver();
    resolver.registerReadRoot("__reasonix_external_folder/abc123/External", external);
    await expect(
      createReadFileTool(new Workspace({ dir, readPaths: resolver })).execute({ path: "__reasonix_external_folder/abc123/External/blob" })
    ).rejects.toThrow("binary file __reasonix_external_folder/abc123/External/blob (NUL byte detected); not shown by read_file");
  });

  it("uses external read aliases in output and errors without leaking local roots", async () => {
    const { createReadFileTool } = await import("./readFileTool");
    const { PathResolver, Workspace } = await import("../index");
    const dir = await tempDir();
    const external = await tempDir();
    await mkdir(path.join(external, "src"));
    await writeFile(path.join(external, "src", "outside.txt"), "outside\n", "utf8");

    const token = "__reasonix_external_folder/abc123/External";
    const resolver = new PathResolver();
    resolver.registerReadRoot(token, external);
    const tool = createReadFileTool(new Workspace({ dir, readPaths: resolver, forbidReadRoots: [path.join(external, "secret")] }));

    await expect(tool.execute({ path: `${token}/src/outside.txt` })).resolves.toBe("1→outside\n");
    await expect(tool.execute({ path: `${token}//src/outside.txt` })).resolves.toBe("1→outside\n");
    await expect(tool.execute({ path: `${token}/src/missing.txt` })).rejects.toThrow(
      `read ${token}/src/missing.txt: open ${token}/src/missing.txt: no such file or directory`
    );

    const secretDir = path.join(external, "secret");
    await mkdir(secretDir);
    await writeFile(path.join(secretDir, "hidden.txt"), "hidden\n", "utf8");
    await expect(tool.execute({ path: `${token}/secret/hidden.txt` })).rejects.toThrow(
      `read ${token}/secret/hidden.txt: open ${token}/secret/hidden.txt: file does not exist`
    );
  });

  it("returns workspace forbid-root PathErrors like Reasonix", async () => {
    const { createReadFileTool } = await import("./readFileTool");
    const { Workspace } = await import("../workspace");
    const dir = await tempDir();
    const secretDir = path.join(dir, "secret");
    const secretFile = path.join(secretDir, "hidden.txt");
    await mkdir(secretDir);
    await writeFile(secretFile, "hidden\n", "utf8");

    const tool = createReadFileTool(new Workspace({ dir, forbidReadRoots: [secretDir] }));

    await expect(tool.execute({ path: "secret/hidden.txt" })).rejects.toThrow(
      `open ${secretFile}: file does not exist`
    );
  });

  it("can be registered as the concrete read_file tool while provider schemas stay model-visible only", async () => {
    const { createReadFileTool } = await import("./readFileTool");
    const { Registry, Workspace } = await import("../index");
    const dir = await tempDir();
    await writeFile(path.join(dir, "a.txt"), "alpha\n", "utf8");

    const registry = new Registry();
    registry.add(createReadFileTool(new Workspace({ dir })));
    const tool = registry.get("read_file");

    expect(registry.schemas()[0]).toMatchObject({ name: "read_file", parameters: { required: ["path"] } });
    expect(tool).toBeDefined();
    expect("execute" in tool!).toBe(true);
    await expect((tool as ReturnType<typeof createReadFileTool>).execute({ path: "a.txt" })).resolves.toBe("1→alpha\n");
  });
});

function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "reasonix-read-file-"));
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
