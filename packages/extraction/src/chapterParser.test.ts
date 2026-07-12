import { describe, expect, it } from "vitest";
import { ChapterParseError, isChapterHeading, parseChapters } from "./chapterParser";

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

  it("parses section-number headings used by 修真世界", () => {
    const chapters = parseChapters(
      ["正文", "第一节 《小云雨诀》", "第一节正文", "第九百一十五节 大结局", "结局正文"].join(
        "\n"
      )
    );

    expect(chapters).toEqual([
      { index: 0, title: "第一节 《小云雨诀》", content: "第一节正文" },
      { index: 1, title: "第九百一十五节 大结局", content: "结局正文" }
    ]);
  });

  it("keeps standalone volume context without creating empty chapters", () => {
    const chapters = parseChapters(
      [
        "第一卷 初入修真",
        "卷首说明",
        "第一章 起点",
        "第一卷正文",
        "第二卷 远行",
        "第一章 重启",
        "第二卷正文"
      ].join("\n")
    );

    expect(chapters).toEqual([
      {
        index: 0,
        title: "第一卷 初入修真 · 第一章 起点",
        content: "卷首说明\n第一卷正文"
      },
      {
        index: 1,
        title: "第二卷 远行 · 第一章 重启",
        content: "第二卷正文"
      }
    ]);
  });

  it("supports configurable common heading families and decorated headings", () => {
    const chapters = parseChapters(
      [
        "## 序章 风起",
        "序章正文",
        "【第１２回：再会】",
        "回目正文",
        "Chapter IV - Return",
        "English body",
        "番外 其一",
        "番外正文"
      ].join("\n")
    );

    expect(chapters.map(({ title }) => title)).toEqual([
      "序章 风起",
      "第１２回：再会",
      "Chapter IV - Return",
      "番外 其一"
    ]);
  });

  it("does not treat prose beginning with a structural ordinal as a heading", () => {
    expect(isChapterHeading("第一篇名为《定神篇》，讲的是如何入定安神。")).toBe(false);
  });

  it("recognizes common outer decorations around chapter headings", () => {
    expect(isChapterHeading("**第一章 标题**")).toBe(true);
    expect(isChapterHeading("__第一章 标题__")).toBe(true);
    expect(isChapterHeading("《第一章 标题》")).toBe(true);
    expect(isChapterHeading("--- 第一章 标题 ---")).toBe(true);
  });

  it("does not treat a prose sentence beginning with a chapter ordinal as a heading", () => {
    expect(isChapterHeading("第一章 是我最喜欢的一章，因为情节很好。")).toBe(false);
  });

  it("keeps short chapter titles that use expressive punctuation", () => {
    expect(isChapterHeading("第三百一十九节 要战，就战！")).toBe(true);
    expect(isChapterHeading("第六百五十一节 趁他病，要他命！")).toBe(true);
  });

  it("does not repeat a volume marker already present in the chapter heading", () => {
    const chapters = parseChapters("第一卷 卷名\n第一卷 第一章 开端\n正文");

    expect(chapters).toEqual([
      {
        index: 0,
        title: "第一卷 第一章 开端",
        content: "正文"
      }
    ]);
  });
});
