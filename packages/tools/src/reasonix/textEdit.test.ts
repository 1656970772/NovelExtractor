import { describe, expect, it } from "vitest";

describe("Reasonix text edit parity", () => {
  it("applies exact edits once and reports duplicate exact matches", async () => {
    const { applyOldStringEdit, oldStringNotUniqueError } = await import("./textEdit");

    expect(applyOldStringEdit("hello world\n", "world", "reasonix", false)).toEqual({
      updated: "hello reasonix\n",
      applied: 1,
      matches: 1,
      fuzzy: false
    });
    expect(applyOldStringEdit("x x x", "x", "y", false)).toEqual({
      updated: "x x x",
      applied: 0,
      matches: 3,
      fuzzy: false
    });
    expect(oldStringNotUniqueError("dup.txt", 3, false).message).toBe(
      "old_string is not unique in dup.txt (3 matches); add more surrounding context"
    );
  });

  it("adapts LF-only edit text to CRLF files and preserves LF files", async () => {
    const { applyOldStringEdit } = await import("./textEdit");

    expect(applyOldStringEdit("one\r\ntwo\r\nthree\r\n", "one\ntwo", "ONE\nTWO", false)).toMatchObject({
      updated: "ONE\r\nTWO\r\nthree\r\n",
      applied: 1,
      matches: 1,
      fuzzy: false
    });
    expect(applyOldStringEdit("alpha\nbeta\ngamma\n", "alpha\nbeta", "ALPHA\nBETA", false).updated).toBe(
      "ALPHA\nBETA\ngamma\n"
    );
  });

  it("supports Reasonix fuzzy modes without accepting leading indentation drift", async () => {
    const { applyOldStringEdit } = await import("./textEdit");

    expect(applyOldStringEdit("func main() {   \n\tfmt.Println(\"hello\")  \n}\n", "func main() {\n\tfmt.Println(\"hello\")\n}", "func main() {\n\tfmt.Println(\"bye\")\n}", false)).toMatchObject({
      updated: "func main() {\n\tfmt.Println(\"bye\")\n}\n",
      applied: 1,
      matches: 1,
      fuzzy: true
    });
    expect(applyOldStringEdit("alpha\nbeta\ngamma\n", "1\u2192alpha\n2\u2192beta", "ALPHA\nBETA", false)).toMatchObject({
      updated: "ALPHA\nBETA\ngamma\n",
      fuzzy: true
    });
    expect(applyOldStringEdit("target   \ntarget   \n", "target\n", "updated\n", false)).toEqual({
      updated: "target   \ntarget   \n",
      applied: 0,
      matches: 2,
      fuzzy: false
    });
    expect(
      applyOldStringEdit("func f() {\n    if ok {\n        return nil\n    }\n}\n", "if ok {\n    return nil\n}", "if ok {\n    return err\n}", false)
    ).toEqual({
      updated: "func f() {\n    if ok {\n        return nil\n    }\n}\n",
      applied: 0,
      matches: 0,
      fuzzy: false
    });
  });

  it("reports nearest line hints like Reasonix", async () => {
    const { oldStringNotFoundError } = await import("./textEdit");

    expect(oldStringNotFoundError("a.txt", "alpha changed\n", "alpha original\nbeta\n").message).toBe(
      'old_string not found in a.txt (nearest line 1: "alpha original")'
    );
    expect(oldStringNotFoundError("a.txt", "你 changed\n", "你 original\nbeta\n").message).toBe(
      'old_string not found in a.txt (nearest line 1: "你 original")'
    );
    expect(oldStringNotFoundError("a.txt", "zz", "alpha\nbeta\n").message).toBe("old_string not found in a.txt");
  });
});
