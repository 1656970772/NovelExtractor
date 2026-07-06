import { describe, expect, it } from "vitest";
import {
  isJsonObject,
  normalizeInputSchema,
  stableJsonValue,
  toToolDefinition,
} from "./toolDefinition";
import type {
  JsonObject,
  JsonSchemaValue,
  ProviderToolSource,
  ToolDefinition,
} from "./toolDefinition";

describe("ToolDefinition", () => {
  it("keeps name, description, and nested array input schema", () => {
    const source: ProviderToolSource = {
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
    };

    const tool: ToolDefinition = toToolDefinition(source);

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

  it("falls back to the minimal object input schema for invalid parameters", () => {
    expect(normalizeInputSchema(["not", "a", "schema"])).toEqual({
      type: "object",
    });
  });

  it("exports the JSON schema object guard", () => {
    const value: JsonSchemaValue = { z: true, a: null };

    expect(isJsonObject(value)).toBe(true);
    expect(isJsonObject(["array"])).toBe(false);
  });

  it("sorts object keys but keeps array order for stable JSON encoding", () => {
    const result: unknown = stableJsonValue({
      b: 2,
      a: [
        { d: 4, c: 3 },
        { b: 2, a: 1 },
      ],
    });

    expect(result).toEqual({
      a: [
        { c: 3, d: 4 },
        { a: 1, b: 2 },
      ],
      b: 2,
    });

    expect((result as JsonObject).a).toEqual([
      { c: 3, d: 4 },
      { a: 1, b: 2 },
    ]);
  });
});
