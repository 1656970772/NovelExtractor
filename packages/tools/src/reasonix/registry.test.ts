import { describe, expect, it } from "vitest";

describe("Reasonix registry parity", () => {
  it("preserves insertion order for names while exporting schemas alphabetically", async () => {
    const { Registry } = await import("./registry");
    const registry = new Registry();

    registry.add(makeTool("write_file"));
    registry.add(makeTool("bash"));
    registry.add(makeTool("read_file"));

    expect(registry.names()).toEqual(["write_file", "bash", "read_file"]);
    expect(registry.schemas().map((schema: { name: string }) => schema.name)).toEqual(["bash", "read_file", "write_file"]);
  });

  it("replaces a tool without moving its first-seen registry order", async () => {
    const { Registry } = await import("./registry");
    const registry = new Registry();

    registry.add(makeTool("bash", { description: "first" }));
    registry.add(makeTool("read_file"));
    registry.add(makeTool("bash", { description: "replacement" }));

    expect(registry.names()).toEqual(["bash", "read_file"]);
    expect(registry.get("bash")?.description()).toBe("replacement");
  });

  it("canonicalizes schemas once at add time", async () => {
    const { Registry } = await import("./registry");
    const registry = new Registry();
    let calls = 0;

    registry.add(
      makeTool("zeta", {
        schema: () => {
          calls += 1;
          return {
            type: "object",
            required: ["b", "a"],
            properties: { b: { type: "string" }, a: { type: "integer" } }
          };
        }
      })
    );

    expect(calls).toBe(1);
    for (let index = 0; index < 5; index += 1) {
      expect(registry.schemas()[0].parameters).toEqual({
        properties: { a: { type: "integer" }, b: { type: "string" } },
        required: ["a", "b"],
        type: "object"
      });
    }
    expect(calls).toBe(1);
  });

  it("canonicalizes Reasonix provider schema edge cases", async () => {
    const { canonicalizeSchema } = await import("./registry");

    expect(canonicalizeSchema(undefined)).toEqual({ type: "object" });
    expect(canonicalizeSchema({ type: "object", required: true })).toEqual({ type: "object" });
    expect(canonicalizeSchema({ dependentRequired: { b: false, a: ["z", "x"] } })).toEqual({
      dependentRequired: { a: ["x", "z"] }
    });
    expect(
      canonicalizeSchema({
        required: [{ b: 1 }, { a: 1 }],
        dependentRequired: { b: ["z", "a"], a: ["x", "b"] },
        $defs: {
          zed: { required: ["z", "a"], properties: { z: { type: "string" }, a: { type: "number" } } },
          alpha: { dependentSchemas: { zed: { required: true, type: "object" } } }
        }
      })
    ).toEqual({
      $defs: {
        alpha: { dependentSchemas: { zed: { type: "object" } } },
        zed: { properties: { a: { type: "number" }, z: { type: "string" } }, required: ["a", "z"] }
      },
      dependentRequired: { a: ["b", "x"], b: ["a", "z"] },
      required: [{ a: 1 }, { b: 1 }]
    });
    expect(canonicalizeSchema({ dependentRequired: ["not", "object"] })).toEqual({});
  });

  it("sorts schema arrays by Go json.Marshal escaped string keys", async () => {
    const { canonicalizeSchema } = await import("./registry");

    expect(canonicalizeSchema({ type: "object", required: ["&", "A", "<"] })).toEqual({
      type: "object",
      required: ["A", "&", "<"]
    });
    expect(canonicalizeSchema({ dependentRequired: { deps: ["&", "A", "<"] } })).toEqual({
      dependentRequired: { deps: ["A", "&", "<"] }
    });
  });

  it("exports Go json.RawMessage equivalent canonical schema JSON bytes", async () => {
    const { Registry, canonicalizeSchemaJSON } = await import("./registry");
    const htmlSchema = {
      type: "object",
      properties: { value: { const: "<&>" } },
      required: ["<&>"]
    };
    const expectedJson = String.raw`{"properties":{"value":{"const":"\u003c\u0026\u003e"}},"required":["\u003c\u0026\u003e"],"type":"object"}`;

    expect(canonicalizeSchemaJSON(htmlSchema)).toBe(expectedJson);

    const registry = new Registry();
    registry.add(makeTool("html_chars", { schema: () => htmlSchema }));

    expect(registry.schemas()[0].parameters).toEqual({
      properties: { value: { const: "<&>" } },
      required: ["<&>"],
      type: "object"
    });
    expect(JSON.stringify(registry.schemas())).not.toContain("parametersJson");
    expect(Object.keys(registry.schemas()[0]).sort()).toEqual(["description", "name", "parameters"]);
    expect(registry.schemasJSON()).toBe(
      String.raw`[{"description":"html_chars desc","name":"html_chars","parameters":{"properties":{"value":{"const":"\u003c\u0026\u003e"}},"required":["\u003c\u0026\u003e"],"type":"object"}}]`
    );
  });

  it("treats raw JSON schema strings like Reasonix json.RawMessage bytes", async () => {
    const { Registry, canonicalizeSchemaJSON } = await import("./registry");

    expect(canonicalizeSchemaJSON('{"type":"object","required":["b","a"]}')).toBe(
      '{"required":["a","b"],"type":"object"}'
    );
    expect(canonicalizeSchemaJSON("{not json")).toBe("{not json");
    expect(canonicalizeSchemaJSON("")).toBe('{"type":"object"}');

    const registry = new Registry();
    registry.add(makeTool("raw", { schema: () => '{"type":"object","required":["b","a"]}' }));

    expect(registry.schemasJSON()).toBe(
      '[{"description":"raw desc","name":"raw","parameters":{"required":["a","b"],"type":"object"}}]'
    );
  });

  it("throws when serializing malformed raw schema JSON for providers", async () => {
    const { Registry } = await import("./registry");
    const registry = new Registry();

    registry.add(makeTool("bad", { schema: () => "{not json" }));

    expect(() => registry.schemasJSON()).toThrow();
  });

  it("removes and suspends prefixed tool namespaces like Reasonix MCP registry entries", async () => {
    const { Registry } = await import("./registry");
    const registry = new Registry();

    registry.add(makeTool("bash"));
    registry.add(makeTool("mcp__fs__read"));
    registry.add(makeTool("mcp__fs__write"));
    registry.add(makeTool("mcp__stripe__charge"));

    expect(registry.removePrefix("mcp__fs__")).toBe(2);
    expect(registry.names()).toEqual(["bash", "mcp__stripe__charge"]);

    expect(registry.suspendPrefix("mcp__stripe__")).toBe(1);
    registry.add(makeTool("mcp__stripe__refund"));
    expect(registry.get("mcp__stripe__refund")).toBeUndefined();
    registry.resumePrefix("mcp__stripe__");
    registry.add(makeTool("mcp__stripe__refund"));
    expect(registry.names()).toEqual(["bash", "mcp__stripe__refund"]);
  });
});

function makeTool(
  name: string,
  options: {
    description?: string;
    schema?: () => unknown;
  } = {}
) {
  return {
    name,
    description: () => options.description ?? `${name} desc`,
    schema: options.schema ?? (() => ({ type: "object" })),
    readOnly: () => true,
    execute: () => {
      throw new Error("not implemented");
    }
  };
}
