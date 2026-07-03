/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkbenchNav } from "./WorkbenchNav";

afterEach(() => cleanup());

describe("WorkbenchNav", () => {
  it("renders the configured page rail and utility entries with accessible names and icons", () => {
    const { container } = render(
      <WorkbenchNav
        activePage="extraction"
        onPageChange={vi.fn()}
        onOpenProviderConfig={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    );

    const rail = screen.getByRole("navigation", { name: "工作台导航" });
    const buttons = within(rail).getAllByRole("button");
    expect(buttons).toHaveLength(5);
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "资源",
      "提取",
      "关系图",
      "大模型配置",
      "设置"
    ]);
    expect(container.querySelectorAll(".workbench-rail__icon")).toHaveLength(buttons.length);

    expect(screen.queryByRole("button", { name: "功能" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "语言" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "用户菜单" })).not.toBeInTheDocument();
  });

  it("marks the active rail page as pressed", () => {
    render(<WorkbenchNav activePage="extraction" onPageChange={vi.fn()} onOpenSettings={vi.fn()} />);

    expect(screen.getByRole("button", { name: "资源" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "提取" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "关系图" })).toHaveAttribute("aria-pressed", "false");
  });

  it("shows a label tooltip when a rail item is hovered or focused", async () => {
    const user = userEvent.setup();
    render(<WorkbenchNav activePage="extraction" onPageChange={vi.fn()} />);

    const resourceButton = screen.getByRole("button", { name: "资源" });

    await user.hover(resourceButton);
    expect(screen.getByRole("tooltip", { name: "资源" })).toBeInTheDocument();

    await user.unhover(resourceButton);
    resourceButton.focus();
    expect(screen.getByRole("tooltip", { name: "资源" })).toBeInTheDocument();
  });

  it("shows the hovered rail tooltip over the focused rail tooltip", async () => {
    const user = userEvent.setup();
    render(<WorkbenchNav activePage="extraction" onPageChange={vi.fn()} />);

    const resourceButton = screen.getByRole("button", { name: "资源" });
    const graphButton = screen.getByRole("button", { name: "关系图" });

    resourceButton.focus();
    expect(screen.getByRole("tooltip", { name: "资源" })).toBeInTheDocument();

    await user.hover(graphButton);

    expect(screen.getByRole("tooltip", { name: "关系图" })).toBeInTheDocument();
  });

  it("requests page changes from rail items", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();

    render(<WorkbenchNav activePage="extraction" onPageChange={onPageChange} />);

    await user.click(screen.getByRole("button", { name: "资源" }));
    await user.click(screen.getByRole("button", { name: "关系图" }));

    expect(onPageChange).toHaveBeenNthCalledWith(1, "assets");
    expect(onPageChange).toHaveBeenNthCalledWith(2, "graph");
  });

  it("opens provider config and settings from bottom rail utility items", async () => {
    const user = userEvent.setup();
    const onOpenProviderConfig = vi.fn();
    const onOpenSettings = vi.fn();

    render(
      <WorkbenchNav
        activePage="assets"
        onPageChange={vi.fn()}
        onOpenProviderConfig={onOpenProviderConfig}
        onOpenSettings={onOpenSettings}
      />
    );

    const utilityGroup = screen.getByLabelText("工具入口");
    await user.click(within(utilityGroup).getByRole("button", { name: "大模型配置" }));
    await user.click(within(utilityGroup).getByRole("button", { name: "设置" }));

    expect(onOpenProviderConfig).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
