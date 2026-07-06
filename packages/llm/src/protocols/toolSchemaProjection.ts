import type { JsonObject } from "../toolDefinition";
import { isJsonObject, stableJsonValue } from "../toolDefinition";

export type ToolSchemaProjectionTarget = "openai" | "anthropic" | "gemini" | "bedrock";

function removeNullSchemas(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(removeNullSchemas);
  }

  if (!isJsonObject(value)) {
    return value;
  }

  const fields = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "anyOf")
      .map(([key, item]) => [key, removeNullSchemas(item)]),
  );

  if (!Array.isArray(value.anyOf)) {
    return fields;
  }

  const variants = value.anyOf
    .filter((variant) => !isJsonObject(variant) || variant.type !== "null")
    .map(removeNullSchemas);

  if (variants.length === 1 && isJsonObject(variants[0])) {
    return { ...fields, ...variants[0] };
  }

  return { ...fields, anyOf: variants };
}

function stripKeys(value: unknown, blockedKeys: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripKeys(item, blockedKeys));
  }

  if (!isJsonObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !blockedKeys.has(key))
      .map(([key, item]) => [key, stripKeys(item, blockedKeys)]),
  );
}

function openAiProjection(schema: JsonObject): JsonObject {
  const normalized = removeNullSchemas({ ...schema, type: "object" });
  return (isJsonObject(normalized) ? stableJsonValue(normalized) : { type: "object" }) as JsonObject;
}

function geminiProjection(schema: JsonObject): JsonObject {
  const projected = stripKeys(schema, new Set(["additionalProperties", "$schema", "$defs", "definitions"]));
  return (isJsonObject(projected) ? stableJsonValue(projected) : { type: "object" }) as JsonObject;
}

export function projectToolSchema(target: ToolSchemaProjectionTarget, schema: JsonObject): JsonObject {
  switch (target) {
    case "openai":
      return openAiProjection(schema);
    case "gemini":
      return geminiProjection(schema);
    case "anthropic":
    case "bedrock":
      return stableJsonValue(schema) as JsonObject;
  }
}
