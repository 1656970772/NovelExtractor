import { useEffect, useMemo, useState } from "react";
import type { SaveTemplateDto, TemplateDto, TemplateScope } from "../../../shared/ipcTypes";
import {
  applyTemplateGroupSelection,
  groupTemplatesByScope,
  type TemplateView
} from "./templateViewModel";
import { TemplateUploadPanel } from "./TemplateUploadPanel";

export type TemplateSaveState = "idle" | "saving" | "error";

export interface TemplateManagementModalProps {
  open: boolean;
  initialAction?: "new";
  projectId: string;
  templates: readonly TemplateDto[];
  selectedTemplateIds: readonly string[];
  saveState?: TemplateSaveState;
  saveError?: string;
  onClose: () => void;
  onSaveTemplate: (input: SaveTemplateDto) => Promise<TemplateDto | void>;
  onDeleteTemplate: (templateId: string) => Promise<void>;
  onSelectionChange: (templateIds: string[]) => Promise<void> | void;
}

interface TemplateDraft {
  templateId?: string;
  name: string;
  fileName: string;
  body: string;
  scope: TemplateScope;
}

type PendingAction =
  | { type: "close" }
  | { type: "new" }
  | { type: "select"; templateId: string };

type NameDialogTab = "manual" | "upload";

const EMPTY_DRAFT: TemplateDraft = {
  name: "",
  fileName: "",
  body: "",
  scope: "project"
};

function createTemplateFileName(name: string): string {
  const normalized = name.trim().replace(/[\\/:*?"<>|]+/g, "-");
  return `${normalized || "template"}.md`;
}

function createDraftFromTemplate(template: TemplateDto): TemplateDraft {
  return {
    templateId: template.id,
    name: template.name,
    fileName: template.fileName,
    body: template.body,
    scope: template.scope
  };
}

function isSameDraft(left: TemplateDraft, right: TemplateDraft): boolean {
  return (
    left.templateId === right.templateId &&
    left.name === right.name &&
    left.fileName === right.fileName &&
    left.body === right.body &&
    left.scope === right.scope
  );
}

function filterTemplates(
  templates: readonly TemplateView[],
  selectedTemplateIds: readonly string[],
  query: string,
  showSelectedOnly: boolean
): TemplateView[] {
  const normalizedQuery = query.trim().toLowerCase();

  return templates
    .filter((template) => !showSelectedOnly || selectedTemplateIds.includes(template.id))
    .filter((template) => template.name.toLowerCase().includes(normalizedQuery))
    .sort((left, right) => {
      const leftSelected = selectedTemplateIds.includes(left.id);
      const rightSelected = selectedTemplateIds.includes(right.id);
      if (leftSelected !== rightSelected) {
        return leftSelected ? -1 : 1;
      }
      return left.name.localeCompare(right.name, "zh-Hans-CN");
    });
}

function getInitialTemplate(
  templates: readonly TemplateDto[],
  selectedTemplateIds: readonly string[]
): TemplateDto | undefined {
  return (
    selectedTemplateIds
      .map((templateId) => templates.find((template) => template.id === templateId))
      .find((template): template is TemplateDto => Boolean(template)) ?? templates[0]
  );
}

export function TemplateManagementModal({
  open,
  initialAction,
  projectId,
  templates,
  selectedTemplateIds,
  saveState = "idle",
  saveError,
  onClose,
  onSaveTemplate,
  onDeleteTemplate,
  onSelectionChange
}: TemplateManagementModalProps) {
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TemplateDraft>(EMPTY_DRAFT);
  const [savedDraft, setSavedDraft] = useState<TemplateDraft>(EMPTY_DRAFT);
  const [localError, setLocalError] = useState<string | undefined>();
  const [searchQuery, setSearchQuery] = useState("");
  const [showSelectedOnly, setShowSelectedOnly] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [localNewTemplate, setLocalNewTemplate] = useState<TemplateDto | null>(null);
  const [localNewSelected, setLocalNewSelected] = useState(false);
  const [isNameDialogOpen, setIsNameDialogOpen] = useState(false);
  const [nameDialogTab, setNameDialogTab] = useState<NameDialogTab>("manual");
  const [newTemplateName, setNewTemplateName] = useState("");
  const [isNewTemplateGlobal, setIsNewTemplateGlobal] = useState(false);
  const [nameDialogError, setNameDialogError] = useState<string | undefined>();

  const isSaving = saveState === "saving";
  const isDirty = !isSameDraft(draft, savedDraft);
  const displayedTemplates = useMemo(
    () => (localNewTemplate ? [...templates, localNewTemplate] : templates),
    [localNewTemplate, templates]
  );
  const effectiveSelectedTemplateIds = useMemo(
    () =>
      localNewTemplate && localNewSelected
        ? [...selectedTemplateIds, localNewTemplate.id]
        : selectedTemplateIds,
    [localNewSelected, localNewTemplate, selectedTemplateIds]
  );
  const groups = useMemo(() => groupTemplatesByScope(displayedTemplates), [displayedTemplates]);
  const filteredGroups = useMemo(
    () => ({
      global: filterTemplates(groups.global, effectiveSelectedTemplateIds, searchQuery, showSelectedOnly),
      project: filterTemplates(groups.project, effectiveSelectedTemplateIds, searchQuery, showSelectedOnly)
    }),
    [effectiveSelectedTemplateIds, groups, searchQuery, showSelectedOnly]
  );

  useEffect(() => {
    if (!open) {
      return;
    }

    const initialTemplate = getInitialTemplate(templates, selectedTemplateIds);
    const initialDraft = initialTemplate ? createDraftFromTemplate(initialTemplate) : EMPTY_DRAFT;
    setActiveTemplateId(initialTemplate?.id ?? null);
    setDraft(initialDraft);
    setSavedDraft(initialDraft);
    setLocalError(undefined);
    setSearchQuery("");
    setShowSelectedOnly(false);
    setPendingAction(null);
    setLocalNewTemplate(null);
    setLocalNewSelected(false);
    setIsNameDialogOpen(initialAction === "new");
    setNameDialogTab("manual");
    setNewTemplateName("");
    setIsNewTemplateGlobal(false);
    setNameDialogError(undefined);
  }, [initialAction, open]);

  if (!open) {
    return null;
  }

  function loadDraft(templateId: string): void {
    if (localNewTemplate?.id === templateId) {
      const nextDraft: TemplateDraft = {
        name: localNewTemplate.name,
        fileName: localNewTemplate.fileName,
        body: localNewTemplate.body,
        scope: localNewTemplate.scope
      };
      setActiveTemplateId(localNewTemplate.id);
      setDraft(nextDraft);
      setSavedDraft(nextDraft);
      setLocalError(undefined);
      return;
    }

    const template = templates.find((candidate) => candidate.id === templateId);
    if (!template) {
      return;
    }

    const nextDraft = createDraftFromTemplate(template);
    setActiveTemplateId(template.id);
    setDraft(nextDraft);
    setSavedDraft(nextDraft);
    setLocalError(undefined);
  }

  function openNameDialog(): void {
    setIsNameDialogOpen(true);
    setNameDialogTab("manual");
    setNewTemplateName("");
    setIsNewTemplateGlobal(false);
    setNameDialogError(undefined);
    setLocalError(undefined);
  }

  function closeNameDialog(): void {
    setIsNameDialogOpen(false);
    setNameDialogTab("manual");
    setNewTemplateName("");
    setIsNewTemplateGlobal(false);
    setNameDialogError(undefined);
  }

  function applyCreatedTemplate(savedTemplate: TemplateDto, fallbackDraft: TemplateDraft): void {
    const nextDraft = savedTemplate ? createDraftFromTemplate(savedTemplate) : fallbackDraft;

    setLocalNewTemplate(null);
    setLocalNewSelected(false);
    setActiveTemplateId(savedTemplate.id);
    setDraft(nextDraft);
    setSavedDraft(nextDraft);
    setSearchQuery("");
    setShowSelectedOnly(false);
    closeNameDialog();
  }

  async function createLocalTemplateFromName(): Promise<void> {
    const name = newTemplateName.trim();

    if (!name) {
      setNameDialogError("请输入模板名字");
      return;
    }

    if (templates.some((template) => template.name === name) || localNewTemplate?.name === name) {
      setNameDialogError("模板名字已存在");
      return;
    }

    const now = new Date().toISOString();
    const fileName = createTemplateFileName(name);
    const scope: TemplateScope = isNewTemplateGlobal ? "global" : "project";

    setNameDialogError(undefined);
    setLocalError(undefined);

    try {
      const savedTemplate = await onSaveTemplate({
        projectId,
        scope,
        name,
        fileName,
        body: ""
      });
      const nextTemplate: TemplateDto =
        savedTemplate ?? {
          id: `local-template-${Date.now()}`,
          projectId: scope === "project" ? projectId : undefined,
          scope,
          name,
          fileName,
          body: "",
          createdAt: now,
          updatedAt: now
        };
      const fallbackDraft: TemplateDraft = {
        name,
        fileName,
        body: "",
        scope
      };

      if (savedTemplate) {
        applyCreatedTemplate(savedTemplate, fallbackDraft);
      } else {
        setLocalNewTemplate(nextTemplate);
        setLocalNewSelected(false);
        setActiveTemplateId(nextTemplate.id);
        setDraft(fallbackDraft);
        setSavedDraft(fallbackDraft);
        setSearchQuery("");
        setShowSelectedOnly(false);
        closeNameDialog();
      }
    } catch (error) {
      setNameDialogError(error instanceof Error ? error.message : "创建模板失败");
    }
  }

  function runAction(action: PendingAction): void {
    if (action.type === "close") {
      onClose();
      return;
    }

    if (action.type === "new") {
      openNameDialog();
      return;
    }

    loadDraft(action.templateId);
  }

  function requestAction(action: PendingAction): void {
    if (isDirty) {
      setPendingAction(action);
      return;
    }

    runAction(action);
  }

  function toggleGroupSelection(groupTemplates: readonly TemplateView[], checked: boolean): void {
    if (localNewTemplate && groupTemplates.some((template) => template.id === localNewTemplate.id)) {
      setLocalNewSelected(checked);
    }

    const persistedTemplates = groupTemplates.filter((template) => template.id !== localNewTemplate?.id);
    onSelectionChange(
      applyTemplateGroupSelection({
        currentTemplateIds: selectedTemplateIds,
        groupTemplates: persistedTemplates,
        checked
      })
    );
  }

  function toggleTemplateSelection(template: TemplateDto, checked: boolean): void {
    if (localNewTemplate?.id === template.id) {
      setLocalNewSelected(checked);
      requestAction({ type: "select", templateId: template.id });
      return;
    }

    const nextTemplateIds = checked
      ? [...selectedTemplateIds, template.id]
      : selectedTemplateIds.filter((templateId) => templateId !== template.id);
    onSelectionChange(nextTemplateIds);
    requestAction({ type: "select", templateId: template.id });
  }

  async function saveDraft(): Promise<boolean> {
    const name = draft.name.trim();

    if (!name) {
      setLocalError("请输入模板名字");
      return false;
    }

    const duplicateTemplate = templates.find(
      (template) => template.id !== draft.templateId && template.name === name
    );
    if (duplicateTemplate) {
      setLocalError("模板名字已存在");
      return false;
    }

    const fileName = draft.fileName.trim() || createTemplateFileName(name);
    const nextDraft: TemplateDraft = {
      ...draft,
      name,
      fileName
    };

    setLocalError(undefined);
    const savedTemplate = await onSaveTemplate({
      templateId: nextDraft.templateId,
      projectId,
      scope: nextDraft.scope,
      name: nextDraft.name,
      fileName: nextDraft.fileName,
      body: nextDraft.body
    });

    if (savedTemplate) {
      const savedTemplateDraft = createDraftFromTemplate(savedTemplate);

      if (!nextDraft.templateId && localNewSelected && !selectedTemplateIds.includes(savedTemplate.id)) {
        await onSelectionChange([...selectedTemplateIds, savedTemplate.id]);
      }

      setLocalNewTemplate(null);
      setLocalNewSelected(false);
      setActiveTemplateId(savedTemplate.id);
      setDraft(savedTemplateDraft);
      setSavedDraft(savedTemplateDraft);
      return true;
    }

    if (localNewTemplate && activeTemplateId === localNewTemplate.id && !nextDraft.templateId) {
      setLocalNewTemplate({
        ...localNewTemplate,
        name: nextDraft.name,
        fileName: nextDraft.fileName,
        body: nextDraft.body,
        scope: nextDraft.scope
      });
    }

    setDraft(nextDraft);
    setSavedDraft(nextDraft);
    return true;
  }

  async function deleteActiveTemplate(): Promise<void> {
    const templateId = activeTemplateId;

    if (!templateId) {
      return;
    }

    const remainingTemplates = displayedTemplates.filter((template) => template.id !== templateId);
    const remainingSelectedTemplateIds = effectiveSelectedTemplateIds.filter(
      (selectedTemplateId) => selectedTemplateId !== templateId
    );
    const nextTemplate = getInitialTemplate(remainingTemplates, remainingSelectedTemplateIds);
    const nextDraft = nextTemplate ? createDraftFromTemplate(nextTemplate) : EMPTY_DRAFT;

    setLocalError(undefined);

    try {
      if (localNewTemplate?.id === templateId && !draft.templateId) {
        setLocalNewTemplate(null);
        setLocalNewSelected(false);
      } else {
        await onDeleteTemplate(templateId);
      }

      setActiveTemplateId(nextTemplate?.id ?? null);
      setDraft(nextDraft);
      setSavedDraft(nextDraft);
      setPendingAction(null);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "删除模板失败");
    }
  }

  async function saveAndRunPendingAction(): Promise<void> {
    const action = pendingAction;
    if (!action) {
      return;
    }

    const saved = await saveDraft();
    if (!saved) {
      return;
    }

    setPendingAction(null);
    runAction(action);
  }

  function discardAndRunPendingAction(): void {
    const action = pendingAction;
    if (!action) {
      return;
    }

    setPendingAction(null);
    runAction(action);
  }

  function renderTemplateGroup(title: string, groupTemplates: readonly TemplateView[]) {
    const allSelected =
      groupTemplates.length > 0 &&
      groupTemplates.every((template) => effectiveSelectedTemplateIds.includes(template.id));
    const noneSelected = groupTemplates.every(
      (template) => !effectiveSelectedTemplateIds.includes(template.id)
    );

    return (
      <fieldset className="template-modal__group" aria-label={title}>
        <div className="template-modal__group-heading">
          <legend>{title}</legend>
          <div className="template-selector__bulk">
            <label>
              <input
                checked={allSelected}
                disabled={groupTemplates.length === 0}
                onChange={() => toggleGroupSelection(groupTemplates, true)}
                type="checkbox"
              />
              <span>全选</span>
            </label>
            <label>
              <input
                checked={noneSelected}
                disabled={groupTemplates.length === 0}
                onChange={() => toggleGroupSelection(groupTemplates, false)}
                type="checkbox"
              />
              <span>全不选</span>
            </label>
          </div>
        </div>

        {groupTemplates.length > 0 ? (
          <div className="template-modal__cards">
            {groupTemplates.map((template) => {
              const selected = effectiveSelectedTemplateIds.includes(template.id);
              const active = activeTemplateId === template.id;

              return (
                <article
                  className={`template-modal__card${active ? " template-modal__card--active" : ""}`}
                  key={template.id}
                >
                  <label className="template-modal__card-check">
                    <input
                      aria-label={`使用 ${template.name}`}
                      checked={selected}
                      onChange={(event) => toggleTemplateSelection(template, event.currentTarget.checked)}
                      type="checkbox"
                    />
                  </label>
                  <button
                    aria-label={`预览编辑 ${template.name}`}
                    aria-pressed={active}
                    className="template-modal__card-button"
                    onClick={() => requestAction({ type: "select", templateId: template.id })}
                    type="button"
                  >
                    <span className="template-modal__card-name">{template.name}</span>
                  </button>
                </article>
              );
            })}
          </div>
        ) : (
          <p className="empty-text">暂无{title}</p>
        )}
      </fieldset>
    );
  }

  return (
    <div className="provider-modal__backdrop">
      <section
        aria-labelledby="template-modal-title"
        aria-modal="true"
        className="provider-modal template-modal"
        role="dialog"
      >
        <div className="provider-modal__header template-modal__header">
          <div className="template-modal__header-main">
            <div>
              <p className="section-kicker">Templates</p>
              <h2 id="template-modal-title">模板选择与编辑</h2>
            </div>
            <div className="template-modal__header-actions">
              <button
                className="button button--secondary button--compact"
                onClick={() => requestAction({ type: "new" })}
                type="button"
              >
                新增模板
              </button>
            </div>
          </div>
          <button
            aria-label="关闭模板选择"
            className="button button--quiet button--compact template-modal__close-button"
            onClick={() => requestAction({ type: "close" })}
            type="button"
          >
            关闭
          </button>
        </div>

        <div className="template-modal__workspace">
          <aside className="template-modal__library" aria-label="模板列表">
            <div className="template-modal__filters">
              <label className="provider-form__field">
                <span>搜索模板</span>
                <input
                  onChange={(event) => setSearchQuery(event.currentTarget.value)}
                  placeholder="输入模板名字"
                  value={searchQuery}
                />
              </label>
              <label className="provider-form__radio">
                <input
                  checked={showSelectedOnly}
                  onChange={(event) => setShowSelectedOnly(event.currentTarget.checked)}
                  type="checkbox"
                />
                <span>仅看已选</span>
              </label>
            </div>

            <div className="template-modal__scroll">
              {renderTemplateGroup("全局模板", filteredGroups.global)}
              {renderTemplateGroup("项目模板", filteredGroups.project)}
            </div>
          </aside>

          <section className="template-modal__editor" aria-label="模板预览编辑">
            <div className="template-modal__editor-header">
              <p className="template-modal__editor-title">
                当前模板：<strong>{activeTemplateId ? draft.name || "未命名模板" : "请选择或新增模板"}</strong>
              </p>
              <div className="template-modal__editor-actions">
                <button
                  aria-label="删除模板"
                  className="button button--danger button--compact"
                  disabled={!activeTemplateId || isSaving}
                  onClick={() => {
                    void deleteActiveTemplate();
                  }}
                  type="button"
                >
                  删除
                </button>
                <button
                  className="button button--quiet button--compact"
                  disabled={!isDirty}
                  onClick={() => {
                    setDraft(savedDraft);
                    setLocalError(undefined);
                  }}
                  type="button"
                >
                  重置模板
                </button>
                <button
                  className="button button--primary button--compact"
                  disabled={isSaving}
                  onClick={() => {
                    void saveDraft();
                  }}
                  type="button"
                >
                  保存
                </button>
                {isDirty ? <span className="status-chip">未保存</span> : null}
              </div>
            </div>

            <div className="template-modal__editor-form">
              <label className="provider-form__field">
                <span>模板名字</span>
                <input
                  onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
                  value={draft.name}
                />
              </label>

              <label className="provider-form__field">
                <span>模板范围</span>
                <select
                  onChange={(event) =>
                    setDraft({ ...draft, scope: event.currentTarget.value as TemplateScope })
                  }
                  value={draft.scope}
                >
                  <option value="project">项目模板</option>
                  <option value="global">全局模板</option>
                </select>
              </label>

              <label className="provider-form__field template-modal__body-field">
                <span>模板正文</span>
                <textarea
                  onChange={(event) => setDraft({ ...draft, body: event.currentTarget.value })}
                  placeholder="填写这个模板要提取的内容、字段和输出要求"
                  value={draft.body}
                />
              </label>
            </div>

            {localError || saveError ? (
              <p className="form-error" role="alert">
                {localError ?? saveError}
              </p>
            ) : null}
          </section>
        </div>

        {isNameDialogOpen ? (
          <div
            className="template-modal__name-dialog"
            onMouseDown={closeNameDialog}
          >
            <section
              aria-label="新增模板"
              aria-modal="true"
              className="template-modal__name-card"
              onMouseDown={(event) => event.stopPropagation()}
              role="dialog"
            >
              <h3>新增模板</h3>
              <div className="template-modal__name-tabs" role="tablist" aria-label="新增模板方式">
                <button
                  aria-controls="manual-template-panel"
                  aria-selected={nameDialogTab === "manual"}
                  className="template-modal__name-tab"
                  onClick={() => {
                    setNameDialogTab("manual");
                    setNameDialogError(undefined);
                  }}
                  role="tab"
                  type="button"
                >
                  手动创建
                </button>
                <button
                  aria-controls="upload-template-panel"
                  aria-selected={nameDialogTab === "upload"}
                  className="template-modal__name-tab"
                  onClick={() => {
                    setNameDialogTab("upload");
                    setNameDialogError(undefined);
                  }}
                  role="tab"
                  type="button"
                >
                  上传模板
                </button>
              </div>

              {nameDialogTab === "manual" ? (
                <div id="manual-template-panel" role="tabpanel">
                  <label className="provider-form__field">
                    <span>新模板名字</span>
                    <input
                      autoFocus
                      onChange={(event) => {
                        setNewTemplateName(event.currentTarget.value);
                        setNameDialogError(undefined);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void createLocalTemplateFromName();
                        }
                        if (event.key === "Escape") {
                          closeNameDialog();
                        }
                      }}
                      placeholder="输入模板名字"
                      value={newTemplateName}
                    />
                  </label>
                </div>
              ) : (
                <div id="upload-template-panel" role="tabpanel">
                  <TemplateUploadPanel
                    footerActions={
                      <button className="button button--quiet button--compact" onClick={closeNameDialog} type="button">
                        取消
                      </button>
                    }
                    isSaving={isSaving}
                    projectId={projectId}
                    templates={displayedTemplates}
                    onSaveTemplate={onSaveTemplate}
                  />
                </div>
              )}
              {nameDialogTab === "manual" ? (
                <label className="provider-form__radio">
                  <input
                    checked={isNewTemplateGlobal}
                    onChange={(event) => setIsNewTemplateGlobal(event.currentTarget.checked)}
                    type="checkbox"
                  />
                  <span>是否全局模板</span>
                </label>
              ) : null}
              {nameDialogError ? (
                <p className="form-error" role="alert">
                  {nameDialogError}
                </p>
              ) : null}
              {nameDialogTab === "manual" ? (
                <div className="provider-form__actions template-modal__name-actions">
                  <button
                    className="button button--primary button--compact"
                    disabled={isSaving}
                    onClick={() => {
                      void createLocalTemplateFromName();
                    }}
                    type="button"
                  >
                    创建模板
                  </button>
                  <button className="button button--quiet button--compact" onClick={closeNameDialog} type="button">
                    取消
                  </button>
                </div>
              ) : null}
            </section>
          </div>
        ) : null}

        {pendingAction ? (
          <div
            aria-label="保存模板修改"
            aria-modal="true"
            className="template-modal__dirty-dialog"
            role="alertdialog"
          >
            <div className="template-modal__dirty-card">
              <h3>保存模板修改</h3>
              <p>当前模板内容还没保存，要先保存再继续吗？</p>
              <div className="provider-form__actions">
                <button
                  className="button button--primary"
                  disabled={isSaving}
                  onClick={() => {
                    void saveAndRunPendingAction();
                  }}
                  type="button"
                >
                  保存修改
                </button>
                <button className="button button--secondary" onClick={discardAndRunPendingAction} type="button">
                  放弃修改
                </button>
                <button className="button button--quiet" onClick={() => setPendingAction(null)} type="button">
                  继续编辑
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
