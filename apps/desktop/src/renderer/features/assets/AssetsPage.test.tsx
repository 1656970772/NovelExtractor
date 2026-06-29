/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SafeMarkdownPreviewDto } from "../../../shared/ipcTypes";
import { AssetsPage } from "./AssetsPage";
import { getBookAssetTypeLabel, getVisibleAssetTypes } from "./assetsViewModel";

afterEach(() => cleanup());

describe("AssetsPage", () => {
  it("shows empty assets, empty reports, and disabled preview when nothing is selected", () => {
    render(<AssetsPage books={[]} reports={[]} state="ready" />);

    expect(screen.getByText("暂无书籍资产")).toBeInTheDocument();
    expect(screen.getByText("暂无 Markdown 报告")).toBeInTheDocument();
    expect(screen.getByText("选择报告后可预览内容")).toBeInTheDocument();
  });

  it("shows loading states for asset list and report preview", () => {
    render(
      <AssetsPage
        books={[]}
        reports={[]}
        reportState="loading"
        state="loading"
        previewState="loading"
      />
    );

    expect(screen.getByLabelText("资产列表加载中")).toBeInTheDocument();
    expect(screen.getByLabelText("报告列表加载中")).toBeInTheDocument();
    expect(screen.getByLabelText("报告预览加载中")).toBeInTheDocument();
  });

  it("shows loading error", () => {
    render(
      <AssetsPage
        books={[]}
        reports={[]}
        state="error"
        errorMessage="读取资产失败"
      />
    );

    expect(screen.getByText("读取资产失败")).toBeInTheDocument();
  });

  it("uses the configured book asset label and only exposes P0 book assets", () => {
    const assetTypes = [
      { id: "book" as const, label: "藏书" },
      { id: "image", label: "图片" }
    ];

    expect(getBookAssetTypeLabel(assetTypes)).toBe("藏书");
    expect(getVisibleAssetTypes(assetTypes)).toEqual([{ id: "book", label: "藏书" }]);

    render(
      <AssetsPage
        assetTypes={assetTypes}
        books={[{ id: "book-1", displayName: "凡人修仙传", chapterCount: 12 }]}
        reports={[]}
        selectedBookId="book-1"
        state="ready"
      />
    );

    expect(screen.getByRole("heading", { name: "藏书资产" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /凡人修仙传/ })).toBeInTheDocument();
    expect(screen.queryByText("图片")).not.toBeInTheDocument();
  });

  it("selects reports and renders safe preview html from the preview dto", async () => {
    const user = userEvent.setup();
    const onSelectReport = vi.fn();
    const preview: SafeMarkdownPreviewDto = {
      reportId: "report-1",
      html: '<h1 id="heading-1">丹药分析</h1><p>只读安全预览</p>',
      headings: [{ id: "heading-1", depth: 1, text: "丹药分析" }],
      generatedAt: "2026-06-27T00:00:00.000Z"
    };

    render(
      <AssetsPage
        books={[{ id: "book-1", displayName: "凡人修仙传", chapterCount: 12 }]}
        reports={[
          {
            id: "report-1",
            bookId: "book-1",
            fileName: "丹药分析.md",
            displayName: "丹药分析",
            byteSize: 1024,
            createdAt: "2026-06-27T00:00:00.000Z",
            updatedAt: "2026-06-27T00:00:00.000Z"
          }
        ]}
        preview={preview}
        selectedBookId="book-1"
        selectedReportId="report-1"
        state="ready"
        onSelectReport={onSelectReport}
      />
    );

    await user.click(screen.getByRole("button", { name: /丹药分析/ }));

    expect(onSelectReport).toHaveBeenCalledWith("report-1");
    expect(screen.getByRole("heading", { name: "丹药分析" })).toBeInTheDocument();
    expect(screen.getByText("只读安全预览")).toBeInTheDocument();
  });

  it("shows report preview errors without hiding the report list", () => {
    render(
      <AssetsPage
        books={[{ id: "book-1", displayName: "凡人修仙传" }]}
        previewErrorMessage="预览失败"
        previewState="error"
        reports={[
          {
            id: "report-1",
            bookId: "book-1",
            fileName: "丹药分析.md",
            displayName: "丹药分析",
            byteSize: 1024,
            createdAt: "2026-06-27T00:00:00.000Z",
            updatedAt: "2026-06-27T00:00:00.000Z"
          }
        ]}
        selectedBookId="book-1"
        state="ready"
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent("预览失败");
    expect(screen.getByRole("button", { name: /丹药分析/ })).toBeInTheDocument();
  });
});
