/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkbenchNav } from "./WorkbenchNav";

afterEach(() => cleanup());

describe("WorkbenchNav", () => {
  it("renders desktop function panel cards without menu roles", async () => {
    const user = userEvent.setup();
    render(
      <WorkbenchNav
        activePage="assets"
        projectName="仙途资料"
        onPageChange={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "功能" }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();

    const desktopFunctionEntry = screen.getByRole("navigation", { name: "功能入口" });
    expect(desktopFunctionEntry).toHaveTextContent("小说提取");
    expect(desktopFunctionEntry).toHaveTextContent("关系图谱");
    expect(desktopFunctionEntry).not.toHaveTextContent("资产");
    const featureImages = desktopFunctionEntry.querySelectorAll(".top-nav__feature-image");
    expect(featureImages).toHaveLength(2);
    expect(featureImages[0]).toHaveAttribute("src", "function-extraction.svg");
    expect(featureImages[1]).toHaveAttribute("src", "function-graph.svg");

    expect(screen.getByLabelText("资产入口")).toBeInTheDocument();
    expect(screen.getByLabelText("功能快捷入口")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "语言" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "用户菜单" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "大模型配置" })).not.toBeInTheDocument();
  });

  it("opens the desktop function entry on hover and closes it after leaving", async () => {
    const user = userEvent.setup();
    render(
      <WorkbenchNav
        activePage="assets"
        projectName="仙途资料"
        onPageChange={vi.fn()}
      />
    );

    expect(screen.queryByRole("navigation", { name: "功能入口" })).not.toBeInTheDocument();

    await user.hover(screen.getByRole("button", { name: "功能" }));

    const desktopFunctionEntry = screen.getByRole("navigation", { name: "功能入口" });
    expect(within(desktopFunctionEntry).getByRole("button", { name: "小说提取" })).toBeInTheDocument();
    expect(within(desktopFunctionEntry).getByRole("button", { name: "关系图谱" })).toBeInTheDocument();
    expect(within(desktopFunctionEntry).queryByRole("button", { name: "资产" })).not.toBeInTheDocument();

    await user.unhover(screen.getByRole("button", { name: "功能" }));

    expect(screen.queryByRole("navigation", { name: "功能入口" })).not.toBeInTheDocument();
  });

  it("requests navigation changes", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();

    render(
      <WorkbenchNav
        activePage="assets"
        projectName="仙途资料"
        onPageChange={onPageChange}
      />
    );

    await user.click(screen.getByRole("button", { name: "功能" }));
    await user.click(
      within(screen.getByRole("navigation", { name: "功能入口" })).getByRole("button", {
        name: "小说提取"
      })
    );

    await user.click(screen.getByRole("button", { name: "功能" }));
    await user.click(
      within(screen.getByRole("navigation", { name: "功能入口" })).getByRole("button", {
        name: "关系图谱"
      })
    );

    expect(onPageChange).toHaveBeenNthCalledWith(1, "extraction");
    expect(onPageChange).toHaveBeenNthCalledWith(2, "graph");
  });
});
