/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GraphPlaceholderPage } from "./GraphPlaceholderPage";

afterEach(() => cleanup());

describe("GraphPlaceholderPage", () => {
  it("shows product-ready empty graph guidance without generation controls", () => {
    render(<GraphPlaceholderPage state="ready" />);

    expect(screen.getByText("当前书籍暂无图谱资产")).toBeInTheDocument();
    expect(screen.getByText("图谱视图准备中")).toBeInTheDocument();
    expect(screen.getByText("完成资料整理后，可在这里查看人物、地点与线索之间的关系。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "生成图谱" })).not.toBeInTheDocument();
    expect(screen.queryByText(["占", "位页"].join(""))).not.toBeInTheDocument();
    expect(screen.queryByText(["P", "0 暂不", "开放图谱生成操作"].join(""))).not.toBeInTheDocument();
  });

  it("shows book context loading state", () => {
    render(<GraphPlaceholderPage state="loading" />);

    expect(screen.getByText("正在读取书籍上下文")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "生成图谱" })).not.toBeInTheDocument();
  });

  it("shows graph loading error with disabled operation", () => {
    render(<GraphPlaceholderPage state="error" errorMessage="读取书籍上下文失败" />);

    expect(screen.getByText("读取书籍上下文失败")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "生成图谱" })).not.toBeInTheDocument();
  });
});
