import { describe, expect, it } from "vitest";

describe("Reasonix diff parity", () => {
  it("builds create changes with camelCase fields, tallies, and unified diff text", async () => {
    const { buildChange } = await import("./diff");

    const change = buildChange("new.txt", "", "a\nb\nc\n", "create");

    expect(change).toMatchObject({
      path: "new.txt",
      kind: "create",
      oldText: "",
      newText: "a\nb\nc\n",
      added: 3,
      removed: 0,
      binary: false
    });
    expect(change.diff).toBe("--- a/new.txt\n+++ b/new.txt\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n");
  });

  it("builds modify changes with balanced tallies and context", async () => {
    const { buildChange } = await import("./diff");

    const change = buildChange("file.txt", "one\ntwo\nthree\n", "one\nTWO\nthree\n", "modify");

    expect(change).toMatchObject({
      path: "file.txt",
      kind: "modify",
      oldText: "one\ntwo\nthree\n",
      newText: "one\nTWO\nthree\n",
      added: 1,
      removed: 1,
      binary: false
    });
    expect(change.diff).toBe("--- a/file.txt\n+++ b/file.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n");
  });

  it("omits text diffs for binary content", async () => {
    const { buildChange } = await import("./diff");

    const change = buildChange("bin.dat", "a\u0000b", "c", "modify");

    expect(change).toMatchObject({
      path: "bin.dat",
      kind: "modify",
      oldText: "a\u0000b",
      newText: "c",
      added: 0,
      removed: 0,
      diff: "",
      binary: true
    });
  });
});
