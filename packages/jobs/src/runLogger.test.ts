import { describe, expect, it } from "vitest";
import { createRunLogger } from "./runLogger";

describe("run logger redaction", () => {
  it("redacts sk-style tokens, bearer headers, and known non-sk secrets", () => {
    const logger = createRunLogger({ knownSecrets: ["plain-secret-value"] });
    const secret = "sk-" + "secret";

    const line = logger.formatEntry({
      level: "info",
      message: "calling model",
      details: {
        apiKey: secret,
        Authorization: `Bearer ${secret}`,
        nested: `token=plain-secret-value`
      }
    });

    expect(line).not.toContain(secret);
    expect(line).not.toContain("plain-secret-value");
    expect(line).toContain("***");
    expect(line).toContain("sk-***");
  });

  it("does not crash on circular objects", () => {
    const logger = createRunLogger();
    const details: { name: string; self?: unknown } = { name: "cycle" };
    details.self = details;

    expect(logger.formatEntry({ level: "debug", message: "cycle", details })).toContain("[Circular]");
  });

  it("does not crash on non-json details while preserving redaction", () => {
    const logger = createRunLogger({ knownSecrets: ["plain-secret-value"] });
    const secret = "sk-" + "secret";
    const details: {
      count: bigint;
      symbolValue: symbol;
      callback: () => void;
      nested?: unknown;
      apiKey: string;
    } = {
      count: 12n,
      symbolValue: Symbol("plain-secret-value"),
      callback: function namedCallback() {
        return undefined;
      },
      apiKey: secret,
      nested: undefined
    };
    details.nested = details;

    const line = logger.formatEntry({ level: "warn", message: "odd details", details });

    expect(line).toContain("\"count\":\"12\"");
    expect(line).toContain("Symbol(***)");
    expect(line).toContain("[Function: namedCallback]");
    expect(line).toContain("[Circular]");
    expect(line).not.toContain("plain-secret-value");
    expect(line).not.toContain(secret);
  });
});
