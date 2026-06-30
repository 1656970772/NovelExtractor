import { FormEvent, useEffect, useState } from "react";
import type { DesktopSettingsDto, SaveDesktopSettingsDto } from "../../../shared/ipcTypes";

export type SettingsSaveState = "idle" | "saving" | "error";
export type SettingsLoadState = "idle" | "loading" | "error";

export interface StorageSettingsModalProps {
  open: boolean;
  settings?: DesktopSettingsDto;
  loadState?: SettingsLoadState;
  saveState?: SettingsSaveState;
  errorMessage?: string;
  onClose: () => void;
  onSaveSettings: (input: SaveDesktopSettingsDto) => Promise<DesktopSettingsDto | void>;
}

export function StorageSettingsModal({
  open,
  settings,
  loadState = "idle",
  saveState = "idle",
  errorMessage,
  onClose,
  onSaveSettings
}: StorageSettingsModalProps) {
  const [projectDirectory, setProjectDirectory] = useState("");
  const [savedMessage, setSavedMessage] = useState<string | undefined>();
  const isSaving = saveState === "saving";
  const isLoading = loadState === "loading";
  const fieldValue = projectDirectory;

  useEffect(() => {
    if (!open || !settings) {
      return;
    }

    setProjectDirectory(settings.projectStorageDirectory ?? settings.effectiveProjectStorageDirectory);
    setSavedMessage(undefined);
  }, [open, settings]);

  if (!open) {
    return null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSavedMessage(undefined);
    const trimmedDirectory = projectDirectory.trim();
    try {
      const savedSettings = await onSaveSettings({
        projectStorageDirectory: trimmedDirectory || undefined
      });

      if (savedSettings) {
        setProjectDirectory(
          savedSettings.projectStorageDirectory ?? savedSettings.effectiveProjectStorageDirectory
        );
      }
      setSavedMessage("已保存");
    } catch {
      setSavedMessage(undefined);
    }
  }

  return (
    <div className="provider-modal__backdrop">
      <section
        aria-labelledby="settings-title"
        aria-modal="true"
        className="provider-modal template-modal settings-modal"
        role="dialog"
      >
        <header className="template-modal__header">
          <div className="template-modal__header-main">
            <div>
              <p className="section-kicker">Settings</p>
              <h2 id="settings-title">设置</h2>
            </div>
          </div>
          <button
            aria-label="关闭设置"
            className="button button--secondary button--compact template-modal__close-button"
            onClick={onClose}
            type="button"
          >
            关闭
          </button>
        </header>

        <div className="template-modal__workspace settings-modal__workspace">
          <aside className="template-modal__library settings-modal__categories" aria-label="设置分类">
            <button
              aria-pressed="true"
              className="user-menu__item settings-modal__category-button"
              type="button"
            >
              存储
            </button>
          </aside>

          <section className="template-modal__editor settings-modal__panel" aria-labelledby="storage-settings-title">
            <div className="template-modal__editor-header">
              <div className="template-modal__editor-title">
                <strong id="storage-settings-title">存储</strong>
              </div>
            </div>
            <form className="template-modal__editor-form settings-modal__form" onSubmit={(event) => {
              void handleSubmit(event);
            }}>
              <label className="file-upload-field" htmlFor="project-storage-directory">
                项目目录
                <input
                  id="project-storage-directory"
                  name="projectStorageDirectory"
                  type="text"
                  value={fieldValue}
                  disabled={isLoading || isSaving}
                  onChange={(event) => setProjectDirectory(event.target.value)}
                />
              </label>

              {settings ? (
                <dl className="metadata-grid settings-modal__metadata">
                  <div>
                    <dt>默认</dt>
                    <dd>{settings.defaultProjectStorageDirectory}</dd>
                  </div>
                  <div>
                    <dt>当前</dt>
                    <dd>{settings.effectiveProjectStorageDirectory}</dd>
                  </div>
                </dl>
              ) : null}

              {errorMessage ? (
                <p className="form-error" role="alert">
                  {errorMessage}
                </p>
              ) : null}
              {savedMessage ? <p className="template-upload__success">{savedMessage}</p> : null}

              <div className="template-upload__actions">
                <button
                  className="button button--primary button--compact template-upload__submit-button"
                  disabled={isLoading || isSaving}
                  type="submit"
                >
                  {isSaving ? "保存中" : "保存设置"}
                </button>
              </div>
            </form>
          </section>
        </div>
      </section>
    </div>
  );
}
