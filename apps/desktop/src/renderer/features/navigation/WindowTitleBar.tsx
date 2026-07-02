import { Minus, Square, X } from "lucide-react";

export function WindowTitleBar() {
  function minimizeWindow(): void {
    void window.novelExtractor?.minimizeWindow?.();
  }

  function toggleMaximizeWindow(): void {
    void window.novelExtractor?.toggleMaximizeWindow?.();
  }

  function closeWindow(): void {
    void window.novelExtractor?.closeWindow?.();
  }

  return (
    <header className="window-title-bar" aria-label="窗口标题栏">
      <div className="window-title-bar__brand" aria-hidden="true">
        <span className="window-title-bar__icon">NE</span>
        <span>NovelExtractor</span>
      </div>
      <div className="window-title-bar__controls">
        <button
          aria-label="最小化窗口"
          className="window-title-bar__button"
          onClick={minimizeWindow}
          type="button"
        >
          <Minus aria-hidden="true" className="window-title-bar__button-icon" />
        </button>
        <button
          aria-label="最大化或还原窗口"
          className="window-title-bar__button"
          onClick={toggleMaximizeWindow}
          type="button"
        >
          <Square aria-hidden="true" className="window-title-bar__button-icon" />
        </button>
        <button
          aria-label="关闭窗口"
          className="window-title-bar__button window-title-bar__button--close"
          onClick={closeWindow}
          type="button"
        >
          <X aria-hidden="true" className="window-title-bar__button-icon" />
        </button>
      </div>
    </header>
  );
}
