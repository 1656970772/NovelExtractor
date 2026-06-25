"""Console progress reporter."""

from contextlib import AbstractContextManager, nullcontext
from pathlib import Path
import sys
import threading
import time
from typing import Protocol, TextIO

from novel_extractor.reasonix_compat.usage import (
    DEFAULT_DEEPSEEK_PRICING,
    Pricing,
    TokenBudgetExceeded,
    Usage,
    UsageTracker,
)


class ProgressReporter(Protocol):
    """Protocol for progress reporters."""

    def start_run(
        self,
        novel_id: str,
        total_chapters: int,
        total_windows: int,
        template_count: int,
        window_size: int,
        stride: int,
        output_dir: str,
    ) -> None:
        raise NotImplementedError

    def start_window(self, index: int, total: int, window_id: str) -> None:
        raise NotImplementedError

    def routed_groups(self, group_ids: list[str]) -> None:
        raise NotImplementedError

    def group_running(self, group_id: str, output_files: list[str]) -> None:
        raise NotImplementedError

    def group_skipped(self, group_id: str, reason: str) -> None:
        raise NotImplementedError

    def model_call(self, model: str, prompt_chars: int, existing_snippet_count: int) -> None:
        raise NotImplementedError

    def model_usage(self, usage: Usage) -> None:
        raise NotImplementedError

    def prompt_budget_status(self, decision) -> None:
        raise NotImplementedError

    def group_completed(self, group_id: str, written_files: list[str]) -> None:
        raise NotImplementedError

    def group_failed(self, group_id: str, error: str) -> None:
        raise NotImplementedError

    def activity(self, message: str) -> AbstractContextManager[None]:
        raise NotImplementedError


class NullProgressReporter:
    """Silent progress reporter."""

    def start_run(self, *args, **kwargs) -> None:
        pass

    def start_window(self, *args, **kwargs) -> None:
        pass

    def routed_groups(self, *args, **kwargs) -> None:
        pass

    def group_running(self, *args, **kwargs) -> None:
        pass

    def group_skipped(self, *args, **kwargs) -> None:
        pass

    def model_call(self, *args, **kwargs) -> None:
        pass

    def model_usage(self, *args, **kwargs) -> None:
        pass

    def prompt_budget_status(self, *args, **kwargs) -> None:
        pass

    def group_completed(self, *args, **kwargs) -> None:
        pass

    def group_failed(self, *args, **kwargs) -> None:
        pass

    def activity(self, *args, **kwargs) -> AbstractContextManager[None]:
        return nullcontext()


class ConsoleProgressReporter:
    """Console-based progress reporter."""

    def __init__(
        self,
        stream: TextIO | None = None,
        enabled: bool = True,
        verbose: bool = False,
        show_skipped: bool = True,
        pricing: Pricing | None = None,
        run_token_budget: int | None = None,
        group_labels: dict[str, str] | None = None,
        activity_interval: float = 1.0,
        dynamic_activity: bool | None = None,
    ) -> None:
        self.stream = stream or sys.stdout
        self.enabled = enabled
        self.verbose = verbose
        self.show_skipped = show_skipped
        self.pricing = pricing or DEFAULT_DEEPSEEK_PRICING
        self.usage_tracker = UsageTracker()
        self.run_token_budget = run_token_budget
        self.group_labels = group_labels or {}
        self.activity_interval = activity_interval
        self.dynamic_activity = (
            bool(getattr(self.stream, "isatty", lambda: False)())
            if dynamic_activity is None
            else dynamic_activity
        )
        self._output_lock = threading.Lock()

    def _print(self, message: str) -> None:
        if self.enabled:
            with self._output_lock:
                print(message, file=self.stream, flush=True)

    def start_run(
        self,
        novel_id: str,
        total_chapters: int,
        total_windows: int,
        template_count: int,
        window_size: int,
        stride: int,
        output_dir: str,
    ) -> None:
        self._print(f"[NovelExtractor] {novel_id}")
        self._print(f"配置：{template_count} 个模板，窗口 size={window_size} stride={stride}")
        self._print(f"章节：共 {total_chapters} 章")
        self._print(f"目标目录：{output_dir}")
        self._print("")

    def start_window(self, index: int, total: int, window_id: str) -> None:
        self._print(f"[窗口 {index}/{total}] {window_id}")

    def routed_groups(self, group_ids: list[str]) -> None:
        groups = "，".join(self._format_group_ref(group_id) for group_id in group_ids)
        self._print(f"  路由命中模板组：{groups}")

    def group_running(self, group_id: str, output_files: list[str]) -> None:
        label = self._group_label(group_id, output_files)
        label_text = f" {label}" if label else ""
        self._print(f"  模板组 [{group_id}]{label_text}：处理中")
        self._print(f"    输出文件：{', '.join(output_files)}")

    def group_skipped(self, group_id: str, reason: str) -> None:
        if self.show_skipped:
            self._print(f"  [{group_id}] skipped - {reason}")

    def model_call(self, model: str, prompt_chars: int, existing_snippet_count: int) -> None:
        if self.verbose:
            self._print(f"    模型调用：{model}, prompt {prompt_chars} chars, {existing_snippet_count} snippets")

    def model_usage(self, usage: Usage) -> None:
        line = self.usage_tracker.format_turn_line(usage, self.pricing)
        self.usage_tracker.record(usage, self.pricing)
        if self.run_token_budget is not None and self.usage_tracker.total_tokens > self.run_token_budget:
            raise TokenBudgetExceeded(
                f"run token budget exceeded: {self.usage_tracker.total_tokens}/{self.run_token_budget}"
            )
        if self.verbose and line:
            self._print(f"    {line}")

    def prompt_budget_warning(self, decision) -> None:
        if self.verbose:
            self._print(
                "    prompt budget warning: "
                f"{decision.prompt_tokens_estimate}/{decision.context_window} tokens "
                f"({decision.ratio:.2%})"
            )

    def prompt_budget_status(self, decision) -> None:
        if self.verbose:
            self._print(
                "    prompt estimate: "
                f"{decision.prompt_tokens_estimate}/{decision.context_window} tokens "
                f"({decision.ratio:.2%}, {decision.level})"
            )

    def model_cache_diagnostics(self, diagnostics) -> None:
        if self.verbose and diagnostics.prefix_changed:
            reasons = "+".join(diagnostics.prefix_change_reasons)
            self._print(f"    cache prefix changed: {reasons}")

    def group_completed(self, group_id: str, written_files: list[str]) -> None:
        for file in written_files:
            self._print(f"    写入：{file}")
        self._print(f"    状态：completed")

    def group_failed(self, group_id: str, error: str) -> None:
        self._print(f"    状态：failed - {error}")

    def activity(self, message: str) -> AbstractContextManager[None]:
        return _ConsoleActivity(self, message)

    def usage_summary(self) -> str:
        return self.usage_tracker.format_summary(self.pricing)

    def _format_group_ref(self, group_id: str) -> str:
        label = self.group_labels.get(group_id)
        if not label or label == group_id:
            return group_id
        return f"{group_id}（{label}）"

    def _group_label(self, group_id: str, output_files: list[str]) -> str:
        label = self.group_labels.get(group_id)
        if label:
            return label
        names = [Path(filename).stem for filename in output_files if filename]
        return "、".join(names)

    def _start_activity(self, activity: "_ConsoleActivity") -> None:
        if not self.enabled:
            return
        activity.started_at = time.monotonic()
        self._print(f"    {activity.message}，请稍候...")
        if not self.dynamic_activity:
            return
        activity.stop_event = threading.Event()
        activity.thread = threading.Thread(target=self._spin_activity, args=(activity,), daemon=True)
        activity.thread.start()

    def _finish_activity(self, activity: "_ConsoleActivity", failed: bool) -> None:
        if not self.enabled:
            return
        if activity.stop_event is not None:
            activity.stop_event.set()
        if activity.thread is not None:
            activity.thread.join(timeout=self.activity_interval + 0.2)
            with self._output_lock:
                self.stream.write("\r" + " " * activity.clear_width + "\r")
                self.stream.flush()
        elapsed = max(0, int(time.monotonic() - activity.started_at))
        status = "模型响应失败" if failed else "模型响应完成"
        self._print(f"    {status}（耗时 {elapsed}s）")

    def _spin_activity(self, activity: "_ConsoleActivity") -> None:
        frames = "|/-\\"
        index = 0
        while activity.stop_event is not None and not activity.stop_event.wait(self.activity_interval):
            elapsed = max(0, int(time.monotonic() - activity.started_at))
            line = f"    {frames[index % len(frames)]} {activity.message}（已等待 {elapsed}s）"
            activity.clear_width = max(activity.clear_width, len(line) + 4)
            with self._output_lock:
                self.stream.write("\r" + line)
                self.stream.flush()
            index += 1


class _ConsoleActivity:
    def __init__(self, reporter: ConsoleProgressReporter, message: str) -> None:
        self.reporter = reporter
        self.message = message
        self.started_at = 0.0
        self.stop_event: threading.Event | None = None
        self.thread: threading.Thread | None = None
        self.clear_width = 80

    def __enter__(self) -> None:
        self.reporter._start_activity(self)

    def __exit__(self, exc_type, exc, traceback) -> bool:
        self.reporter._finish_activity(self, failed=exc_type is not None)
        return False
