"""Reasonix-style usage and cache accounting."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Usage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    cache_hit_tokens: int = 0
    cache_miss_tokens: int = 0
    reasoning_tokens: int = 0


@dataclass(frozen=True)
class Pricing:
    cache_hit: float
    input: float
    output: float
    currency: str = "CNY"

    def cost(self, usage: Usage) -> float:
        cache_miss_tokens = usage.cache_miss_tokens
        if cache_miss_tokens == 0 and usage.prompt_tokens > usage.cache_hit_tokens:
            cache_miss_tokens = usage.prompt_tokens - usage.cache_hit_tokens
        return (
            usage.cache_hit_tokens * self.cache_hit
            + cache_miss_tokens * self.input
            + usage.completion_tokens * self.output
        ) / 1_000_000


DEFAULT_DEEPSEEK_PRICING = Pricing(cache_hit=0.02, input=1.0, output=2.0, currency="CNY")


class TokenBudgetExceeded(RuntimeError):
    pass


def normalize_usage(raw: Any) -> Usage:
    """Normalize DeepSeek/OpenAI-compatible usage shapes."""
    if raw is None:
        return Usage()
    if hasattr(raw, "model_dump"):
        raw = raw.model_dump()
    elif not isinstance(raw, dict):
        raw = {
            "prompt_tokens": getattr(raw, "prompt_tokens", 0) or 0,
            "completion_tokens": getattr(raw, "completion_tokens", 0) or 0,
            "total_tokens": getattr(raw, "total_tokens", 0) or 0,
            "prompt_cache_hit_tokens": getattr(raw, "prompt_cache_hit_tokens", 0) or 0,
            "prompt_cache_miss_tokens": getattr(raw, "prompt_cache_miss_tokens", 0) or 0,
            "prompt_tokens_details": getattr(raw, "prompt_tokens_details", None),
            "completion_tokens_details": getattr(raw, "completion_tokens_details", None),
        }

    prompt_tokens = int(raw.get("prompt_tokens") or 0)
    completion_tokens = int(raw.get("completion_tokens") or 0)
    total_tokens = int(raw.get("total_tokens") or (prompt_tokens + completion_tokens))

    hit = int(raw.get("prompt_cache_hit_tokens") or 0)
    miss = int(raw.get("prompt_cache_miss_tokens") or 0)
    details = raw.get("prompt_tokens_details") or {}
    if hasattr(details, "model_dump"):
        details = details.model_dump()
    if hit == 0 and isinstance(details, dict):
        hit = int(details.get("cached_tokens") or 0)
    if miss == 0 and hit > 0 and prompt_tokens > hit:
        miss = prompt_tokens - hit

    completion_details = raw.get("completion_tokens_details") or {}
    if hasattr(completion_details, "model_dump"):
        completion_details = completion_details.model_dump()
    reasoning = 0
    if isinstance(completion_details, dict):
        reasoning = int(completion_details.get("reasoning_tokens") or 0)

    return Usage(
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=total_tokens,
        cache_hit_tokens=hit,
        cache_miss_tokens=miss,
        reasoning_tokens=reasoning,
    )


class UsageTracker:
    """Accumulates usage and renders Reasonix-style status lines."""

    def __init__(self) -> None:
        self.request_count = 0
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.total_tokens = 0
        self.cache_hit_tokens = 0
        self.cache_miss_tokens = 0
        self.total_cost = 0.0
        self.currency = ""

    def record(self, usage: Usage, pricing: Pricing | None = None) -> None:
        if usage.total_tokens == 0:
            return
        self.request_count += 1
        self.prompt_tokens += usage.prompt_tokens
        self.completion_tokens += usage.completion_tokens
        self.total_tokens += usage.total_tokens
        self.cache_hit_tokens += usage.cache_hit_tokens
        miss = usage.cache_miss_tokens
        if miss == 0 and usage.prompt_tokens > usage.cache_hit_tokens:
            miss = usage.prompt_tokens - usage.cache_hit_tokens
        self.cache_miss_tokens += miss
        if pricing is not None:
            self.total_cost += pricing.cost(usage)
            self.currency = pricing.currency

    def format_turn_line(self, usage: Usage, pricing: Pricing | None = None) -> str:
        hit = usage.cache_hit_tokens
        miss = usage.cache_miss_tokens
        if miss == 0 and usage.prompt_tokens > hit:
            miss = usage.prompt_tokens - hit
        turn_rate = _percent(hit, hit + miss)

        session_hit = self.cache_hit_tokens + hit
        session_miss = self.cache_miss_tokens + miss
        session_total = self.total_tokens + usage.total_tokens
        avg_rate = _percent(session_hit, session_hit + session_miss)

        parts = [
            f"本次缓存命中 {turn_rate}",
            f"平均缓存命中 {avg_rate}",
            f"会话 tokens {session_total:,}",
            f"本次 tokens {usage.total_tokens:,}",
        ]
        if pricing is not None:
            parts.append(f"本次费用 {pricing.currency}{pricing.cost(usage):.4f}")
        return " | ".join(parts)

    def format_summary(self, pricing: Pricing | None = None) -> str:
        avg_rate = _percent(self.cache_hit_tokens, self.cache_hit_tokens + self.cache_miss_tokens)
        parts = [
            f"请求数 {self.request_count}",
            f"平均缓存命中 {avg_rate}",
            f"会话 tokens {self.total_tokens:,}",
            f"缓存 {self.cache_hit_tokens:,} hit / {self.cache_miss_tokens:,} miss",
        ]
        if pricing is not None:
            parts.append(f"会话费用 {pricing.currency}{self.total_cost:.4f}")
        return " | ".join(parts)

    def to_metrics(self) -> dict:
        return {
            "request_count": self.request_count,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.total_tokens,
            "cache_hit_tokens": self.cache_hit_tokens,
            "cache_miss_tokens": self.cache_miss_tokens,
            "cost": self.total_cost,
            "currency": self.currency,
        }


def _percent(part: int, total: int) -> str:
    if total <= 0:
        return "0.00%"
    return f"{part * 100 / total:.2f}%"
