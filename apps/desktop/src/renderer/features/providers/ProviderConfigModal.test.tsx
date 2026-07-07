/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FetchedProviderModelDto,
  FetchProviderModelsDto,
  ProviderViewDto,
  SaveProviderDto
} from "../../../shared/ipcTypes";
import { ProviderConfigModal } from "./ProviderConfigModal";
import { UserMenu } from "./UserMenu";

afterEach(() => cleanup());

const providerView: ProviderViewDto = {
  id: "provider-1",
  presetId: "deepseek",
  displayName: "DeepSeek",
  kind: "openai-compatible",
  baseUrl: "https://api.deepseek.com",
  models: [
    {
      id: "deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash",
      enabled: true,
      isDefault: true
    },
    {
      id: "deepseek-v4-pro",
      displayName: "DeepSeek V4 Pro",
      enabled: true,
      isDefault: false
    }
  ],
  hasApiKey: true,
  enabled: true
};

function renderModal(
  overrides: Partial<ComponentProps<typeof ProviderConfigModal>> = {}
) {
  const onSaveProvider = vi.fn<(input: SaveProviderDto) => Promise<void> | void>();
  const onFetchProviderModels = vi.fn<
    (input: FetchProviderModelsDto) => Promise<FetchedProviderModelDto[]>
  >().mockResolvedValue([]);
  const props: ComponentProps<typeof ProviderConfigModal> = {
    open: true,
    providers: [providerView],
    providerState: "ready",
    saveState: "idle",
    onClose: vi.fn(),
    onSaveProvider,
    onFetchProviderModels,
    ...overrides
  };

  render(<ProviderConfigModal {...props} />);

  return { onFetchProviderModels: props.onFetchProviderModels, onSaveProvider, props };
}

describe("ProviderConfigModal and UserMenu", () => {
  it("opens provider config from user disclosure without menu roles", async () => {
    const user = userEvent.setup();
    const onOpenProviderConfig = vi.fn();

    render(<UserMenu onOpenProviderConfig={onOpenProviderConfig} />);

    await user.click(screen.getByRole("button", { name: "用户菜单" }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "大模型配置" }));

    expect(onOpenProviderConfig).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "用户菜单" }));

    expect(screen.queryByRole("button", { name: "设置" })).not.toBeInTheDocument();
  });

  it("shows all P1 provider modes in a centered dialog", () => {
    renderModal();

    const dialog = screen.getByRole("dialog", { name: "大模型配置" });
    expect(dialog).toHaveClass("provider-modal");
    expect(within(dialog).getByRole("radio", { name: "Kimi" })).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: "MiniMax" })).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: "Xiaomi MiMo" })).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "服务模式" })).getAllByRole("radio")).toHaveLength(11);
  });

  it("closes the provider config dialog from the header action", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderModal({ onClose });

    await user.click(screen.getByRole("button", { name: "关闭大模型配置" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows Xiaomi MiMo preset models with locked Base URL", async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole("radio", { name: "Xiaomi MiMo" }));

    expect(screen.getByRole("textbox", { name: "模型型号 MiMo V2.5 Pro" })).toHaveValue("mimo-v2.5-pro");
    expect(screen.getByRole("textbox", { name: "模型型号 MiMo V2.5" })).toHaveValue("mimo-v2.5");
    expect(screen.getByRole("radio", { name: "设为默认 MiMo V2.5 Pro" })).toBeChecked();
    expect(screen.getByLabelText("Base URL")).toHaveAttribute("readonly");
  });

  it("shows provider metadata links and protocol label", () => {
    renderModal();

    expect(screen.getByRole("link", { name: "官网" })).toHaveAttribute(
      "href",
      "https://platform.deepseek.com"
    );
    expect(screen.getByRole("link", { name: "API key" })).toHaveAttribute(
      "href",
      "https://platform.deepseek.com/api_keys"
    );
    expect(screen.getByText("openai_chat")).toBeInTheDocument();
  });

  it("fetches provider models, merges live models, and saves the selected live model", async () => {
    const user = userEvent.setup();
    const { onFetchProviderModels, onSaveProvider } = renderModal({
      providers: [],
      onFetchProviderModels: vi.fn().mockResolvedValue([{ id: "deepseek-live" }])
    });

    await user.type(screen.getByLabelText("API key"), "  test-api-key  ");
    await user.click(screen.getByRole("button", { name: "获取模型列表" }));

    expect(onFetchProviderModels).toHaveBeenCalledWith({
      presetId: "deepseek",
      baseUrl: "https://api.deepseek.com",
      apiKey: "test-api-key",
      modelsUrl: "https://api.deepseek.com/models"
    });

    expect(await screen.findByRole("textbox", { name: "模型型号 deepseek-live" })).toHaveValue("deepseek-live");

    await user.click(screen.getByRole("radio", { name: "设为默认 deepseek-live" }));
    await user.click(screen.getByRole("button", { name: "保存配置" }));

    expect(onSaveProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        modelName: "deepseek-live",
        models: expect.arrayContaining([
          expect.objectContaining({
            id: "deepseek-v4-flash",
            isDefault: false
          }),
          expect.objectContaining({
            id: "deepseek-live",
            displayName: "deepseek-live",
            enabled: true,
            isDefault: true
          })
        ])
      })
    );
  });

  it("edits a saved provider without showing api key and saves updated default model", async () => {
    const user = userEvent.setup();
    const { onSaveProvider } = renderModal();

    await user.click(screen.getByRole("button", { name: "编辑 DeepSeek" }));

    expect(screen.getByLabelText("API key")).toHaveValue("");

    await user.click(screen.getByRole("radio", { name: "设为默认 DeepSeek V4 Pro" }));
    await user.clear(screen.getByRole("textbox", { name: "模型型号 DeepSeek V4 Pro" }));
    await user.type(screen.getByRole("textbox", { name: "模型型号 DeepSeek V4 Pro" }), " deepseek-v4-pro-chat ");
    await user.click(screen.getByRole("button", { name: "保存配置" }));

    expect(onSaveProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "provider-1",
        apiKey: undefined,
        modelName: "deepseek-v4-pro-chat",
        models: [
          expect.objectContaining({
            id: "deepseek-v4-flash",
            displayName: "DeepSeek V4 Flash",
            enabled: true,
            isDefault: false
          }),
          expect.objectContaining({
            id: "deepseek-v4-pro-chat",
            displayName: "DeepSeek V4 Pro",
            enabled: true,
            isDefault: true
          })
        ]
      })
    );
  });

  it("keeps the selected default model enabled while editing saved provider models", async () => {
    const user = userEvent.setup();
    renderModal({
      providers: [
        {
          ...providerView,
          models: [
            providerView.models[0],
            {
              ...providerView.models[1],
              enabled: false
            }
          ]
        }
      ]
    });

    await user.click(screen.getByRole("button", { name: "编辑 DeepSeek" }));

    const defaultEnabled = screen.getByRole("checkbox", { name: "启用 DeepSeek V4 Flash" });
    expect(defaultEnabled).toBeChecked();
    expect(defaultEnabled).toBeDisabled();

    await user.click(screen.getByRole("radio", { name: "设为默认 DeepSeek V4 Pro" }));

    const nextDefaultEnabled = screen.getByRole("checkbox", { name: "启用 DeepSeek V4 Pro" });
    expect(nextDefaultEnabled).toBeChecked();
    expect(nextDefaultEnabled).toBeDisabled();
  });

  it("adds a custom model row and saves it as the default model", async () => {
    const user = userEvent.setup();
    const { onSaveProvider } = renderModal({ providers: [] });

    await user.click(screen.getByRole("radio", { name: "自定义 OpenAI-compatible" }));
    await user.type(screen.getByLabelText("Base URL"), "https://llm.example.test/v1");
    await user.type(screen.getByLabelText("API key"), "sk-custom-test");
    await user.type(screen.getByRole("textbox", { name: "模型型号 1" }), "custom-first");
    await user.click(screen.getByRole("button", { name: "添加模型" }));
    await user.type(screen.getByRole("textbox", { name: "模型型号 2" }), "custom-second");
    await user.click(screen.getByRole("radio", { name: "设为默认 custom-second" }));
    await user.click(screen.getByRole("button", { name: "保存配置" }));

    expect(onSaveProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        presetId: "custom-openai-compatible",
        modelName: "custom-second",
        models: [
          expect.objectContaining({ id: "custom-first", enabled: true, isDefault: false }),
          expect.objectContaining({ id: "custom-second", enabled: true, isDefault: true })
        ]
      })
    );
  });

  it("does not merge stale fetched models after switching presets", async () => {
    const user = userEvent.setup();
    let resolveFetch: ((models: FetchedProviderModelDto[]) => void) | undefined;

    renderModal({
      providers: [],
      onFetchProviderModels: vi.fn(
        () =>
          new Promise<FetchedProviderModelDto[]>((resolve) => {
            resolveFetch = resolve;
          })
      )
    });

    await user.click(screen.getByRole("button", { name: "获取模型列表" }));
    await user.click(screen.getByRole("radio", { name: "自定义 OpenAI-compatible" }));

    await act(async () => {
      resolveFetch?.([{ id: "deepseek-live" }]);
    });

    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "模型型号 1" })).toHaveValue("");
    });
    expect(screen.queryByRole("textbox", { name: "模型型号 deepseek-live" })).not.toBeInTheDocument();
  });

  it("uses editable model rows for custom providers after fetching live models", async () => {
    const user = userEvent.setup();
    const { onFetchProviderModels } = renderModal({
      providers: [],
      onFetchProviderModels: vi.fn().mockResolvedValue([{ id: "custom-live-model" }])
    });

    await user.click(screen.getByRole("radio", { name: "自定义 OpenAI-compatible" }));
    await user.type(screen.getByLabelText("Base URL"), "https://llm.example.test/v1");
    await user.click(screen.getByRole("button", { name: "获取模型列表" }));

    expect(onFetchProviderModels).toHaveBeenCalledWith({
      presetId: "custom-openai-compatible",
      baseUrl: "https://llm.example.test/v1",
      apiKey: undefined,
      modelsUrl: undefined
    });

    expect(await screen.findByRole("textbox", { name: "模型型号 custom-live-model" })).toHaveValue("custom-live-model");
    expect(screen.getByRole("radio", { name: "设为默认 custom-live-model" })).toBeChecked();
  });

  it("shows an OpenAI-compatible /v1 base URL example for custom providers", async () => {
    const user = userEvent.setup();
    renderModal({ providers: [] });

    await user.click(screen.getByRole("radio", { name: "自定义 OpenAI-compatible" }));

    expect(screen.getByLabelText("Base URL")).toHaveAttribute(
      "placeholder",
      "例如：https://api.jiu96.com/v1"
    );
  });

  it("disables save and cancel while saving", () => {
    renderModal({ saveState: "saving" });

    expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
  });

  it("keeps save disabled when required fields are invalid", async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole("radio", { name: "自定义 OpenAI-compatible" }));

    expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
  });

  it("saves a provider, clears the password input, and never renders the secret", async () => {
    const user = userEvent.setup();
    const { onSaveProvider } = renderModal({ providers: [] });

    await user.type(screen.getByLabelText("API key"), "sk-visible-only-while-typing");
    await user.click(screen.getByRole("button", { name: "保存配置" }));

    expect(onSaveProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        presetId: "deepseek",
        apiKey: "sk-visible-only-while-typing",
        modelName: "deepseek-v4-flash"
      })
    );
    expect(screen.getByLabelText("API key")).toHaveValue("");
    expect(screen.queryByText("sk-visible-only-while-typing")).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("sk-visible-only-while-typing");
  });

  it("renders loading, error, and empty provider states", () => {
    const { rerender } = render(
      <ProviderConfigModal
        open
        providers={[]}
        providerState="loading"
        saveState="idle"
        onClose={vi.fn()}
        onFetchProviderModels={vi.fn().mockResolvedValue([])}
        onSaveProvider={vi.fn()}
      />
    );

    expect(screen.getByText("正在读取大模型配置")).toBeInTheDocument();

    rerender(
      <ProviderConfigModal
        open
        providers={[]}
        providerState="error"
        providerError="读取大模型配置失败"
        saveState="idle"
        onClose={vi.fn()}
        onFetchProviderModels={vi.fn().mockResolvedValue([])}
        onSaveProvider={vi.fn()}
      />
    );
    expect(screen.getByRole("alert")).toHaveTextContent("读取大模型配置失败");

    rerender(
      <ProviderConfigModal
        open
        providers={[]}
        providerState="ready"
        saveState="idle"
        onClose={vi.fn()}
        onFetchProviderModels={vi.fn().mockResolvedValue([])}
        onSaveProvider={vi.fn()}
      />
    );
    expect(screen.getByText("暂无大模型配置")).toBeInTheDocument();
  });
});
