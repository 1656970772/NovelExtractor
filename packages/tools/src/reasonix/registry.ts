import type { ReasonixDiffChange } from "./diff";

export interface ReasonixToolDefinition {
  name: string;
  description(): string;
  schema(): unknown;
  readOnly(): boolean;
}

export interface ReasonixTool extends ReasonixToolDefinition {
  execute(args: unknown): Promise<string> | string;
}

export interface ReasonixToolPreviewer {
  preview(args: unknown): Promise<ReasonixDiffChange> | ReasonixDiffChange;
}

export type ReasonixPreviewableTool = ReasonixTool & ReasonixToolPreviewer;

export interface ReasonixProviderToolSchema {
  name: string;
  description: string;
  parameters: unknown;
}

export const MCPNamePrefix = "mcp__";

export class Registry {
  private readonly toolsByName = new Map<string, ReasonixToolDefinition>();
  private readonly order: string[] = [];
  private readonly canonicalSchemas = new Map<string, unknown>();
  private readonly canonicalSchemaJSON = new Map<string, string>();
  private readonly suspendedPrefixes = new Set<string>();

  add(tool: ReasonixToolDefinition): void {
    for (const prefix of this.suspendedPrefixes) {
      if (tool.name.startsWith(prefix)) {
        return;
      }
    }

    if (!this.toolsByName.has(tool.name)) {
      this.order.push(tool.name);
    }
    this.toolsByName.set(tool.name, tool);
    const schema = tool.schema();
    const parameters = canonicalizeSchemaParameterValue(schema);
    this.canonicalSchemas.set(tool.name, parameters);
    this.canonicalSchemaJSON.set(tool.name, canonicalizeSchemaJSON(schema));
  }

  removePrefix(prefix: string): number {
    return this.removeMatchingPrefix(prefix);
  }

  suspendPrefix(prefix: string): number {
    this.suspendedPrefixes.add(prefix);
    return this.removeMatchingPrefix(prefix);
  }

  resumePrefix(prefix: string): void {
    this.suspendedPrefixes.delete(prefix);
  }

  get(name: string): ReasonixToolDefinition | undefined {
    return this.toolsByName.get(name);
  }

  len(): number {
    return this.order.length;
  }

  names(): string[] {
    return [...this.order];
  }

  schemas(): ReasonixProviderToolSchema[] {
    return [...this.order]
      .sort(compareASCII)
      .flatMap((name) => {
        const tool = this.toolsByName.get(name);
        if (tool === undefined) {
          return [];
        }

        return [
          {
            name: tool.name,
            description: tool.description(),
            parameters: this.canonicalSchemas.get(name)
          }
        ];
      });
  }

  schemasJSON(): string {
    const schemas = [...this.order]
      .sort(compareASCII)
      .flatMap((name) => {
        const tool = this.toolsByName.get(name);
        if (tool === undefined) {
          return [];
        }

        const parameters = this.canonicalSchemaJSON.get(name) ?? "";
        JSON.parse(parameters);

        return [
          `{"description":${stringifyGoJSON(tool.description())},"name":${stringifyGoJSON(tool.name)},"parameters":${parameters}}`
        ];
      });

    return `[${schemas.join(",")}]`;
  }

  private removeMatchingPrefix(prefix: string): number {
    let removed = 0;
    for (let index = this.order.length - 1; index >= 0; index -= 1) {
      const name = this.order[index];
      if (!name.startsWith(prefix)) {
        continue;
      }

      this.order.splice(index, 1);
      this.toolsByName.delete(name);
      this.canonicalSchemas.delete(name);
      this.canonicalSchemaJSON.delete(name);
      removed += 1;
    }

    return removed;
  }
}

export function splitMCPName(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith(MCPNamePrefix)) {
    return undefined;
  }

  const rest = name.slice(MCPNamePrefix.length);
  const separatorIndex = rest.indexOf("__");
  if (separatorIndex <= 0 || separatorIndex === rest.length - 2) {
    return undefined;
  }

  return {
    server: rest.slice(0, separatorIndex),
    tool: rest.slice(separatorIndex + 2)
  };
}

export function canonicalizeSchema(value: unknown): unknown {
  if (value === undefined) {
    return { type: "object" };
  }

  return canonicalizeSchemaObject(value);
}

export function canonicalizeSchemaJSON(value: unknown): string {
  const raw = rawSchemaBytesToString(value);
  if (raw !== undefined) {
    if (raw.length === 0) {
      return stringifyGoJSON(canonicalizeSchema(undefined));
    }

    try {
      return stringifyGoJSON(canonicalizeSchema(JSON.parse(raw) as unknown));
    } catch {
      return raw;
    }
  }

  return stringifyGoJSON(canonicalizeSchema(value));
}

function canonicalizeSchemaParameterValue(value: unknown): unknown {
  const raw = rawSchemaBytesToString(value);
  if (raw === undefined) {
    return canonicalizeSchema(value);
  }
  if (raw.length === 0) {
    return canonicalizeSchema(undefined);
  }

  try {
    return canonicalizeSchema(JSON.parse(raw) as unknown);
  } catch {
    return value;
  }
}

function rawSchemaBytesToString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Uint8Array) {
    return new TextDecoder().decode(value);
  }
  if (value instanceof ArrayBuffer) {
    return new TextDecoder().decode(value);
  }
  return undefined;
}

function canonicalizeSchemaObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeSchemaObject(item));
  }

  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const output = Object.fromEntries(
      Object.keys(source)
        .sort(compareASCII)
        .map((key) => {
          const inner = source[key];
          switch (key) {
            case "properties":
            case "patternProperties":
            case "$defs":
            case "definitions":
            case "dependentSchemas":
              return [key, canonicalizeNamedSchemas(inner)];
            case "dependentRequired":
              return [key, canonicalizeDependentRequired(inner)];
            default:
              return [key, canonicalizeSchemaObject(inner)];
          }
        })
    );

    if ("required" in output) {
      if (Array.isArray(output.required)) {
        output.required = sortSchemaArray(output.required);
      } else {
        delete output.required;
      }
    }

    if ("dependentRequired" in output && !isJsonObject(output.dependentRequired)) {
      delete output.dependentRequired;
    }

    return sortObjectKeys(output);
  }

  return value;
}

function canonicalizeNamedSchemas(value: unknown): unknown {
  if (!isJsonObject(value)) {
    return canonicalizeSchemaObject(value);
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort(compareASCII)
      .map((key) => [key, canonicalizeSchemaObject(value[key])])
  );
}

function canonicalizeDependentRequired(value: unknown): unknown {
  if (!isJsonObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort(compareASCII)
      .flatMap((key) => {
        const inner = value[key];
        return Array.isArray(inner) ? [[key, sortSchemaArray(inner)]] : [];
      })
  );
}

function sortSchemaArray(value: unknown[]): unknown[] {
  return [...value].sort((left, right) => compareASCII(schemaJSONString(left), schemaJSONString(right)));
}

function schemaJSONString(value: unknown): string {
  return stringifyGoJSON(value);
}

function stringifyGoJSON(value: unknown): string {
  return goEscapeJSONString(JSON.stringify(stableJSONValue(value)) ?? "");
}

function goEscapeJSONString(value: string): string {
  return value.replace(/[<>&\u2028\u2029]/gu, (character) => {
    switch (character) {
      case "<":
        return "\\u003c";
      case ">":
        return "\\u003e";
      case "&":
        return "\\u0026";
      case "\u2028":
        return "\\u2028";
      case "\u2029":
        return "\\u2029";
      default:
        return character;
    }
  });
}

function stableJSONValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableJSONValue(item));
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareASCII)
        .map((key) => [key, stableJSONValue(value[key])])
    );
  }
  return value;
}

function sortObjectKeys(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(value).sort(compareASCII).map((key) => [key, value[key]]));
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareASCII(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
