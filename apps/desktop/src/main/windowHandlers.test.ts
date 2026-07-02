import { describe, expect, it, vi } from "vitest";
import { createIpcContract, createNotImplementedIpcHandlers } from "./ipc";
import { createWindowIpcHandlers, type WindowControlTarget } from "./windowHandlers";

function createWindow(overrides: Partial<WindowControlTarget> = {}): WindowControlTarget {
  return {
    close: vi.fn(),
    isMaximized: vi.fn(() => false),
    maximize: vi.fn(),
    minimize: vi.fn(),
    unmaximize: vi.fn(),
    ...overrides
  };
}

describe("window IPC handlers", () => {
  it("uses the focused window for minimize and close", async () => {
    const focusedWindow = createWindow();
    const fallbackWindow = createWindow();
    const handlers = {
      ...createNotImplementedIpcHandlers(),
      ...createWindowIpcHandlers({
        getAllWindows: () => [fallbackWindow],
        getFocusedWindow: () => focusedWindow
      })
    };
    const contract = createIpcContract();

    await contract.invoke(handlers, "window:minimize", undefined);
    await contract.invoke(handlers, "window:close", undefined);

    expect(focusedWindow.minimize).toHaveBeenCalledTimes(1);
    expect(focusedWindow.close).toHaveBeenCalledTimes(1);
    expect(fallbackWindow.minimize).not.toHaveBeenCalled();
    expect(fallbackWindow.close).not.toHaveBeenCalled();
  });

  it("falls back to the first window and toggles maximize state", async () => {
    const fallbackWindow = createWindow({
      isMaximized: vi.fn(() => false)
    });
    const handlers = {
      ...createNotImplementedIpcHandlers(),
      ...createWindowIpcHandlers({
        getAllWindows: () => [fallbackWindow],
        getFocusedWindow: () => null
      })
    };
    const contract = createIpcContract();

    await contract.invoke(handlers, "window:toggleMaximize", undefined);

    expect(fallbackWindow.maximize).toHaveBeenCalledTimes(1);
    expect(fallbackWindow.unmaximize).not.toHaveBeenCalled();
  });

  it("unmaximizes an already maximized window", async () => {
    const window = createWindow({
      isMaximized: vi.fn(() => true)
    });
    const handlers = {
      ...createNotImplementedIpcHandlers(),
      ...createWindowIpcHandlers({
        getAllWindows: () => [window],
        getFocusedWindow: () => window
      })
    };
    const contract = createIpcContract();

    await contract.invoke(handlers, "window:toggleMaximize", undefined);

    expect(window.unmaximize).toHaveBeenCalledTimes(1);
    expect(window.maximize).not.toHaveBeenCalled();
  });

  it("no-ops when no window is available", async () => {
    const handlers = {
      ...createNotImplementedIpcHandlers(),
      ...createWindowIpcHandlers({
        getAllWindows: () => [],
        getFocusedWindow: () => null
      })
    };
    const contract = createIpcContract();

    await expect(contract.invoke(handlers, "window:minimize", undefined)).resolves.toBeUndefined();
    await expect(
      contract.invoke(handlers, "window:toggleMaximize", undefined)
    ).resolves.toBeUndefined();
    await expect(contract.invoke(handlers, "window:close", undefined)).resolves.toBeUndefined();
  });
});
