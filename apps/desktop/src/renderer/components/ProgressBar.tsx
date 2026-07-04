export interface ProgressBarProps {
  value: number;
  label: string;
  className?: string;
  indicatorClassName?: string;
}

function clampProgressValue(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(100, Math.max(0, value));
}

function joinClassNames(classNames: readonly (string | undefined)[]): string {
  return classNames.filter(Boolean).join(" ");
}

export function ProgressBar({ value, label, className, indicatorClassName }: ProgressBarProps) {
  const progressValue = clampProgressValue(value);

  return (
    <div
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={progressValue}
      className={joinClassNames(["progress-meter", className])}
      role="progressbar"
    >
      <span
        className={joinClassNames(["progress-meter__bar", indicatorClassName])}
        style={{ width: `${progressValue}%` }}
      />
    </div>
  );
}
