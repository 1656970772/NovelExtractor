/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SaveTemplateDto, TemplateDto } from "../../../shared/ipcTypes";
import { TemplateManagementModal } from "./TemplateManagementModal";

afterEach(() => cleanup());

const globalTemplate: TemplateDto = {
  id: "global-world",
  scope: "global",
  name: "世界观模板",
  fileName: "world.md",
  body: "记录势力、地名与修炼体系。",
  createdAt: "2026-06-28T00:00:00.000Z",
  updatedAt: "2026-06-28T00:00:00.000Z"
};

const projectTemplate: TemplateDto = {
  id: "project-foreshadow",
  scope: "project",
  projectId: "project-a",
  name: "伏笔模板",
  fileName: "foreshadow.txt",
  body: "记录当前项目专属伏笔。",
  createdAt: "2026-06-28T00:00:00.000Z",
  updatedAt: "2026-06-28T00:00:00.000Z"
};

function renderTemplateModal(overrides: Partial<ComponentProps<typeof TemplateManagementModal>> = {}) {
  const props: ComponentProps<typeof TemplateManagementModal> = {
    open: true,
    projectId: "project-a",
    saveState: "idle",
    selectedTemplateIds: [globalTemplate.id],
    templates: [globalTemplate, projectTemplate],
    onClose: vi.fn(),
    onDeleteTemplate: vi.fn().mockResolvedValue(undefined),
    onSaveTemplate: vi.fn().mockResolvedValue(undefined),
    onSelectionChange: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };

  render(<TemplateManagementModal {...props} />);
  return props;
}

function renderStatefulTemplateModal() {
  const savedAt = "2026-06-28T00:00:00.000Z";
  const onSaveTemplate = vi.fn();
  const onSelectionChange = vi.fn();

  function StatefulTemplateModal() {
    const [open, setOpen] = useState(true);
    const [templates, setTemplates] = useState<TemplateDto[]>([globalTemplate, projectTemplate]);
    const [selectedTemplateIds, setSelectedTemplateIds] = useState<string[]>([globalTemplate.id]);

    onSaveTemplate.mockImplementation(async (input: SaveTemplateDto) => {
      const savedTemplate: TemplateDto = {
        id: input.templateId ?? `saved-${input.name}`,
        projectId: input.projectId,
        scope: input.scope,
        name: input.name,
        fileName: input.fileName,
        body: input.body,
        createdAt: savedAt,
        updatedAt: savedAt
      };

      setTemplates((currentTemplates) => {
        const existingIndex = currentTemplates.findIndex((template) => template.id === savedTemplate.id);
        if (existingIndex === -1) {
          return [...currentTemplates, savedTemplate];
        }

        return currentTemplates.map((template) =>
          template.id === savedTemplate.id ? savedTemplate : template
        );
      });

      return savedTemplate;
    });

    onSelectionChange.mockImplementation((templateIds: string[]) => {
      setSelectedTemplateIds(templateIds);
    });

    return (
      <>
        <button onClick={() => setOpen(true)} type="button">
          重新打开模板
        </button>
        <TemplateManagementModal
          open={open}
          projectId="project-a"
          selectedTemplateIds={selectedTemplateIds}
          templates={templates}
          onClose={() => setOpen(false)}
          onDeleteTemplate={vi.fn().mockResolvedValue(undefined)}
          onSaveTemplate={onSaveTemplate}
          onSelectionChange={onSelectionChange}
        />
      </>
    );
  }

  render(<StatefulTemplateModal />);

  return { onSaveTemplate, onSelectionChange };
}

describe("TemplateManagementModal", () => {
  it("selects templates separately from the active preview editor", async () => {
    const user = userEvent.setup();
    const props = renderTemplateModal();

    const dialog = screen.getByRole("dialog", { name: "模板选择与编辑" });
    const globalGroup = within(dialog).getByRole("group", { name: "全局模板" });
    const projectGroup = within(dialog).getByRole("group", { name: "项目模板" });

    expect(within(globalGroup).getByRole("checkbox", { name: "使用 世界观模板" })).toBeChecked();
    expect(within(projectGroup).getByRole("checkbox", { name: "使用 伏笔模板" })).not.toBeChecked();
    expect(within(globalGroup).getByRole("button", { name: "预览编辑 世界观模板" })).not.toHaveTextContent(
      "全局模板"
    );
    expect(screen.getByRole("textbox", { name: "模板正文" })).toHaveValue("记录势力、地名与修炼体系。");

    await user.click(within(projectGroup).getByRole("button", { name: "预览编辑 伏笔模板" }));

    expect(screen.getByRole("textbox", { name: "模板正文" })).toHaveValue("记录当前项目专属伏笔。");

    await user.click(within(projectGroup).getByRole("checkbox", { name: "使用 伏笔模板" }));

    expect(props.onSelectionChange).toHaveBeenLastCalledWith([globalTemplate.id, projectTemplate.id]);
  });

  it("selects one project template without selecting sibling templates", async () => {
    const user = userEvent.setup();
    const firstProjectTemplate: TemplateDto = {
      ...projectTemplate,
      id: "project-111",
      name: "111",
      fileName: "111.md"
    };
    const secondProjectTemplate: TemplateDto = {
      ...projectTemplate,
      id: "project-2222",
      name: "2222",
      fileName: "2222.md"
    };
    const props = renderTemplateModal({
      selectedTemplateIds: [],
      templates: [globalTemplate, firstProjectTemplate, secondProjectTemplate]
    });

    const projectGroup = screen.getByRole("group", { name: "项目模板" });

    expect(within(projectGroup).getByRole("checkbox", { name: "使用 111" })).not.toBeChecked();
    expect(within(projectGroup).getByRole("checkbox", { name: "使用 2222" })).not.toBeChecked();

    await user.click(within(projectGroup).getByRole("checkbox", { name: "使用 111" }));

    expect(props.onSelectionChange).toHaveBeenLastCalledWith(["project-111"]);
  });

  it("saves manual edits, creates blank templates, and resets unsaved edits", async () => {
    const user = userEvent.setup();
    const props = renderTemplateModal();

    await user.click(screen.getByRole("button", { name: "预览编辑 伏笔模板" }));
    await user.clear(screen.getByRole("textbox", { name: "模板正文" }));
    await user.type(screen.getByRole("textbox", { name: "模板正文" }), "记录伏笔、回收章节和关联人物。");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(props.onSaveTemplate).toHaveBeenLastCalledWith({
      templateId: "project-foreshadow",
      projectId: "project-a",
      scope: "project",
      name: "伏笔模板",
      fileName: "foreshadow.txt",
      body: "记录伏笔、回收章节和关联人物。"
    });

    await user.click(screen.getByRole("button", { name: "新增模板" }));
    expect(screen.getByRole("dialog", { name: "新增模板" })).toBeInTheDocument();

    const nameDialogBackdrop = document.querySelector(".template-modal__name-dialog");
    expect(nameDialogBackdrop).toBeInstanceOf(HTMLElement);
    await user.click(nameDialogBackdrop as HTMLElement);
    expect(screen.queryByRole("dialog", { name: "新增模板" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "新增模板" }));
    await user.type(screen.getByRole("textbox", { name: "新模板名字" }), "人物关系模板");
    await user.click(screen.getByRole("button", { name: "创建模板" }));

    expect(screen.getByRole("checkbox", { name: "使用 人物关系模板" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "预览编辑 人物关系模板" })).toHaveTextContent("人物关系模板");
    expect(screen.getByRole("textbox", { name: "模板名字" })).toHaveValue("人物关系模板");
    expect(screen.getByRole("textbox", { name: "模板正文" })).toHaveValue("");
    await user.type(screen.getByRole("textbox", { name: "模板正文" }), "记录人物关系与阵营变化。");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(props.onSaveTemplate).toHaveBeenLastCalledWith({
      projectId: "project-a",
      scope: "project",
      name: "人物关系模板",
      fileName: "人物关系模板.md",
      body: "记录人物关系与阵营变化。"
    });

    await user.clear(screen.getByRole("textbox", { name: "模板正文" }));
    await user.type(screen.getByRole("textbox", { name: "模板正文" }), "临时内容");
    await user.click(screen.getByRole("button", { name: "重置模板" }));

    expect(screen.getByRole("textbox", { name: "模板正文" })).toHaveValue("记录人物关系与阵营变化。");
  });

  it("asks whether to save dirty edits before closing", async () => {
    const user = userEvent.setup();
    const props = renderTemplateModal();

    await user.clear(screen.getByRole("textbox", { name: "模板正文" }));
    await user.type(screen.getByRole("textbox", { name: "模板正文" }), "还没保存的新内容");
    await user.click(screen.getByRole("button", { name: "关闭模板选择" }));

    expect(screen.getByRole("alertdialog", { name: "保存模板修改" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "继续编辑" }));

    expect(props.onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "关闭模板选择" }));
    await user.click(screen.getByRole("button", { name: "保存修改" }));

    expect(props.onSaveTemplate).toHaveBeenLastCalledWith({
      templateId: "global-world",
      projectId: "project-a",
      scope: "global",
      name: "世界观模板",
      fileName: "world.md",
      body: "还没保存的新内容"
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("persists every newly created template across modal reopen", async () => {
    const user = userEvent.setup();
    const props = renderStatefulTemplateModal();

    await user.click(screen.getByRole("button", { name: "新增模板" }));
    const firstNameDialog = screen.getByRole("dialog", { name: "新增模板" });
    expect(within(firstNameDialog).queryByRole("combobox", { name: "模板范围" })).not.toBeInTheDocument();
    expect(within(firstNameDialog).getByRole("checkbox", { name: "是否全局模板" })).not.toBeChecked();
    await user.type(within(firstNameDialog).getByRole("textbox", { name: "新模板名字" }), "1111");
    await user.click(within(firstNameDialog).getByRole("button", { name: "创建模板" }));

    expect(await screen.findByRole("checkbox", { name: "使用 1111" })).not.toBeChecked();

    await user.click(screen.getByRole("button", { name: "新增模板" }));
    const secondNameDialog = screen.getByRole("dialog", { name: "新增模板" });
    await user.click(within(secondNameDialog).getByRole("checkbox", { name: "是否全局模板" }));
    await user.type(within(secondNameDialog).getByRole("textbox", { name: "新模板名字" }), "2222");
    await user.click(within(secondNameDialog).getByRole("button", { name: "创建模板" }));

    expect(await screen.findByRole("checkbox", { name: "使用 1111" })).not.toBeChecked();
    expect(await screen.findByRole("checkbox", { name: "使用 2222" })).not.toBeChecked();

    await user.click(screen.getByRole("checkbox", { name: "使用 1111" }));

    expect(await screen.findByRole("checkbox", { name: "使用 1111" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "使用 2222" })).not.toBeChecked();

    await user.click(screen.getByRole("button", { name: "关闭模板选择" }));
    expect(screen.queryByRole("dialog", { name: "模板选择与编辑" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重新打开模板" }));

    expect(await screen.findByRole("checkbox", { name: "使用 1111" })).toBeChecked();
    expect(await screen.findByRole("checkbox", { name: "使用 2222" })).not.toBeChecked();
    expect(props.onSaveTemplate).toHaveBeenCalledTimes(2);
    expect(props.onSaveTemplate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ name: "1111", scope: "project" })
    );
    expect(props.onSaveTemplate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ name: "2222", scope: "global" })
    );
  });
});
