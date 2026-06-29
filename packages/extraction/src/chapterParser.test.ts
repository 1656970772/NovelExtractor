import { describe, expect, it } from "vitest";
import { ChapterParseError, parseChapters } from "./chapterParser";

describe("parseChapters", () => {
  it("parses common Chinese and English chapter headings", () => {
    const chapters = parseChapters(
      [
        "  第一章 起始  ",
        "起始正文",
        "",
        "第2章 转折",
        "转折正文",
        "第十二章",
        "十二正文",
        "卷一 第三章",
        "卷内正文",
        "Chapter 1",
        "English body"
      ].join("\n")
    );

    expect(chapters).toEqual([
      { index: 0, title: "第一章 起始", content: "起始正文" },
      { index: 1, title: "第2章 转折", content: "转折正文" },
      { index: 2, title: "第十二章", content: "十二正文" },
      { index: 3, title: "卷一 第三章", content: "卷内正文" },
      { index: 4, title: "Chapter 1", content: "English body" }
    ]);
  });

  it("keeps body text under the preceding chapter", () => {
    const chapters = parseChapters("第一章 起始\n第一段\n第二段\n第2章 转折\n第三段");

    expect(chapters[0]).toEqual({
      index: 0,
      title: "第一章 起始",
      content: "第一段\n第二段"
    });
  });

  it("throws ChapterParseError when no chapter heading exists", () => {
    expect(() => parseChapters("只有正文，没有章节标题")).toThrow(ChapterParseError);
  });
});
