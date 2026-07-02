import { Minus, Square, X } from "lucide-react";

export interface WindowTitleBarProps {
  appName?: string;
  onMinimize?: () => void;
  onToggleMaximize?: () => void;
  onClose?: () => void;
}

export function WindowTitleBar({
  appName = "NovelExtractor",
  onMinimize,
  onToggleMaximize,
  onClose
}: WindowTitleBarProps): JSX.Element {
  return (
    <header className="window-title-bar" aria-label="窗口标题栏">
      <div className="window-title-bar__brand" aria-hidden="true">
        <span className="window-title-bar__icon">NE</span>
        <span>{appName}</span>
      </div>
      <div className="window-title-bar__controls">
        <button
          aria-label="最小化窗口"
          className="window-title-bar__button"
          onClick={onMinimize}
          type="button"
        >
          <Minus aria-hidden="true" className="window-title-bar__button-icon" />
        </button>
        <button
          aria-label="最大化或还原窗口"
          className="window-title-bar__button"
          onClick={onToggleMaximize}
          type="button"
        >
          <Square aria-hidden="true" className="window-title-bar__button-icon" />
        </button>
        <button
          aria-label="关闭窗口"
          className="window-title-bar__button window-title-bar__button--close"
          onClick={onClose}
          type="button"
        >
          <X aria-hidden="true" className="window-title-bar__button-icon" />
        </button>
      </div>
    </header>
  );
}
