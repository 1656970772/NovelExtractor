"""Token-saving policy helpers."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any


_CJK_RE = re.compile(
    "[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff"
    "\U00020000-\U0002ceaf\U0002f800-\U0002fa1f]"
)


@dataclass(frozen=True)
class PromptBudgetDecision:
    prompt_tokens_estimate: int
    context_window: int
    ratio: float
    level: str
    action: str


class PromptBudgetExceeded(RuntimeError):
    def __init__(self, decision: PromptBudgetDecision) -> None:
        self.decision = decision
        super().__init__(
            "prompt budget exceeded: "
            f"{decision.prompt_tokens_estimate}/{decision.context_window} tokens "
            f"({decision.ratio:.2%}), action={decision.action}"
        )


class PromptBudgeter:
    def __init__(
        self,
        context_window: int,
        warn_ratio: float,
        hard_ratio: float,
        strategy: str = "split",
        allow_summarize_chapters: bool = False,
    ) -> None:
        self.context_window = context_window
        self.warn_ratio = warn_ratio
        self.hard_ratio = hard_ratio
        self.strategy = strategy
        self.allow_summarize_chapters = allow_summarize_chapters

    @classmethod
    def from_config(cls, config: Any) -> "PromptBudgeter":
        return cls(
            context_window=config.context_window,
            warn_ratio=config.warn_ratio,
            hard_ratio=config.hard_ratio,
            strategy=config.strategy,
            allow_summarize_chapters=config.allow_summarize_chapters,
        )

    def evaluate(self, system_prompt: str, user_prompt: str) -> PromptBudgetDecision:
        tokens = estimate_tokens(system_prompt) + estimate_tokens(user_prompt)
        ratio = tokens / self.context_window if self.context_window else 0
        if ratio >= self.hard_ratio:
            level = "hard"
            action = self.strategy
        elif ratio >= self.warn_ratio:
            level = "warn"
            action = "continue"
        else:
            level = "ok"
            action = "continue"

        if action == "summarize" and not self.allow_summarize_chapters:
            action = "split"

        return PromptBudgetDecision(
            prompt_tokens_estimate=tokens,
            context_window=self.context_window,
            ratio=ratio,
            level=level,
            action=action,
        )


def estimate_tokens(text: str) -> int:
    return max((len(text) + 3) // 4, len(_CJK_RE.findall(text)))
