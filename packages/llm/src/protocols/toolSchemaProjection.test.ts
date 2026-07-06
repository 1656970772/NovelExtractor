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
});
