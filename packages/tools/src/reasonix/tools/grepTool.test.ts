import fs from "node:fs";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("Reasonix grep tool parity", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.useRealTimers();
    vi.doUnmock("node:child_process");
    vi.doUnmock("node:fs");
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
  });

  it("exposes execute on the concrete grep tool while workspace definitions stay provider-only", async () => {
    const { Registry, Workspace } = await import("../index");
    const dir = await tempDir();
    const workspace = new Workspace({ dir });
    const [definition] = workspace.tools(["grep"]);
    const tool = await createTool(workspace);
    const registry = new Registry();
    registry.add(tool);

    expect("execute" in definition).toBe(false);
    expect(typeof tool.execute).toBe("function");
    expect(tool.readOnly()).toBe(true);
    expect(registry.schemas()[0]).toMatchObject({
      name: "grep",
      parameters: {
        required: ["pattern"],
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
          timeout_seconds: { type: "integer", minimum: 1 }
        }
      }
    });
  });

  it("matches Go-style grep args for required fields, defaults, case-insensitive keys, and raw null no-op", async () => {
    const { Workspace } = await import("../index");
    const dir = await tempDir();
    await writeFile(path.join(dir, "a.txt"), "needle\nsecond\n", "utf8");
    const tool = await createTool(new Workspace({ dir }));
    const goGrepStruct =
      'struct { Pattern string "json:\\"pattern\\""; Path string "json:\\"path\\""; TimeoutSeconds int "json:\\"timeout_seconds\\"" }';

    await expect(tool.execute({ path: "a.txt" })).rejects.toThrow("pattern is required");
    await expect(tool.execute("null")).rejects.toThrow("pattern is required");
    await expect(tool.execute({ pattern: null, path: "a.txt" })).rejects.toThrow("pattern is required");
    await expect(tool.execute("1")).rejects.toThrow(`invalid args: json: cannot unmarshal number into Go value of type ${goGrepStruct}`);
    await expect(tool.execute("{invalid")).rejects.toThrow("invalid args: invalid character 'i' looking for beginning of object key string");
    await expect(tool.execute('{"pattern":1,"path":"a.txt"}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal number into Go struct field .pattern of type string"
    );
    await expect(tool.execute('{"pattern":"needle","timeout_seconds":"bad"}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal string into Go struct field .timeout_seconds of type int"
    );
    await expect(tool.execute({ pattern: "needle", timeout_seconds: Number.MAX_SAFE_INTEGER * 4096 })).rejects.toThrow(
      "invalid args: json: cannot unmarshal number into Go struct field .timeout_seconds of type int"
    );
    await expect(tool.execute('{"pattern":1,"pattern":"needle","path":"a.txt"}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal number into Go struct field .pattern of type string"
    );

    await expect(tool.execute('{"Pattern":"needle","PATH":"a.txt"}')).resolves.toBe(
      `${path.join(dir, "a.txt")}:1:needle`
    );
    await expect(tool.execute('{"pattern":"needle","path":"a.txt","path":null}')).resolves.toBe(
      `${path.join(dir, "a.txt")}:1:needle`
    );
    await expect(tool.execute('{"pattern":"needle","path":null}')).resolves.toBe(`${path.join(dir, "a.txt")}:1:needle`);
    await expect(tool.execute({ pattern: "needle", path: null })).resolves.toBe(`${path.join(dir, "a.txt")}:1:needle`);
    await expect(tool.execute(new TextEncoder().encode('{"PATTERN":"needle","PATH":"a.txt","TIMEOUT_SECONDS":1}'))).resolves.toBe(
      `${path.join(dir, "a.txt")}:1:needle`
    );
  });

  it("searches files with path:line:text output, invalid pattern errors, no-match output, and 200-match truncation", async () => {
    const { Workspace } = await import("../index");
    const dir = await tempDir();
    await writeFile(path.join(dir, "single.txt"), "alpha\nneedle here\nomega\n", "utf8");
    await writeFile(path.join(dir, "many.txt"), Array.from({ length: 201 }, (_, index) => `match ${index + 1}`).join("\n"), "utf8");
    const tool = await createTool(new Workspace({ dir }));

    await expect(tool.execute({ pattern: "needle", path: "single.txt" })).resolves.toBe(
      `${path.join(dir, "single.txt")}:2:needle here`
    );
    await expect(tool.execute({ pattern: "absent", path: "single.txt" })).resolves.toBe("(no matches)");
    await expect(tool.execute({ pattern: "(", path: "single.txt" })).rejects.toThrow(/^invalid pattern: /u);

    const truncated = await tool.execute({ pattern: "^match", path: "many.txt" });
    expect(truncated.split("\n")).toHaveLength(201);
    expect(truncated).toContain(`${path.join(dir, "many.txt")}:200:match 200`);
    expect(truncated).not.toContain("match 201");
    expect(truncated).toContain("... (truncated at 200 matches)");
  });

  it("streams non-UTF-16 native files without reading the whole file", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "many.txt"), Array.from({ length: 201 }, (_, index) => `match ${index + 1}`).join("\n"), "utf8");
    const readFileMock = vi.fn(async (...args: Parameters<typeof readFile>) => readFile(...args));
    mockFsPromises({ readFile: readFileMock });
    const { Workspace } = await import("../index");
    const tool = await createTool(new Workspace({ dir }));

    const out = await tool.execute({ pattern: "^match", path: "many.txt" });

    expect(out.split("\n")).toHaveLength(201);
    expect(out).toContain(`${path.join(dir, "many.txt")}:200:match 200`);
    expect(out).not.toContain("match 201");
    expect(out).toContain("... (truncated at 200 matches)");
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("uses Go RE2 pattern semantics for inline flags and unsupported constructs", async () => {
    const { Workspace } = await import("../index");
    const dir = await tempDir();
    const file = path.join(dir, "a.txt");
    await writeFile(file, "Needle\naa\n", "utf8");
    const tool = await createTool(new Workspace({ dir }));

    await expect(tool.execute({ pattern: "(?i)needle", path: "a.txt" })).resolves.toBe(`${file}:1:Needle`);
    await expect(tool.execute({ pattern: "(a)\\1", path: "a.txt" })).rejects.toThrow(/^invalid pattern: /u);
    await expect(tool.execute({ pattern: "Need(?=le)", path: "a.txt" })).rejects.toThrow(/^invalid pattern: /u);
    await expect(tool.execute({ pattern: "(?<=Need)le", path: "a.txt" })).rejects.toThrow(/^invalid pattern: /u);
  });

  it("uses Go RE2 Unicode property and POSIX character class semantics", async () => {
    const { Workspace } = await import("../index");
    const dir = await tempDir();
    const file = path.join(dir, "unicode.txt");
    await writeFile(file, "你好\n123\n", "utf8");
    const tool = await createTool(new Workspace({ dir }));

    await expect(tool.execute({ pattern: "\\p{Han}+", path: "unicode.txt" })).resolves.toBe(`${file}:1:你好`);
    await expect(tool.execute({ pattern: "[[:digit:]]+", path: "unicode.txt" })).resolves.toBe(`${file}:2:123`);
  });

  it("matches Go scanner behavior for overlong native lines and NUL after earlier matches", async () => {
    const { Workspace } = await import("../index");
    const dir = await tempDir();
    await writeFile(path.join(dir, "exact.txt"), `${"x".repeat(1024 * 1024 - "needle".length)}needle\n`, "utf8");
    await writeFile(path.join(dir, "too-long.txt"), `${"a".repeat(1024 * 1024 + 100)}needle\n`, "utf8");
    const beforeNul = `needle before ${"x".repeat(9 * 1024)}\n`;
    await writeFile(path.join(dir, "nul-after-match.txt"), Buffer.from(`${beforeNul}binary\0line\nneedle after\n`, "utf8"));
    const tool = await createTool(new Workspace({ dir }));

    await expect(tool.execute({ pattern: "needle", path: "exact.txt" })).resolves.toBe("(no matches)");
    await expect(tool.execute({ pattern: "needle", path: "too-long.txt" })).resolves.toBe("(no matches)");
    const nulOut = await tool.execute({ pattern: "needle", path: "nul-after-match.txt" });
    expect(nulOut).toBe(`${path.join(dir, "nul-after-match.txt")}:1:${beforeNul.trimEnd()}`);
    expect(nulOut).not.toContain("needle after");
  });

  it("matches Go ScanLines CR stripping for final native lines without newline", async () => {
    const { Workspace } = await import("../index");
    const dir = await tempDir();
    await writeFile(path.join(dir, "final-cr.txt"), "needle\r", "utf8");
    await writeFile(path.join(dir, "crlf.txt"), "first\r\nneedle\r\n", "utf8");
    await writeFile(path.join(dir, "lf.txt"), "needle\n", "utf8");
    await writeFile(path.join(dir, "no-newline.txt"), "needle", "utf8");
    const tool = await createTool(new Workspace({ dir }));

    const finalCr = await tool.execute({ pattern: "needle$", path: "final-cr.txt" });
    expect(finalCr).toBe(`${path.join(dir, "final-cr.txt")}:1:needle`);
    expect(finalCr).not.toContain("\r");
    await expect(tool.execute({ pattern: "needle$", path: "crlf.txt" })).resolves.toBe(
      `${path.join(dir, "crlf.txt")}:2:needle`
    );
    await expect(tool.execute({ pattern: "needle$", path: "lf.txt" })).resolves.toBe(`${path.join(dir, "lf.txt")}:1:needle`);
    await expect(tool.execute({ pattern: "needle$", path: "no-newline.txt" })).resolves.toBe(
      `${path.join(dir, "no-newline.txt")}:1:needle`
    );
  });

  it("marks ripgrep output truncated when the 200th streamed match is read", async () => {
    const { Workspace } = await import("../index");
    const rg = findOnPath(process.platform === "win32" ? "rg.exe" : "rg");
    if (rg === undefined) {
      return;
    }
    const dir = await tempDir();
    await writeFile(path.join(dir, "many.txt"), Array.from({ length: 200 }, (_, index) => `match ${index + 1}`).join("\n"), "utf8");
    const tool = await createTool(new Workspace({ dir, search: { rgPath: rg } }));

    const out = await tool.execute({ pattern: "match", path: "." });
    expect(out.split("\n")).toHaveLength(201);
    expect(out).toContain(`${path.join(dir, "many.txt")}:200:match 200`);
    expect(out).toContain("... (truncated at 200 matches)");
  });

  it("walks directory entries in Go lexical order", async () => {
    const { Workspace } = await import("../index");
    const dir = await tempDir();
    await mkfile(path.join(dir, "a.txt"), "needle lower\n");
    await mkfile(path.join(dir, "B.txt"), "needle upper\n");
    const tool = await createTool(new Workspace({ dir }));

    const out = await tool.execute({ pattern: "needle", path: "." });
    expect(matchedRelFileList(dir, out)).toEqual(["B.txt", "a.txt"]);
  });

  it("walks non-BMP directory entries in Go UTF-8 byte lexical order", async () => {
    const { Workspace } = await import("../index");
    const dir = await tempDir();
    await mkfile(path.join(dir, "\uE000.txt"), "needle private-use\n");
    await mkfile(path.join(dir, "\u{10000}.txt"), "needle non-bmp\n");
    const tool = await createTool(new Workspace({ dir }));

    const out = await tool.execute({ pattern: "needle", path: "." });
    expect(matchedRelFileList(dir, out)).toEqual(["\uE000.txt", "\u{10000}.txt"]);
  });

  it("recursively skips hidden and vendor entries but searches explicit hidden or vendor roots", async () => {
    const { Workspace } = await import("../index");
    const dir = await tempDir();
    await mkfile(path.join(dir, "app.go"), "needle app\n");
    await mkfile(path.join(dir, ".env"), "needle hidden file\n");
    await mkfile(path.join(dir, ".github", "ci.yml"), "needle hidden dir\n");
    await mkfile(path.join(dir, "node_modules", "pkg", "lib.js"), "needle vendor\n");
    const tool = await createTool(new Workspace({ dir }));

    const root = await tool.execute({ pattern: "needle", path: "." });
    expect(root).toContain("app.go");
    expect(root).not.toContain(".env");
    expect(root).not.toContain("ci.yml");
    expect(root).not.toContain("node_modules");

    await expect(tool.execute({ pattern: "needle", path: ".github" })).resolves.toContain("ci.yml");
    await expect(tool.execute({ pattern: "needle", path: "node_modules" })).resolves.toContain("lib.js");
  });

  it("honors repo gitignore, nested negation, global excludes, no-repo behavior, and explicit ignored roots", async () => {
    const { Workspace } = await import("../index");
    const repo = await tempDir();
    const cfgDir = await tempDir();
    await mkdir(path.join(repo, ".git"));
    await mkfile(path.join(repo, ".gitignore"), "*.log\nbuild/\n/dist/\n");
    await mkfile(path.join(repo, "src", ".gitignore"), "generated.go\n");
    await mkfile(path.join(repo, "pkg", ".gitignore"), "*.log\n!keep.log\n");
    await mkfile(path.join(repo, "src", "app.go"), "NEEDLE app\n");
    await mkfile(path.join(repo, "pkg", "keep.log"), "NEEDLE re-included\n");
    await mkfile(path.join(repo, "README.md"), "NEEDLE readme\n");
    await mkfile(path.join(repo, "src", "generated.go"), "NEEDLE nested ignored\n");
    await mkfile(path.join(repo, "app.log"), "NEEDLE root ignored\n");
    await mkfile(path.join(repo, "build", "out.txt"), "NEEDLE ignored dir\n");
    await mkfile(path.join(repo, "dist", "bundle.js"), "NEEDLE anchored dir\n");
    await mkfile(path.join(repo, "pkg", "drop.log"), "NEEDLE nested log\n");
    await mkfile(path.join(repo, "notes.tmp"), "NEEDLE global ignore\n");
    const excludes = path.join(cfgDir, "global_ignore");
    await mkfile(excludes, "*.tmp\n");
    await mkfile(path.join(cfgDir, "gitconfig"), `[core]\n\texcludesFile = ${pathToGitConfigValue(excludes)}\n`);
    process.env.GIT_CONFIG_GLOBAL = path.join(cfgDir, "gitconfig");
    process.env.XDG_CONFIG_HOME = path.join(cfgDir, "xdg");

    const out = await (await createTool(new Workspace({ dir: repo }))).execute({ pattern: "NEEDLE", path: "." });
    const found = matchedRelFiles(repo, out);
    expect(found).toEqual(new Set(["README.md", "pkg/keep.log", "src/app.go"]));

    await expect((await createTool(new Workspace({ dir: repo }))).execute({ pattern: "NEEDLE", path: "build" })).resolves.toContain("out.txt");

    const outsideRepo = await tempDir();
    await mkfile(path.join(outsideRepo, ".gitignore"), "ignored.txt\n");
    await mkfile(path.join(outsideRepo, "ignored.txt"), "NEEDLE no repo\n");
    await expect((await createTool(new Workspace({ dir: outsideRepo }))).execute({ pattern: "NEEDLE", path: "." })).resolves.toContain(
      "ignored.txt"
    );
  });

  it("searches GB18030 and UTF-16 text while skipping binary files", async () => {
    const { Workspace } = await import("../index");
    const dir = await tempDir();
    await writeFile(path.join(dir, "gbk.txt"), Buffer.from([196, 227, 186, 195, 32, 110, 101, 101, 100, 108, 101, 10]));
    await writeFile(path.join(dir, "utf16le.txt"), encodeUtf16("hello needle\n", "le", true));
    await writeFile(path.join(dir, "utf8bom.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("needle\n")]));
    await writeFile(path.join(dir, "blob.bin"), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0, 0x78]));
    const tool = await createTool(new Workspace({ dir }));

    const out = await tool.execute({ pattern: "needle", path: "." });
    expect(out).toContain("gbk.txt");
    expect(out).toContain("你好 needle");
    expect(out).toContain("utf16le.txt");
    expect(out).toContain(`utf8bom.txt:1:\ufeffneedle`);
    expect(out).not.toContain("blob.bin");
  });

  it("detects native grep encoding from only the first 8KiB peek", async () => {
    const { Workspace } = await import("../index");
    const dir = await tempDir();
    const lateGbk = Buffer.concat([
      Buffer.from(`${"a".repeat(9 * 1024)}\n`, "utf8"),
      Buffer.from([196, 227, 186, 195, 32, 110, 101, 101, 100, 108, 101, 10])
    ]);
    await writeFile(path.join(dir, "late-gbk.txt"), lateGbk);
    await writeFile(path.join(dir, "early-gbk.txt"), Buffer.from([196, 227, 186, 195, 32, 110, 101, 101, 100, 108, 101, 10]));
    const tool = await createTool(new Workspace({ dir }));

    await expect(tool.execute({ pattern: "你好", path: "late-gbk.txt" })).resolves.toBe("(no matches)");
    await expect(tool.execute({ pattern: "你好", path: "early-gbk.txt" })).resolves.toBe(
      `${path.join(dir, "early-gbk.txt")}:1:你好 needle`
    );
  });

  it("stops directory walking promptly when native grep times out before finding files", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
    const dir = await tempDir();
    const fullDepth = 8;
    let readdirCalls = 0;
    const readdirMock = vi.fn(async () => {
      readdirCalls += 1;
      vi.setSystemTime(Date.now() + 1000);
      if (readdirCalls > fullDepth) {
        return [];
      }
      return [fakeDirent(`dir-${readdirCalls}`, true)];
    });
    mockFsPromises({ readdir: readdirMock });
    const { Workspace } = await import("../index");
    const tool = await createTool(new Workspace({ dir }));

    const out = await tool.execute({ pattern: "needle", path: ".", timeout_seconds: 1 });

    expect(out).toBe("(no matches; timed out after 1s — narrow the path/pattern or raise timeout_seconds)");
    expect(readdirCalls).toBeLessThan(fullDepth + 1);
  });

  it("reports timeout for a native single-file scan when the deadline expires without scanned lines", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
    const dir = await tempDir();
    await writeFile(path.join(dir, "empty.txt"), "");
    mockCreateReadStream(async function* () {
      vi.setSystemTime(Date.now() + 2000);
    });
    const { Workspace } = await import("../index");
    const tool = await createTool(new Workspace({ dir }));

    await expect(tool.execute({ pattern: "needle", path: "empty.txt", timeout_seconds: 1 })).resolves.toBe(
      "(no matches; timed out after 1s — narrow the path/pattern or raise timeout_seconds)"
    );
  });

  it("uses raw byte length for LossyUTF8 scanner token limits", async () => {
    const { Workspace } = await import("../index");
    const dir = await tempDir();
    await writeFile(path.join(dir, "lossy-token.bin"), Buffer.concat([Buffer.alloc(600000, 0xff), Buffer.from("needle\n")]));
    const tool = await createTool(new Workspace({ dir }));

    const out = await tool.execute({ pattern: "needle", path: "lossy-token.bin" });

    expect(out).not.toBe("(no matches)");
    expect(out).toContain(`${path.join(dir, "lossy-token.bin")}:1:`);
    expect(out).toContain("needle");
  });

  it("matches LossyUTF8 invalid bytes as RuneError while displaying raw bytes", async () => {
    const { Workspace } = await import("../index");
    const dir = await tempDir();
    const file = path.join(dir, "bad.bin");
    await writeFile(file, Buffer.from([0xff, 0x0a]));
    const tool = await createTool(new Workspace({ dir }));

    await expect(tool.execute({ pattern: ".", path: "bad.bin" })).resolves.toBe(`${file}:1:ÿ`);
    await expect(tool.execute({ pattern: "\\p{L}", path: "bad.bin" })).resolves.toBe("(no matches)");
  });

  it("formats timeout durations like Go time.Duration.String", async () => {
    vi.useFakeTimers();
    const dir = await tempDir();
    const rgPath = await fakeRgPath(dir);
    const spawnMock = mockSpawnWithNeverEndingStdout();
    const { Workspace } = await import("../index");
    const tool = await createTool(new Workspace({ dir, search: { rgPath } }));

    const cases: Array<[number, string]> = [
      [1, "(no matches; timed out after 1s — narrow the path/pattern or raise timeout_seconds)"],
      [60, "(no matches; timed out after 1m0s — narrow the path/pattern or raise timeout_seconds)"],
      [90, "(no matches; timed out after 1m30s — narrow the path/pattern or raise timeout_seconds)"],
      [3661, "(no matches; timed out after 5m0s — narrow the path/pattern or raise timeout_seconds)"]
    ];

    for (let index = 0; index < cases.length; index += 1) {
      const [timeout_seconds, expected] = cases[index];
      const result = tool.execute({ pattern: "needle", path: ".", timeout_seconds });
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(index + 1));
      await vi.advanceTimersByTimeAsync(Math.min(timeout_seconds, 300) * 1000);
      await expect(result).resolves.toBe(expected);
    }
  });

  it("matches Go Scanner token limit for ripgrep stdout", async () => {
    const dir = await tempDir();
    const rgPath = await fakeRgPath(dir);
    const target = path.join(dir, "file.txt");
    const exactPrefix = `${target}:1:`;
    const exactLine = `${exactPrefix}${"x".repeat(1024 * 1024 - Buffer.byteLength(`${exactPrefix}needle`, "utf8"))}needle\n`;
    const longLine = `${target}:1:needle ${"x".repeat(1024 * 1024 + 100)}\n`;
    mockSpawnWithStdout(exactLine);
    const { Workspace } = await import("../index");
    const exactNoMatchTool = await createTool(new Workspace({ dir, search: { rgPath } }));
    await expect(exactNoMatchTool.execute({ pattern: "needle", path: "." })).resolves.toBe("(no matches)");

    vi.resetModules();
    vi.doUnmock("node:child_process");
    mockSpawnWithStdout(longLine);
    const noMatchTool = await createTool(new Workspace({ dir, search: { rgPath } }));
    await expect(noMatchTool.execute({ pattern: "needle", path: "." })).resolves.toBe("(no matches)");

    vi.resetModules();
    vi.doUnmock("node:child_process");
    mockSpawnWithStdout(`${target}:1:needle before\n${exactLine}${target}:3:needle after\n`);
    const earlierMatchTool = await createTool(new Workspace({ dir, search: { rgPath } }));
    const out = await earlierMatchTool.execute({ pattern: "needle", path: "." });
    expect(out).toBe(`${target}:1:needle before`);

    vi.resetModules();
    vi.doUnmock("node:child_process");
    mockSpawnWithStdout(`${target}:1:needle before\n${longLine}${target}:3:needle after\n`);
    const earlierMatchBeforeOverlongTool = await createTool(new Workspace({ dir, search: { rgPath } }));
    const overlongOut = await earlierMatchBeforeOverlongTool.execute({ pattern: "needle", path: "." });
    expect(overlongOut).toBe(`${target}:1:needle before`);
  });

  it("kills ripgrep with SIGKILL when truncating at the match cap", async () => {
    const dir = await tempDir();
    const rgPath = await fakeRgPath(dir);
    const target = path.join(dir, "many.txt");
    const killSignals: Array<NodeJS.Signals | undefined> = [];
    mockSpawnWithStdout(
      Array.from({ length: 200 }, (_, index) => `${target}:${index + 1}:match ${index + 1}`).join("\n") + "\n",
      killSignals
    );
    const { Workspace } = await import("../index");
    const tool = await createTool(new Workspace({ dir, search: { rgPath } }));

    const out = await tool.execute({ pattern: "match", path: "." });

    expect(out).toContain("... (truncated at 200 matches)");
    expect(killSignals).toEqual(["SIGKILL"]);
  });

  it("settles timed-out ripgrep only after sending SIGKILL", async () => {
    vi.useFakeTimers();
    const dir = await tempDir();
    const rgPath = await fakeRgPath(dir);
    const spawnMock = mockSpawnThatClosesOnlyAfterSigkill();
    const { Workspace } = await import("../index");
    const tool = await createTool(new Workspace({ dir, search: { rgPath } }));

    const result = tool.execute({ pattern: "needle", path: ".", timeout_seconds: 1 });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1000);

    await expect(Promise.race([result, Promise.resolve("__not_settled__")])).resolves.toBe(
      "(no matches; timed out after 1s — narrow the path/pattern or raise timeout_seconds)"
    );
  });

  it("settles ripgrep once when an error is followed by close", async () => {
    const dir = await tempDir();
    const rgPath = await fakeRgPath(dir);
    const multipleResolves: string[] = [];
    const onMultipleResolve = (type: string) => multipleResolves.push(type);
    process.on("multipleResolves", onMultipleResolve);
    mockSpawnWithErrorThenClose(new Error("spawn failed"));
    const { Workspace } = await import("../index");
    const tool = await createTool(new Workspace({ dir, search: { rgPath } }));

    await expect(tool.execute({ pattern: "needle", path: "." })).rejects.toThrow("ripgrep: spawn failed");
    await new Promise((resolve) => setImmediate(resolve));
    process.off("multipleResolves", onMultipleResolve);

    expect(multipleResolves).toEqual([]);
  });

  it("uses external read aliases in grep output and prunes forbid-read roots without leaking forbidden content", async () => {
    const { PathResolver, Workspace } = await import("../index");
    const dir = await tempDir();
    const external = await tempDir();
    await mkfile(path.join(dir, "allowed.txt"), "needle allowed\n");
    await mkfile(path.join(external, "src", "outside.txt"), "needle outside\n");
    await mkfile(path.join(external, "secret", "hidden.txt"), "needle secret\n");
    const token = "__reasonix_external_folder/abc123/External";
    const resolver = new PathResolver();
    resolver.registerReadRoot(token, external);
    const tool = await createTool(new Workspace({ dir, readPaths: resolver, forbidReadRoots: [path.join(external, "secret")] }));

    const out = await tool.execute({ pattern: "needle", path: `${token}/src` });
    expect(out).toContain(`${token}/src/outside.txt:1:needle outside`);
    expect(out).not.toContain(external);

    await expect(tool.execute({ pattern: "needle", path: `${token}/secret` })).resolves.toBe("(no matches)");
    await expect(tool.execute({ pattern: "needle", path: `${token}/secret/hidden.txt` })).rejects.toThrow("file does not exist");
    await expect(tool.execute({ pattern: "needle", path: "." })).resolves.toContain("allowed.txt");
  });
});

type GrepTool = {
  name: string;
  description(): string;
  schema(): unknown;
  readOnly(): boolean;
  execute(args: unknown): Promise<string> | string;
};

async function createTool(workspace: unknown): Promise<GrepTool> {
  const mod = (await import("../index")) as typeof import("../index") & { createGrepTool: (workspace: unknown) => GrepTool };
  return mod.createGrepTool(workspace);
}

function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "reasonix-grep-"));
}

async function mkfile(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function fakeRgPath(dir: string): Promise<string> {
  const rgPath = path.join(dir, process.platform === "win32" ? "fake-rg.exe" : "fake-rg");
  await writeFile(rgPath, "", "utf8");
  return rgPath;
}

function mockSpawnWithStdout(stdoutText: string, killSignals?: Array<NodeJS.Signals | undefined>): void {
  vi.doMock("node:child_process", () => ({
    spawn: () => fakeChildProcess((child) => {
      child.stdout.emit("data", Buffer.from(stdoutText, "utf8"));
      child.emit("close", 0);
    }, killSignals)
  }));
}

function mockSpawnWithNeverEndingStdout(): ReturnType<typeof vi.fn> {
  const spawn = vi.fn(() =>
    fakeChildProcess((child) => {
      child.on("killed", () => child.emit("close", null));
    })
  );
  vi.doMock("node:child_process", () => ({ spawn }));
  return spawn;
}

function mockSpawnThatClosesOnlyAfterSigkill(): ReturnType<typeof vi.fn> {
  const spawn = vi.fn(() =>
    fakeChildProcess((child) => {
      child.on("killed", (signal: NodeJS.Signals | undefined) => {
        if (signal === "SIGKILL") {
          child.emit("close", null);
        }
      });
    })
  );
  vi.doMock("node:child_process", () => ({ spawn }));
  return spawn;
}

function mockSpawnWithErrorThenClose(error: Error): void {
  vi.doMock("node:child_process", () => ({
    spawn: () =>
      fakeChildProcess((child) => {
        child.emit("error", error);
        child.emit("close", 1);
      })
  }));
}

function fakeChildProcess(start: (child: FakeChildProcess) => void, killSignals?: Array<NodeJS.Signals | undefined>): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal?: NodeJS.Signals) => {
    killSignals?.push(signal);
    child.emit("killed", signal);
    return true;
  };
  queueMicrotask(() => start(child));
  return child;
}

type FakeChildProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal?: NodeJS.Signals) => boolean;
};

function mockFsPromises(overrides: Record<string, unknown>): void {
  vi.doMock("node:fs/promises", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    return { ...actual, ...overrides };
  });
}

function mockCreateReadStream(iterator: () => AsyncIterable<Buffer>): void {
  vi.doMock("node:fs", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    return {
      ...actual,
      createReadStream: vi.fn(() => ({
        destroy: vi.fn(),
        [Symbol.asyncIterator]: iterator
      }))
    };
  });
}

function fakeDirent(name: string, isDirectory: boolean): fs.Dirent {
  return {
    name,
    isDirectory: () => isDirectory,
    isFile: () => !isDirectory
  } as fs.Dirent;
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

function matchedRelFiles(root: string, output: string): Set<string> {
  const found = new Set<string>();
  for (const rel of matchedRelFileList(root, output)) {
    found.add(rel);
  }
  return found;
}

function matchedRelFileList(root: string, output: string): string[] {
  const found: string[] = [];
  for (const line of output.split("\n")) {
    const last = line.lastIndexOf(":");
    const prev = last >= 0 ? line.lastIndexOf(":", last - 1) : -1;
    if (prev < 0) {
      continue;
    }
    const rel = path.relative(root, line.slice(0, prev));
    if (rel !== "" && !rel.startsWith("..")) {
      found.push(rel.replace(/\\/gu, "/"));
    }
  }
  return found;
}

function pathToGitConfigValue(inputPath: string): string {
  return inputPath.replace(/\\/gu, "/");
}

function findOnPath(command: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, command);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
