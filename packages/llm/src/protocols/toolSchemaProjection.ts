import type { JsonObject } from "../toolDefinition";
import { isJsonObject, stableJsonValue } from "../toolDefinition";

export type ToolSchemaProjectionTarget = "openai" | "anthropic" | "gemini" | "bedrock";

const GEMINI_SCHEMA_INTENT_KEYS = [
  "type",
  "properties",
  "items",
  "prefixItems",
  "enum",
  "const",
  "$ref",
  "additionalProperties",
  "patternProperties",
  "required",
  "not",
  "if",
  "then",
  "else",
];

function hasCombiner(schema: unknown): boolean {
  return (
    isJsonObject(schema) &&
    (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf) || Array.isArray(schema.allOf))
  );
}

function hasSchemaIntent(schema: unknown): boolean {
  return isJsonObject(schema) && (hasCombiner(schema) || GEMINI_SCHEMA_INTENT_KEYS.some((key) => key in schema));
}

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

function sanitizeOpenAiNode(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeOpenAiNode);
  }

  if (typeof value === "boolean") {
    return {};
  }

  if (!isJsonObject(value)) {
    return value;
  }

  const result: Record<string, unknown> = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "additionalProperties" ? item : sanitizeOpenAiNode(item),
    ]),
  );

  if (result.type === "array" && result.items === undefined) {
    result.items = {};
  }

  return result;
}

function sanitizeGeminiNode(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeGeminiNode);
  }

  if (!isJsonObject(value)) {
    return value;
  }

  const result: Record<string, unknown> = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "enum" && Array.isArray(item) ? item.map(String) : sanitizeGeminiNode(item),
    ]),
  );

  if (Array.isArray(result.enum) && (result.type === "integer" || result.type === "number")) {
    result.type = "string";
  }

  const properties = result.properties;
  if (result.type === "object" && isJsonObject(properties) && Array.isArray(result.required)) {
    result.required = result.required.filter((field) => typeof field === "string" && field in properties);
  }

  if (result.type === "array" && !hasCombiner(result)) {
    result.items = result.items ?? {};
    if (isJsonObject(result.items) && !hasSchemaIntent(result.items)) {
      result.items = { ...result.items, type: "string" };
    }
  }

  if (typeof result.type === "string" && result.type !== "object" && !hasCombiner(result)) {
    delete result.properties;
    delete result.required;
  }

  return result;
}

function isEmptyObjectSchema(schema: JsonObject): boolean {
  return (
    schema.type === "object" &&
    (!isJsonObject(schema.properties) || Object.keys(schema.properties).length === 0) &&
    !schema.additionalProperties
  );
}

function entriesWithProjectedValues(entries: [string, unknown][]): [string, unknown][] {
  return entries.filter((entry): entry is [string, unknown] => entry[1] !== undefined);
}

function projectGeminiNode(value: unknown): Record<string, unknown> | undefined {
  if (!isJsonObject(value) || isEmptyObjectSchema(value)) {
    return undefined;
  }

  const properties = isJsonObject(value.properties)
    ? Object.fromEntries(
        entriesWithProjectedValues(
          Object.entries(value.properties).map(([key, item]) => [key, projectGeminiNode(item)]),
        ),
      )
    : undefined;
  const required = Array.isArray(value.required)
    ? value.required.filter((field) => typeof field === "string" && properties !== undefined && field in properties)
    : undefined;

  const projectNodeList = (items: unknown[]) => entriesWithProjectedValues(items.map((item) => ["", projectGeminiNode(item)])).map(
    ([, item]) => item,
  );

  return Object.fromEntries(
    entriesWithProjectedValues([
      ["description", value.description],
      ["required", required],
      ["format", value.format],
      ["type", Array.isArray(value.type) ? value.type.filter((type) => type !== "null")[0] : value.type],
      ["nullable", Array.isArray(value.type) && value.type.includes("null") ? true : undefined],
      ["enum", value.const !== undefined ? [value.const] : value.enum],
      ["properties", properties],
      [
        "items",
        Array.isArray(value.items)
          ? projectNodeList(value.items)
          : value.items === undefined
            ? undefined
            : projectGeminiNode(value.items),
      ],
      ["allOf", Array.isArray(value.allOf) ? projectNodeList(value.allOf) : undefined],
      ["anyOf", Array.isArray(value.anyOf) ? projectNodeList(value.anyOf) : undefined],
      ["oneOf", Array.isArray(value.oneOf) ? projectNodeList(value.oneOf) : undefined],
      ["minLength", value.minLength],
    ]),
  );
}

function openAiProjection(schema: JsonObject): JsonObject {
  const variants = Array.isArray(schema.anyOf) ? schema.anyOf.filter(isJsonObject) : [];
  const flattened =
    variants.length === 0
      ? { ...schema, type: "object" }
      : {
          ...Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "anyOf")),
          type: "object",
          properties: variants.reduce<Record<string, unknown>>(
            (properties, variant) => ({
              ...(isJsonObject(variant.properties) ? variant.properties : {}),
              ...properties,
            }),
            {},
          ),
          additionalProperties: false,
        };
  const normalized = sanitizeOpenAiNode(removeNullSchemas(flattened));
  return (isJsonObject(normalized) ? stableJsonValue(normalized) : { type: "object" }) as JsonObject;
}

function geminiProjection(schema: JsonObject): JsonObject {
  const projected = projectGeminiNode(sanitizeGeminiNode(schema));
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
