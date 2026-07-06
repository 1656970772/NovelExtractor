import { describe, expect, it } from "vitest";
import { toToolDefinition, stableJsonValue } from "./toolDefinition";

describe("ToolDefinition", () => {
  it("keeps name, description, and nested array input schema", () => {
    const tool = toToolDefinition({
      name: "upsert_report_section",
      description: "按 cardName + fieldName 替换已有 Markdown 报告字段块。",
      parameters: {
        type: "object",
        properties: {
          updates: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                cardName: { type: "string" },
                fieldName: { type: "string" },
                content: { type: "string" },
              },
              required: ["cardName", "fieldName", "content"],
              additionalProperties: false,
            },
          },
        },
        required: ["updates"],
        additionalProperties: false,
      },
    });

    expect(tool).toEqual({
      name: "upsert_report_section",
      description: "按 cardName + fieldName 替换已有 Markdown 报告字段块。",
      inputSchema: {
        type: "object",
        properties: {
          updates: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                cardName: { type: "string" },
                fieldName: { type: "string" },
                content: { type: "string" },
              },
              required: ["cardName", "fieldName", "content"],
              additionalProperties: false,
            },
          },
        },
        required: ["updates"],
        additionalProperties: false,
      },
    });
  });

  it("sorts object keys but keeps array order for stable JSON encoding", () => {
    expect(stableJsonValue({ b: 2, a: [{ d: 4, c: 3 }] })).toEqual({
      a: [{ c: 3, d: 4 }],
      b: 2,
    });
  });
});
