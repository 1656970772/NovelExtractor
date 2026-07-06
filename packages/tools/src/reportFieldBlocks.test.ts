import { describe, expect, it } from "vitest";
import { applyReportFieldUpdates, readReportFieldBlocks, replaceReportFieldBlocks } from "./reportFieldBlocks";
import type { ReportFieldWriteResult } from "./reportFieldBlocks";

if (false) {
  // @ts-expect-error replaceReportFieldBlocks only accepts replace_field updates.
  replaceReportFieldBlocks({ content: "", updates: [{ operation: "add_card", cardName: "韩立", content: "### 韩立" }] });
}

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

function expectWriteOk(result: ReportFieldWriteResult): asserts result is Extract<ReportFieldWriteResult, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.message);
  }
}

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

describe("report field update operations", () => {
  it("creates a missing report with a title and a new card", () => {
    const result = applyReportFieldUpdates({
      outputFileName: "NPC性格与代表事件.md",
      content: "",
      updates: [
        {
          operation: "add_card",
          cardName: "舞岩",
          content: "### 舞岩\n\n- 角色定位：七玄门相关少年。\n- 核心性格：原文未说明。"
        }
      ]
    });

    expectWriteOk(result);
    expect(result.changed).toBe(true);
    expect(result.content).toBe(
      "# NPC性格与代表事件\n\n### 舞岩\n\n- 角色定位：七玄门相关少年。\n- 核心性格：原文未说明。\n"
    );
    expect(result.operations).toEqual([
      { operation: "add_card", cardName: "舞岩", status: "created_report_and_card" }
    ]);
  });

  it("creates a missing report with a title, card, and field when add_field starts from empty content", () => {
    const result = applyReportFieldUpdates({
      outputFileName: "NPC性格与代表事件.md",
      content: "",
      updates: [
        {
          operation: "add_field",
          cardName: "韩立",
          fieldName: "变化与后果",
          content: "- 变化与后果：本窗口新增了入门机会。"
        }
      ]
    });

    expectWriteOk(result);
    expect(result.changed).toBe(true);
    expect(result.content).toBe("# NPC性格与代表事件\n\n### 韩立\n\n- 变化与后果：本窗口新增了入门机会。\n");
    expect(result.operations).toEqual([
      {
        operation: "add_field",
        cardName: "韩立",
        fieldName: "变化与后果",
        status: "created_report_card_and_field"
      }
    ]);
  });

  it("returns the existing card content when add_card targets an existing card", () => {
    const content = "### 韩立\n\n- 角色定位：主角\n- 核心性格：谨慎\n\n### 三叔\n\n- 角色定位：亲属\n";
    const result = applyReportFieldUpdates({
      outputFileName: "NPC性格与代表事件.md",
      content,
      updates: [{ operation: "add_card", cardName: "韩立", content: "### 韩立\n\n- 代表行为：新增" }]
    });

    expectWriteOk(result);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(content);
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toMatchObject({
      operation: "add_card",
      cardName: "韩立",
      status: "card_already_exists",
      existingContent: "### 韩立\n\n- 角色定位：主角\n- 核心性格：谨慎\n\n"
    });
    const operation = result.operations[0];
    expect(operation.operation).toBe("add_card");
    if (operation.operation !== "add_card") return;
    expect(operation.message).toContain("卡片已存在");
  });

  it("adds a missing field to an existing card", () => {
    const content = "### 韩立\n\n- 角色定位：主角\n";
    const result = applyReportFieldUpdates({
      outputFileName: "NPC性格与代表事件.md",
      content,
      updates: [
        {
          operation: "add_field",
          cardName: "韩立",
          fieldName: "变化与后果",
          content: "- 变化与后果：获得入门机会。"
        }
      ]
    });

    expectWriteOk(result);
    expect(result.changed).toBe(true);
    expect(result.content).toBe("### 韩立\n\n- 角色定位：主角\n- 变化与后果：获得入门机会。\n");
    expect(result.operations).toEqual([
      { operation: "add_field", cardName: "韩立", fieldName: "变化与后果", status: "created_field" }
    ]);
  });

  it("creates a missing card when add_field targets a new card", () => {
    const content = "### 韩立\n\n- 角色定位：主角\n";
    const result = applyReportFieldUpdates({
      outputFileName: "NPC性格与代表事件.md",
      content,
      updates: [
        {
          operation: "add_field",
          cardName: "舞岩",
          fieldName: "核心性格",
          content: "- 核心性格：原文未说明。"
        }
      ]
    });

    expectWriteOk(result);
    expect(result.changed).toBe(true);
    expect(result.content).toBe("### 韩立\n\n- 角色定位：主角\n\n### 舞岩\n\n- 核心性格：原文未说明。\n");
    expect(result.operations).toEqual([
      { operation: "add_field", cardName: "舞岩", fieldName: "核心性格", status: "created_card_and_field" }
    ]);
  });

  it("returns the existing field block when add_field targets an existing field", () => {
    const content = "### 韩立\n\n- 角色定位：主角\n- 核心性格：谨慎\n  - 证据：先观察\n- 代表行为：缩到角落\n";
    const result = applyReportFieldUpdates({
      outputFileName: "NPC性格与代表事件.md",
      content,
      updates: [
        {
          operation: "add_field",
          cardName: "韩立",
          fieldName: "核心性格",
          content: "- 核心性格：新增内容"
        }
      ]
    });

    expectWriteOk(result);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(content);
    expect(result.operations[0]).toMatchObject({
      operation: "add_field",
      cardName: "韩立",
      fieldName: "核心性格",
      status: "field_already_exists",
      existingContent: "- 核心性格：谨慎\n  - 证据：先观察\n"
    });
    const operation = result.operations[0];
    expect(operation.operation).toBe("add_field");
    if (operation.operation !== "add_field") return;
    expect(operation.message).toContain("字段块已存在");
  });

  it("pre-scans the full batch before writing when a later add_field target already exists", () => {
    const content = "### 韩立\n\n- 核心性格：谨慎\n";
    const result = applyReportFieldUpdates({
      outputFileName: "NPC性格与代表事件.md",
      content,
      updates: [
        { operation: "add_card", cardName: "舞岩", content: "### 舞岩\n\n- 角色定位：少年" },
        { operation: "add_field", cardName: "韩立", fieldName: "核心性格", content: "- 核心性格：覆盖尝试" }
      ]
    });

    expectWriteOk(result);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(content);
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toMatchObject({
      operation: "add_field",
      cardName: "韩立",
      fieldName: "核心性格",
      status: "field_already_exists"
    });
    expect(result.content).not.toContain("### 舞岩");
  });

  it("pre-scans the full batch before writing when a later add_card target already exists", () => {
    const content = "### 韩立\n\n- 核心性格：谨慎\n";
    const result = applyReportFieldUpdates({
      outputFileName: "NPC性格与代表事件.md",
      content,
      updates: [
        { operation: "add_field", cardName: "舞岩", fieldName: "角色定位", content: "- 角色定位：少年" },
        { operation: "add_card", cardName: "韩立", content: "### 韩立\n\n- 代表行为：覆盖尝试" }
      ]
    });

    expectWriteOk(result);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(content);
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toMatchObject({
      operation: "add_card",
      cardName: "韩立",
      status: "card_already_exists"
    });
    expect(result.content).not.toContain("### 舞岩");
  });

  it("rejects duplicate add_field targets within the same batch before writing", () => {
    const content = "### 韩立\n- 角色定位：主角\n";
    const result = applyReportFieldUpdates({
      outputFileName: "NPC性格与代表事件.md",
      content,
      updates: [
        { operation: "add_field", cardName: "韩立", fieldName: "核心性格", content: "- 核心性格：A" },
        { operation: "add_field", cardName: "韩立", fieldName: "核心性格", content: "- 核心性格：B" }
      ]
    });

    expectWriteOk(result);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(content);
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toMatchObject({
      operation: "add_field",
      cardName: "韩立",
      fieldName: "核心性格",
      status: "field_already_exists",
      existingContent: "- 核心性格：A\n"
    });
    const operation = result.operations[0];
    expect(operation.operation).toBe("add_field");
    if (operation.operation !== "add_field") return;
    expect(operation.message).toContain("字段块已存在");
  });

  it("rejects duplicate add_card targets within the same batch before writing", () => {
    const content = "### 三叔\n- 角色定位：亲属\n";
    const result = applyReportFieldUpdates({
      outputFileName: "NPC性格与代表事件.md",
      content,
      updates: [
        { operation: "add_card", cardName: "韩立", content: "### 韩立\n\n- 角色定位：主角" },
        { operation: "add_card", cardName: "韩立", content: "### 韩立\n\n- 角色定位：重复" }
      ]
    });

    expectWriteOk(result);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(content);
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toMatchObject({
      operation: "add_card",
      cardName: "韩立",
      status: "card_already_exists",
      existingContent: "### 韩立\n\n- 角色定位：主角\n"
    });
    const operation = result.operations[0];
    expect(operation.operation).toBe("add_card");
    if (operation.operation !== "add_card") return;
    expect(operation.message).toContain("卡片已存在");
  });

  it("rejects add_field when an earlier add_card in the same batch already contains the field", () => {
    const content = "";
    const result = applyReportFieldUpdates({
      outputFileName: "NPC性格与代表事件.md",
      content,
      updates: [
        { operation: "add_card", cardName: "韩立", content: "### 韩立\n\n- 核心性格：谨慎\n- 角色定位：主角" },
        { operation: "add_field", cardName: "韩立", fieldName: "核心性格", content: "- 核心性格：重复" }
      ]
    });

    expectWriteOk(result);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(content);
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toMatchObject({
      operation: "add_field",
      cardName: "韩立",
      fieldName: "核心性格",
      status: "field_already_exists",
      existingContent: "- 核心性格：谨慎\n"
    });
    const operation = result.operations[0];
    expect(operation.operation).toBe("add_field");
    if (operation.operation !== "add_field") return;
    expect(operation.message).toContain("字段块已存在");
  });

  it("adds a missing card heading and preserves CRLF when add_card content has no heading", () => {
    const content = "### 韩立\r\n\r\n- 核心性格：谨慎\r\n";
    const result = applyReportFieldUpdates({
      outputFileName: "NPC性格与代表事件.md",
      content,
      updates: [{ operation: "add_card", cardName: "舞岩", content: "- 角色定位：七玄门相关少年。" }]
    });

    expectWriteOk(result);
    expect(result.changed).toBe(true);
    expect(result.content).toBe(
      "### 韩立\r\n\r\n- 核心性格：谨慎\r\n\r\n### 舞岩\r\n\r\n- 角色定位：七玄门相关少年。\r\n"
    );
    expect(result.operations).toEqual([{ operation: "add_card", cardName: "舞岩", status: "created_card" }]);
  });

  it("rejects add_card content whose leading card heading does not match the target card", () => {
    const result = applyReportFieldUpdates({
      outputFileName: "NPC性格与代表事件.md",
      content: "",
      updates: [{ operation: "add_card", cardName: "舞岩", content: "### 韩立\n\n- 角色定位：少年" }]
    });

    expect(result).toMatchObject({ ok: false, code: "INVALID_CARD_CONTENT" });
  });

  it("rejects blank add_card content", () => {
    const result = applyReportFieldUpdates({
      outputFileName: "NPC性格与代表事件.md",
      content: "",
      updates: [{ operation: "add_card", cardName: "韩立", content: "   \n\t" }]
    });

    expect(result).toMatchObject({ ok: false, code: "INVALID_CARD_CONTENT" });
  });

  it("rejects add_card content that contains a mismatched card heading after the first line", () => {
    const result = applyReportFieldUpdates({
      outputFileName: "NPC性格与代表事件.md",
      content: "",
      updates: [
        {
          operation: "add_card",
          cardName: "韩立",
          content: "- 核心性格：谨慎\n\n### 舞岩\n\n- 核心性格：傲慢"
        }
      ]
    });

    expect(result).toMatchObject({ ok: false, code: "INVALID_CARD_CONTENT" });
  });

  it("keeps replace_field compatible with the existing replacement behavior", () => {
    const result = applyReportFieldUpdates({
      outputFileName: "NPC性格与代表事件.md",
      content: npcReport,
      updates: [
        {
          operation: "replace_field",
          cardName: "韩立",
          fieldName: "核心性格",
          content: "- 核心性格：谨慎、隐忍、有韧劲\n  - 证据：当前窗口原文说明"
        }
      ]
    });

    expectWriteOk(result);
    expect(result.changed).toBe(true);
    expect(result.content).toContain("- 角色定位：主角");
    expect(result.content).toContain("- 核心性格：谨慎、隐忍、有韧劲");
    expect(result.content).toContain("- 代表行为：在马车上机灵地缩到车厢边角");
    expect(result.content).not.toContain("早熟、谨慎、隐忍");
    expect(result.operations).toEqual([
      { operation: "replace_field", cardName: "韩立", fieldName: "核心性格", status: "replaced_field" }
    ]);
  });
});
