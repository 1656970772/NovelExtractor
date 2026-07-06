import { describe, expect, it } from "vitest";
import {
  encodeToolArguments,
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
    const description =
      "按 cardName + fieldName 新增或替换 Markdown 报告字段块，也可新增整张卡片。updates[].operation 支持 add_card、add_field、replace_field；缺省为 replace_field。add_card/add_field 命中已存在卡片或字段时不会覆盖，会返回 existingContent，并提示模型基于已有内容改用 replace_field。报告不存在时 add_card/add_field 会自动创建报告文件。";
    const source: ProviderToolSource = {
      name: "upsert_report_section",
      description,
      parameters: {
        type: "object",
        properties: {
          outputFileName: { type: "string" },
          updates: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                operation: { type: "string", enum: ["add_card", "add_field", "replace_field"] },
                cardName: { type: "string" },
                fieldName: { type: "string" },
                content: { type: "string" },
              },
              required: ["cardName", "content"],
              additionalProperties: false,
            },
          },
        },
        required: ["outputFileName", "updates"],
        additionalProperties: false,
      },
    };

    const tool: ToolDefinition = toToolDefinition(source);

    expect(tool).toEqual({
      name: "upsert_report_section",
      description,
      inputSchema: {
        type: "object",
        properties: {
          outputFileName: { type: "string" },
          updates: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                operation: { type: "string", enum: ["add_card", "add_field", "replace_field"] },
                cardName: { type: "string" },
                fieldName: { type: "string" },
                content: { type: "string" },
              },
              required: ["cardName", "content"],
              additionalProperties: false,
            },
          },
        },
        required: ["outputFileName", "updates"],
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

  it("rejects non-JSON objects and invalid nested fields", () => {
    expect(isJsonObject(new Date())).toBe(false);
    expect(isJsonObject(new Map())).toBe(false);
    expect(isJsonObject({ ok: true })).toBe(true);
    expect(isJsonObject({ bad: undefined })).toBe(false);
    expect(isJsonObject({ bad: () => undefined })).toBe(false);
    expect(isJsonObject({ nested: [{ a: null }] })).toBe(true);
  });

  it("falls back for non-JSON object input schemas", () => {
    expect(normalizeInputSchema(new Date())).toEqual({
      type: "object",
    });
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

  it("encodes tool arguments with string passthrough and stable JSON output", () => {
    expect(encodeToolArguments("raw text")).toBe("raw text");
    expect(encodeToolArguments({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(encodeToolArguments({ items: [{ b: 2, a: 1 }, "next"] })).toBe(
      '{"items":[{"a":1,"b":2},"next"]}',
    );
  });
});
