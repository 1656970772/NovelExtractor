import { describe, expect, it } from "vitest";
import portsSource from "./ports.ts?raw";

const forbiddenBoundaryTerms = ["ele" + "ctron", "rea" + "ct", "sql" + "ite", "fs" + "/promises", "fet" + "ch"];

describe("domain ports", () => {
  it("does not define adapter dependencies in the port boundary", () => {
    for (const term of forbiddenBoundaryTerms) {
      expect(portsSource).not.toContain(term);
    }
  });
});
