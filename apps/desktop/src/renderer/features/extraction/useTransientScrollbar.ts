import { useCallback, useEffect, useRef, useState, type UIEventHandler } from "react";

export const TRANSIENT_SCROLLBAR_HIDE_DELAY_MS = 500;

export function useTransientScrollbar(
  hideDelayMs = TRANSIENT_SCROLLBAR_HIDE_DELAY_MS
): {
  isScrollbarActive: boolean;
  onScroll: UIEventHandler<HTMLElement>;
} {
  const [isScrollbarActive, setIsScrollbarActive] = useState(false);
  const hideTimerRef = useRef<number>();

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== undefined) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = undefined;
    }
  }, []);

  const onScroll = useCallback<UIEventHandler<HTMLElement>>(() => {
    setIsScrollbarActive(true);
    clearHideTimer();
    hideTimerRef.current = window.setTimeout(() => {
      setIsScrollbarActive(false);
      hideTimerRef.current = undefined;
    }, hideDelayMs);
  }, [clearHideTimer, hideDelayMs]);

  useEffect(() => clearHideTimer, [clearHideTimer]);

  return { isScrollbarActive, onScroll };
}
