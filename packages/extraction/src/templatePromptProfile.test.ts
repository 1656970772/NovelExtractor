import { describe, expect, it } from "vitest";
import { buildTemplatePromptProfile, renderTemplatePromptProfileCard } from "./templatePromptProfile";

const profileDefaults = {
  compressionVersion: "template-profile-v1",
  exampleSectionPatterns: ["^#{1,6}\\s*示例", "^案例\\d*[:：]"],
  referenceSectionPatterns: ["^#{1,6}\\s*参考", "^参考范围[:：]"],
  placeholderPatterns: ["^状态[:：]\\s*模板", "待补充", "\\{\\{[^}]+\\}\\}"],
  alwaysKeepHeadingPatterns: ["^#{1,6}\\s*字段", "^#{1,6}\\s*禁止", "^#{1,6}\\s*输出"],
  minProfileChars: 40
};

describe("template prompt profile", () => {
  it("removes examples, reference samples and placeholder text from the prompt card", () => {
    const profile = buildTemplatePromptProfile({
      defaults: profileDefaults,
      template: {
        id: "template-character",
        name: "人物关系模板",
        fileName: "人物关系.md",
        body: [
          "# 人物关系模板",
          "状态：模板",
          "",
          "## 字段",
          "- 人物",
          "- 关系",
          "- 当前窗口证据",
          "",
          "## 禁止事项",
          "- 禁止使用后续章节或全书先验。",
          "",
          "## 示例",
          "示例事件链：韩立未来结丹成功。",
          "",
          "## 参考范围",
          "参考范围：全书后续情节。",
          "",
          "待补充：{{人物名称}}"
        ].join("\n")
      },
      templateHash: "hash-character"
    });
    const card = renderTemplatePromptProfileCard(profile);

    expect(profile.fallback).toBe(false);
    expect(card).toContain("templateId: template-character");
    expect(card).toContain("templateName: 人物关系模板");
    expect(card).toContain("outputFileName: 人物关系.md");
    expect(card).toContain("templateHash: hash-character");
    expect(card).toContain("compressionVersion: template-profile-v1");
    expect(card).toContain("人物");
    expect(card).toContain("禁止使用后续章节");
    expect(card).not.toContain("状态：模板");
    expect(card).not.toContain("示例事件链");
    expect(card).not.toContain("参考范围：全书后续情节");
    expect(card).not.toContain("{{人物名称}}");
  });

  it("falls back with a diagnostic card when the compressed profile is too small", () => {
    const profile = buildTemplatePromptProfile({
      defaults: { ...profileDefaults, minProfileChars: 200 },
      template: {
        id: "template-empty",
        name: "空模板",
        fileName: "空模板.md",
        body: "## 示例\n示例内容：待补充。"
      },
      templateHash: "hash-empty"
    });
    const card = renderTemplatePromptProfileCard(profile);

    expect(profile.fallback).toBe(true);
    expect(profile.fallbackReason).toContain("压缩后内容不足");
    expect(card).toContain("profileFallback: true");
    expect(card).toContain("templateId: template-empty");
    expect(card).toContain("outputFileName: 空模板.md");
  });
});
