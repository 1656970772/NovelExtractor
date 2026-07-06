import { describe, expect, it } from "vitest";
import { projectToolSchema } from "./toolSchemaProjection";

describe("projectToolSchema", () => {
  const schema = {
    type: "object",
    properties: {
      outputFileName: { type: "string" },
      queries: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            cardName: { type: "string" },
            fields: {
              type: "array",
              minItems: 1,
              items: { type: "string" },
            },
          },
          required: ["cardName", "fields"],
          additionalProperties: false,
        },
      },
    },
    required: ["outputFileName", "queries"],
    additionalProperties: false,
  };

  it("keeps nested arrays for OpenAI-compatible tool parameters", () => {
    expect(projectToolSchema("openai", schema)).toMatchObject({
      type: "object",
      properties: {
        queries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              fields: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
      additionalProperties: false,
    });
  });

  it("flattens top-level anyOf object variants for OpenAI-compatible tool parameters", () => {
    const projected = projectToolSchema("openai", {
      anyOf: [
        { type: "object", properties: { path: { type: "string" } } },
        { type: "object", properties: { content: { type: "string" } } },
      ],
    });

    expect(projected).toEqual({
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      additionalProperties: false,
    });
    expect(projected).not.toHaveProperty("anyOf");
  });

  it("sanitizes OpenAI-compatible boolean property schemas and bare arrays", () => {
    const projected = projectToolSchema("openai", {
      type: "object",
      properties: {
        flag: true,
        list: { type: "array" },
        nullableName: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    });

    expect(projected).toMatchObject({
      type: "object",
      properties: {
        flag: {},
        list: { type: "array", items: {} },
        nullableName: { type: "string" },
      },
    });
    const properties = projected.properties as Record<string, unknown>;
    expect(properties.flag).not.toBe(true);
  });

  it("removes Gemini-incompatible additionalProperties while keeping array items", () => {
    const projected = projectToolSchema("gemini", schema);

    expect(JSON.stringify(projected)).not.toContain("additionalProperties");
    expect(projected).toMatchObject({
      type: "object",
      properties: {
        queries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              fields: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    });
  });

  it("cleans Gemini-incompatible schema shapes while preserving compatible intent", () => {
    const projected = projectToolSchema("gemini", {
      type: "object",
      properties: {
        numericChoice: { type: "number", enum: [1, 2] },
        integerChoice: { type: "integer", enum: [3, 4] },
        listWithoutItems: { type: "array" },
        scalarWithObjectFields: {
          type: "string",
          properties: { ignored: { type: "string" } },
          required: ["ignored"],
        },
        nullableName: { type: ["string", "null"] },
      },
      required: ["numericChoice", "missing"],
      additionalProperties: false,
    });

    expect(projected).toMatchObject({
      type: "object",
      required: ["numericChoice"],
      properties: {
        numericChoice: { type: "string", enum: ["1", "2"] },
        integerChoice: { type: "string", enum: ["3", "4"] },
        listWithoutItems: { type: "array", items: { type: "string" } },
        scalarWithObjectFields: { type: "string" },
        nullableName: { type: "string", nullable: true },
      },
    });
    const properties = projected.properties as Record<string, unknown>;
    expect(properties.scalarWithObjectFields).not.toHaveProperty("properties");
    expect(properties.scalarWithObjectFields).not.toHaveProperty("required");
  });

  it("keeps Gemini-compatible properties when sibling children project away", () => {
    const projected = projectToolSchema("gemini", {
      type: "object",
      properties: {
        meta: { type: "object", properties: {} },
        list: { type: "array" },
        name: { type: "string" },
      },
      required: ["meta", "list", "name"],
    });

    expect(projected).not.toEqual({ type: "object" });
    expect(projected).toMatchObject({
      type: "object",
      required: ["list", "name"],
      properties: {
        list: { type: "array", items: { type: "string" } },
        name: { type: "string" },
      },
    });
    expect(JSON.stringify(projected)).not.toContain("undefined");
  });
});
