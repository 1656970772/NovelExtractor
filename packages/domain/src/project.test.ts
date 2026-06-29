import { describe, expect, it } from "vitest";
import { createProjectSlug } from "./project";

describe("project domain", () => {
  it("rejects blank project names before creating slugs", () => {
    expect(() => createProjectSlug("")).toThrow(/project name/i);
    expect(() => createProjectSlug("   ")).toThrow(/project name/i);
  });

  it("creates filesystem-safe project slugs without using display names as directory names", () => {
    const firstSlug = createProjectSlug("仙途：第一卷");
    const secondSlug = createProjectSlug("仙途：第一卷");
    const differentSlug = createProjectSlug("仙途：第二卷");

    expect(firstSlug).toMatch(/^project-[a-z0-9-]+$/);
    expect(firstSlug).not.toContain("仙途");
    expect(firstSlug).not.toContain("第一卷");
    expect(secondSlug).toBe(firstSlug);
    expect(differentSlug).not.toBe(firstSlug);
  });

  it("treats canonically equivalent Unicode project names as the same slug", () => {
    expect(createProjectSlug("Café")).toBe(createProjectSlug("Cafe\u0301"));
  });
});
