import { useState } from "react";
import { X } from "lucide-react";
import { getProviderPresets } from "@novel-extractor/config";
import type {
  FetchedProviderModelDto,
  FetchProviderModelsDto,
  ProviderViewDto,
  SaveProviderDto
} from "../../../shared/ipcTypes";
import { ProviderForm } from "./ProviderForm";
import {
  buildSaveProviderDto,
  clearProviderSecretAfterSave,
  createProviderFormState,
  mergeFetchedModelsIntoForm,
  type ProviderFormState,
  type ProviderResourceState,
  type ProviderSaveState
} from "./providerViewModel";

export interface ProviderConfigModalProps {
  open: boolean;
  providers: ProviderViewDto[];
  providerState: ProviderResourceState;
  providerError?: string;
  saveState: ProviderSaveState;
  saveError?: string;
  onClose: () => void;
  onFetchProviderModels: (input: FetchProviderModelsDto) => Promise<FetchedProviderModelDto[]>;
  onSaveProvider: (input: SaveProviderDto) => Promise<void> | void;
}

const PROVIDER_PRESETS = getProviderPresets();

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function ProviderConfigModal({
  open,
  providers,
  providerState,
  providerError,
  saveState,
  saveError,
  onClose,
  onFetchProviderModels,
  onSaveProvider
}: ProviderConfigModalProps) {
  const [formState, setFormState] = useState<ProviderFormState>(() =>
    createProviderFormState("deepseek")
  );

  if (!open) {
    return null;
  }

  async function handleSaveProvider(): Promise<void> {
    const dto = buildSaveProviderDto(formState);
    try {
      await onSaveProvider(dto);
    } catch {
      // App owns saveError state; keep the secret in the form for retry.
      return;
    }
    setFormState((currentState) => clearProviderSecretAfterSave(currentState));
  }

  async function handleFetchModels(): Promise<void> {
    const preset = PROVIDER_PRESETS.find((candidate) => candidate.id === formState.presetId);
    const requestProviderId = formState.providerId;
    const requestPresetId = formState.presetId;
    const requestBaseUrl = formState.baseUrl.trim();
    const requestModelsUrl = preset?.modelsUrl;
    const apiKey = formState.apiKey.trim();

    setFormState((currentState) => ({
      ...currentState,
      modelFetchState: "loading",
      modelFetchError: undefined
    }));

    try {
      const fetchedModels = await onFetchProviderModels({
        providerId: requestProviderId,
        presetId: requestPresetId,
        baseUrl: requestBaseUrl,
        apiKey: apiKey || undefined,
        modelsUrl: requestModelsUrl
      });

      setFormState((currentState) => {
        if (
          currentState.providerId !== requestProviderId ||
          currentState.presetId !== requestPresetId ||
          currentState.baseUrl.trim() !== requestBaseUrl
        ) {
          return currentState;
        }
        return mergeFetchedModelsIntoForm(currentState, fetchedModels);
      });
    } catch (error) {
      setFormState((currentState) => {
        if (
          currentState.providerId !== requestProviderId ||
          currentState.presetId !== requestPresetId ||
          currentState.baseUrl.trim() !== requestBaseUrl
        ) {
          return currentState;
        }
        return {
          ...currentState,
          modelFetchState: "error",
          modelFetchError: getErrorMessage(error, "获取模型列表失败")
        };
      });
    }
  }

  return (
    <div className="provider-modal__backdrop">
      <section
        aria-labelledby="provider-modal-title"
        aria-modal="true"
        className="provider-modal"
        role="dialog"
      >
        <div className="provider-modal__header">
          <div className="provider-modal__title">
            <p className="section-kicker">Providers</p>
            <h2 id="provider-modal-title">大模型配置</h2>
          </div>
          <div className="provider-modal__header-actions">
            <span className="status-chip">{providers.length} 项配置</span>
            <button
              aria-label="关闭大模型配置"
              className="button button--quiet provider-modal__close-button"
              onClick={onClose}
              title="关闭"
              type="button"
            >
              <X aria-hidden="true" className="provider-modal__close-icon" />
            </button>
          </div>
        </div>

        <div className="provider-modal__body">
          <ProviderForm
            formState={formState}
            onCancel={onClose}
            onChange={setFormState}
            onFetchModels={() => {
              void handleFetchModels();
            }}
            onSubmit={() => {
              void handleSaveProvider();
            }}
            saveError={saveError}
            saveState={saveState}
          />

          <section className="provider-modal__providers" aria-labelledby="provider-list-title">
            <div className="panel-heading">
              <h3 id="provider-list-title">已保存配置</h3>
              <span>{providers.length} 项</span>
            </div>

            {providerState === "loading" ? (
              <div className="state-banner">正在读取大模型配置</div>
            ) : null}

            {providerState === "error" ? (
              <div className="state-banner state-banner--danger" role="alert">
                {providerError ?? "读取大模型配置失败"}
              </div>
            ) : null}

            {providerState === "ready" && providers.length === 0 ? (
              <p className="empty-text">暂无大模型配置</p>
            ) : null}

            {providers.length > 0 ? (
              <ul className="provider-list">
                {providers.map((provider) => (
                  <li className="provider-row" key={provider.id}>
                    <div>
                      <strong>{provider.displayName}</strong>
                      <span>{provider.baseUrl ?? "未配置 Base URL"}</span>
                    </div>
                    <div className="provider-row__meta">
                      <span>{provider.hasApiKey ? "API key 已保存" : "未保存 API key"}</span>
                      <span>{provider.enabled ? "已启用" : "已停用"}</span>
                    </div>
                    <ul className="provider-row__models">
                      {provider.models.map((model) => (
                        <li key={model.id}>
                          {model.displayName}
                          {model.isDefault ? " 默认" : ""}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        </div>
      </section>
    </div>
  );
}
