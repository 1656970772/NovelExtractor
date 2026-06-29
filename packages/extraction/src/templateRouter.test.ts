import { describe, expect, it } from "vitest";
import { TemplateRoutingError, createTemplateSnapshots } from "./templateRouter";

const fixedClock = {
  now: () => "2026-06-27T00:00:00.000Z"
};

describe("createTemplateSnapshots", () => {
  it("returns no snapshots for an empty template list", () => {
    expect(createTemplateSnapshots([], { clock: fixedClock })).toEqual([]);
  });

  it("creates ordered snapshots for selected templates", () => {
    const snapshots = createTemplateSnapshots(
      [
        { id: "tpl-pill", name: "丹药分析模板", body: "抽取丹药", outputFileName: undefined },
        { id: "tpl-character", name: "人物关系模板", body: "抽取人物", outputFileName: "characters.md" }
      ],
      { clock: fixedClock }
    );

    expect(snapshots).toEqual([
      {
        templateId: "tpl-pill",
        templateName: "丹药分析模板",
        templateBody: "抽取丹药",
        reportFileName: "丹药分析.md",
        createdAt: "2026-06-27T00:00:00.000Z"
      },
      {
        templateId: "tpl-character",
        templateName: "人物关系模板",
        templateBody: "抽取人物",
        reportFileName: "characters.md",
        createdAt: "2026-06-27T00:00:00.000Z"
      }
    ]);
  });

  it("derives report filenames by trimming names and removing the trailing template suffix", () => {
    const snapshots = createTemplateSnapshots(
      [{ id: "tpl-world", name: "  世界观模板  ", body: "抽取世界观" }],
      { clock: fixedClock }
    );

    expect(snapshots[0]?.reportFileName).toBe("世界观.md");
  });

  it("throws a typed error instead of generating an empty report filename", () => {
    const error = captureError(() =>
      createTemplateSnapshots([{ id: "tpl-empty", name: " 模板 ", body: "抽取内容" }], { clock: fixedClock })
    );

    expect(error).toBeInstanceOf(TemplateRoutingError);
    expect(error).toMatchObject({ code: "INVALID_TEMPLATE_NAME" });
  });

  it("propagates clock errors without wrapping them", () => {
    const clockError = new Error("clock failed");

    expect(() =>
      createTemplateSnapshots([{ id: "tpl-clock", name: "时钟模板", body: "抽取时间" }], {
        clock: {
          now: () => {
            throw clockError;
          }
        }
      })
    ).toThrow(clockError);
  });

  it("passes explicit report filenames through without path sanitization", () => {
    const snapshots = createTemplateSnapshots(
      [{ id: "tpl-path", name: "路径模板", body: "抽取路径", outputFileName: "../reports/危险.md" }],
      { clock: fixedClock }
    );

    expect(snapshots[0]?.reportFileName).toBe("../reports/危险.md");
  });
});

function captureError(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }

  throw new Error("Expected function to throw");
}
