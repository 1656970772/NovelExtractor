/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderViewDto, SaveProviderDto } from "../../../shared/ipcTypes";
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
    }
  ],
  hasApiKey: true,
  enabled: true
};

function renderModal(
  overrides: Partial<ComponentProps<typeof ProviderConfigModal>> = {}
) {
  const onSaveProvider = vi.fn<(input: SaveProviderDto) => Promise<void> | void>();
  const props: ComponentProps<typeof ProviderConfigModal> = {
    open: true,
    providers: [providerView],
    providerState: "ready",
    saveState: "idle",
    onClose: vi.fn(),
    onSaveProvider,
    ...overrides
  };

  render(<ProviderConfigModal {...props} />);

  return { onSaveProvider, props };
}

describe("ProviderConfigModal and UserMenu", () => {
  it("opens provider config from user disclosure without menu roles", async () => {
    const user = userEvent.setup();
    const onOpenProviderConfig = vi.fn();
    const onOpenSettings = vi.fn();

    render(<UserMenu onOpenProviderConfig={onOpenProviderConfig} onOpenSettings={onOpenSettings} />);

    await user.click(screen.getByRole("button", { name: "用户菜单" }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "大模型配置" }));

    expect(onOpenProviderConfig).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "用户菜单" }));
    await user.click(screen.getByRole("button", { name: "设置" }));

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("shows only the configured provider modes in a centered dialog", () => {
    renderModal();

    const dialog = screen.getByRole("dialog", { name: "大模型配置" });
    expect(dialog).toHaveClass("provider-modal");
    expect(within(dialog).getByRole("radio", { name: "DeepSeek" })).toBeInTheDocument();
    expect(
      within(dialog).getByRole("radio", { name: "自定义 OpenAI-compatible" })
    ).toBeInTheDocument();
    expect(within(dialog).getAllByRole("radio")).toHaveLength(2);
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
        onSaveProvider={vi.fn()}
      />
    );
    expect(screen.getByText("暂无大模型配置")).toBeInTheDocument();
  });
});
