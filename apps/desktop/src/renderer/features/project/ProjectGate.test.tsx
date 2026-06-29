/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectGate } from "./ProjectGate";

afterEach(() => cleanup());

describe("ProjectGate", () => {
  it("disables creation when project name is empty", () => {
    render(<ProjectGate onCreateProject={vi.fn()} />);

    expect(screen.getByRole("textbox", { name: "项目名称" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建项目" })).toBeDisabled();
  });

  it("shows loading while project creation is pending", async () => {
    const user = userEvent.setup();
    const pendingCreate = vi.fn(
      () => new Promise<{ id: string; displayName: string }>(() => undefined)
    );

    render(<ProjectGate onCreateProject={pendingCreate} />);
    await user.type(screen.getByRole("textbox", { name: "项目名称" }), "仙途资料");
    await user.click(screen.getByRole("button", { name: "创建项目" }));

    expect(screen.getByRole("button", { name: "创建中" })).toBeDisabled();
  });

  it("shows creation error returned by local simulation", async () => {
    const user = userEvent.setup();
    const rejectedCreate = vi.fn(() => Promise.reject(new Error("项目名称已存在")));

    render(<ProjectGate onCreateProject={rejectedCreate} />);
    await user.type(screen.getByRole("textbox", { name: "项目名称" }), "仙途资料");
    await user.click(screen.getByRole("button", { name: "创建项目" }));

    expect(await screen.findByText("项目名称已存在")).toBeInTheDocument();
  });

  it("opens the selected persisted project from a dropdown action row", async () => {
    const user = userEvent.setup();
    const onSelectProject = vi.fn();
    const projects = [
      { id: "project-a", displayName: "仙途资料" },
      { id: "project-b", displayName: "凡人笔记" }
    ];

    render(
      <ProjectGate
        onCreateProject={vi.fn()}
        onSelectProject={onSelectProject}
        projects={projects}
      />
    );

    await user.selectOptions(screen.getByRole("combobox", { name: "已有项目" }), "project-b");
    await user.click(screen.getByRole("button", { name: "打开项目" }));

    expect(onSelectProject).toHaveBeenCalledWith(projects[1]);
  });
});
