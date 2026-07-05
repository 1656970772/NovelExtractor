import { describe, expect, it } from "vitest";
import { readReportFieldBlocks, replaceReportFieldBlocks } from "./reportFieldBlocks";

const npcReport = [
  "## NPC性格与代表事件卡片",
  "",
  "### 韩立",
  "",
  "- 角色定位：主角，出身镜州偏僻山村的十岁少年",
  "- 核心性格：早熟、谨慎、隐忍",
  "  - 面对陌生修仙门派时先观察，不随意出头",
  "  - 被张均救助后心生感激",
  "- 代表行为：在马车上机灵地缩到车厢边角",
  "",
  "### 三叔（韩胖子）",
  "",
  "- 角色定位：韩立的亲三叔",
  "- 核心性格：精明、重亲情",
  "- 代表行为：给韩立求情补名额"
].join("\n");

describe("reportFieldBlocks", () => {
  it("reads requested fields under card headings and keeps nested bullets inside the field", () => {
    const result = readReportFieldBlocks({
      outputFileName: "NPC性格与代表事件.md",
      content: npcReport,
      queries: [
        { cardName: "韩立", fields: ["角色定位", "核心性格", "代表行为"] },
        { cardName: "三叔（韩胖子）", fields: ["核心性格"] }
      ],
      maxChars: 8000
    });

    expect(result.truncated).toBe(false);
    expect(result.cards[0]).toMatchObject({ cardName: "韩立", found: true });
    expect(result.cards[0].fields.map((field) => [field.fieldName, field.found])).toEqual([
      ["角色定位", true],
      ["核心性格", true],
      ["代表行为", true]
    ]);
    expect(result.cards[0].fields[1].content).toContain("  - 面对陌生修仙门派时先观察");
    expect(result.cards[0].fields[1].content).not.toContain("- 代表行为：");
    expect(result.cards[1].fields[0].content).toBe("- 核心性格：精明、重亲情");
  });

  it("marks missing cards and fields without throwing during read", () => {
    const result = readReportFieldBlocks({
      outputFileName: "NPC性格与代表事件.md",
      content: npcReport,
      queries: [
        { cardName: "韩立", fields: ["变化与后果"] },
        { cardName: "舞岩", fields: ["核心性格"] }
      ]
    });

    expect(result.cards[0]).toMatchObject({
      cardName: "韩立",
      found: true,
      fields: [{ fieldName: "变化与后果", found: false }]
    });
    expect(result.cards[1]).toMatchObject({
      cardName: "舞岩",
      found: false,
      fields: [{ fieldName: "核心性格", found: false }]
    });
  });

  it("replaces only the selected field block and preserves neighboring fields", () => {
    const result = replaceReportFieldBlocks({
      content: npcReport,
      updates: [
        {
          cardName: "韩立",
          fieldName: "核心性格",
          content: "- 核心性格：谨慎、隐忍、有韧劲\n  - 证据：当前窗口原文说明"
        }
      ]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain("- 角色定位：主角");
    expect(result.content).toContain("- 核心性格：谨慎、隐忍、有韧劲");
    expect(result.content).toContain("- 代表行为：在马车上机灵地缩到车厢边角");
    expect(result.content).not.toContain("早熟、谨慎、隐忍");
  });

  it("rejects replacement content whose leading field name does not match the coordinate", () => {
    const result = replaceReportFieldBlocks({
      content: npcReport,
      updates: [{ cardName: "韩立", fieldName: "核心性格", content: "- 代表行为：写错字段" }]
    });

    expect(result).toMatchObject({ ok: false, code: "INVALID_FIELD_CONTENT" });
  });

  it("rejects ambiguous duplicate fields in the same card", () => {
    const result = replaceReportFieldBlocks({
      content: "### 韩立\n- 核心性格：A\n- 核心性格：B\n",
      updates: [{ cardName: "韩立", fieldName: "核心性格", content: "- 核心性格：C" }]
    });

    expect(result).toMatchObject({ ok: false, code: "FIELD_AMBIGUOUS" });
  });

  it("preserves CRLF line endings when replacing a field", () => {
    const report = "### 韩立\r\n- 核心性格：旧\r\n- 代表行为：旧\r\n";
    const result = replaceReportFieldBlocks({
      content: report,
      updates: [{ cardName: "韩立", fieldName: "核心性格", content: "- 核心性格：新\n  - 证据：窗口" }]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe("### 韩立\r\n- 核心性格：新\r\n  - 证据：窗口\r\n- 代表行为：旧\r\n");
  });

  it("truncates oversized read output and tells the model to split queries", () => {
    const longReport = `### 韩立\n- 核心性格：${"谨慎".repeat(400)}\n- 代表行为：${"行动".repeat(400)}\n`;
    const result = readReportFieldBlocks({
      outputFileName: "NPC性格与代表事件.md",
      content: longReport,
      queries: [{ cardName: "韩立", fields: ["核心性格", "代表行为"] }],
      maxChars: 500
    });

    expect(result.truncated).toBe(true);
    expect(result.message).toContain("分批读取");
    expect(result.cards[0].fields[0].truncated).toBe(true);
    const returnedChars = result.cards[0].fields.reduce((sum, field) => sum + (field.content?.length ?? 0), 0);
    expect(returnedChars).toBeLessThanOrEqual(500);
  });

  it("stops a card body at # or ## headings before parsing later field-like lines", () => {
    const report = ["# 人物", "### 韩立", "- 核心性格：谨慎", "## 其他分组", "- 核心性格：不应属于韩立"].join("\n");
    const result = readReportFieldBlocks({
      outputFileName: "NPC性格与代表事件.md",
      content: report,
      queries: [{ cardName: "韩立", fields: ["核心性格"] }]
    });

    expect(result.cards[0].fields[0].content).toBe("- 核心性格：谨慎");
  });
});
