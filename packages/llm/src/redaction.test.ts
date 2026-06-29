import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redaction";

describe("redactSecrets", () => {
  it("redacts api keys and authorization headers", () => {
    const liveKey = "sk-" + "live-secret";
    const anotherKey = "sk-" + "another-secret";

    expect(
      redactSecrets({
        Authorization: `Bearer ${liveKey}`,
        apiKey: anotherKey,
        message: "request failed"
      })
    ).toEqual({
      Authorization: "Bearer sk-***",
      apiKey: "***",
      message: "request failed"
    });
  });

  it("recursively redacts nested secret fields and arrays", () => {
    const token = "sk-" + "nested-secret";

    expect(
      redactSecrets({
        nested: {
          api_key: token,
          token,
          credential: { value: token }
        },
        attempts: [`Bearer ${token}`, "safe text"]
      })
    ).toEqual({
      nested: {
        api_key: "***",
        token: "***",
        credential: "***"
      },
      attempts: ["Bearer sk-***", "safe text"]
    });
  });

  it("redacts non-sk bearer tokens in ordinary string arrays", () => {
    const token = "plain" + "secret12345";

    const redacted = redactSecrets([`Bearer ${token}`, `retry used bearer ${token}`, "safe text"]);

    expect(redacted).toEqual(["Bearer ***", "retry used bearer ***", "safe text"]);
    expect(JSON.stringify(redacted)).not.toContain(token);
  });

  it("redacts bearer tokens containing common base64-like punctuation", () => {
    const token = "abc" + "+def" + "/ghi" + "=~tail";

    const actual = redactSecrets("failed for Bearer " + token);

    expect(actual).not.toContain("+def/ghi=~tail");
    expect(actual).toBe("failed for Bearer ***");
  });

  it("redacts non-sk bearer tokens in authorization fields", () => {
    const token = "plain" + "secret12345";

    const redacted = redactSecrets({
      Authorization: `Bearer ${token}`
    });

    expect(redacted).toEqual({
      Authorization: "Bearer ***"
    });
    expect(JSON.stringify(redacted)).not.toContain(token);
  });

  it("redacts known secrets recursively in ordinary strings", () => {
    const token = "plain" + "secret12345";

    const redacted = redactSecrets(
      {
        message: `upstream rejected api key ${token}`,
        nested: [`prefix:${token}:suffix`, { detail: `retry with ${token}` }]
      },
      { knownSecrets: [token, ""] }
    );

    expect(redacted).toEqual({
      message: "upstream rejected api key ***",
      nested: ["prefix:***:suffix", { detail: "retry with ***" }]
    });
    expect(JSON.stringify(redacted)).not.toContain(token);
  });

  it("redacts high-entropy values after secret context words", () => {
    const token = "plain" + "secret12345";

    expect(redactSecrets(`credential store leaked api key ${token}`)).toBe(
      "credential store leaked api key ***"
    );
    expect(redactSecrets(`retry token=${token}`)).toBe("retry token=***");
    expect(redactSecrets("the secret door stays closed")).toBe("the secret door stays closed");
  });

  it("replaces repeated circular object references with a placeholder", () => {
    const cyclic: { message: string; self?: unknown } = { message: "safe" };
    cyclic.self = cyclic;

    expect(redactSecrets(cyclic)).toEqual({
      message: "safe",
      self: "[Circular]"
    });
  });

  it("redacts standalone secret-like strings", () => {
    const key = "sk-" + "plain-secret";

    expect(redactSecrets(`failed with ${key}`)).toBe("failed with sk-***");
  });
});
