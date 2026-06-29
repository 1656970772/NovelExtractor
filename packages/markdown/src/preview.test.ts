import { describe, expect, it } from "vitest";
import { renderSafeMarkdown } from "./preview";

describe("renderSafeMarkdown", () => {
  it("renders common markdown blocks with a safe html allowlist", () => {
    const preview = renderSafeMarkdown([
      "# 丹药总览",
      "",
      "这一段包含 `灵气` 标记。",
      "",
      "- 回春丹",
      "- 聚气丹",
      "",
      "1. 采集材料",
      "2. 炼制成丹",
      "",
      "> 长老只记录可验证线索。",
      "",
      "```ts",
      "const value = \"<pill>\";",
      "```",
      "",
      "| 名称 | 品阶 |",
      "| --- | --- |",
      "| 回春丹 | 一阶 |",
      "",
      "---"
    ].join("\n"));

    expect(preview.headings).toEqual([{ id: "heading-1", depth: 1, text: "丹药总览" }]);
    expect(preview.html).toContain('<h1 id="heading-1">丹药总览</h1>');
    expect(preview.html).toContain("<p>这一段包含 <code>灵气</code> 标记。</p>");
    expect(preview.html).toContain("<ul>");
    expect(preview.html).toContain("<ol>");
    expect(preview.html).toContain("<blockquote>");
    expect(preview.html).toContain("<pre><code>const value = &quot;&lt;pill&gt;&quot;;</code></pre>");
    expect(preview.html).toContain("<table>");
    expect(preview.html).toContain("<hr>");
  });

  it("escapes raw html and omits active or external resources", () => {
    const preview = renderSafeMarkdown([
      "# 安全边界",
      "",
      "<script>alert(1)</script>",
      "<iframe src=\"https://evil.example\"></iframe>",
      "<span onclick=\"steal()\">原始 HTML</span>",
      "![远程图](https://evil.example/image.png)",
      "[外链](https://evil.example)"
    ].join("\n"));

    expect(preview.html).not.toMatch(/<script|<iframe|<img|<a|<span/i);
    expect(preview.html).not.toMatch(/<[^>]+(?:href|src|on[a-z]+|style)=/i);
    expect(preview.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(preview.html).toContain("远程图");
    expect(preview.html).toContain("外链");
  });
});
