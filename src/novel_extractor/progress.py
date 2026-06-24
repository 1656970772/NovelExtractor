"""Console progress reporter."""

import sys
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
    ) -> None:
        self.stream = stream or sys.stdout
        self.enabled = enabled
        self.verbose = verbose
        self.show_skipped = show_skipped
        self.pricing = pricing or DEFAULT_DEEPSEEK_PRICING
        self.usage_tracker = UsageTracker()
        self.run_token_budget = run_token_budget

    def _print(self, message: str) -> None:
        if self.enabled:
            print(message, file=self.stream)

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
        self._print(f"  路由命中：{', '.join(group_ids)}")

    def group_running(self, group_id: str, output_files: list[str]) -> None:
        self._print(f"  [{group_id}] running")
        self._print(f"    模板输出：{', '.join(output_files)}")

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

    def usage_summary(self) -> str:
        return self.usage_tracker.format_summary(self.pricing)
