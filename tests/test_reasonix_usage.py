"""Tests for Reasonix-compatible token/cache usage accounting."""

import pytest

from novel_extractor.progress import ConsoleProgressReporter
from novel_extractor.reasonix_compat.usage import DEFAULT_DEEPSEEK_PRICING, Pricing, Usage, UsageTracker, normalize_usage
from novel_extractor.reasonix_compat.usage import TokenBudgetExceeded


def test_normalize_usage_reads_deepseek_top_level_cache_fields():
    usage = normalize_usage(
        {
            "prompt_tokens": 1000,
            "completion_tokens": 50,
            "total_tokens": 1050,
            "prompt_cache_hit_tokens": 900,
            "prompt_cache_miss_tokens": 100,
        }
    )

    assert usage == Usage(
        prompt_tokens=1000,
        completion_tokens=50,
        total_tokens=1050,
        cache_hit_tokens=900,
        cache_miss_tokens=100,
        reasoning_tokens=0,
    )


def test_normalize_usage_reads_nested_cached_tokens_and_derives_miss():
    usage = normalize_usage(
        {
            "prompt_tokens": 1000,
            "completion_tokens": 50,
            "total_tokens": 1050,
            "prompt_tokens_details": {"cached_tokens": 600},
        }
    )

    assert usage.cache_hit_tokens == 600
    assert usage.cache_miss_tokens == 400


def test_usage_tracker_formats_reasonix_style_console_metrics():
    tracker = UsageTracker()
    pricing = Pricing(cache_hit=0.02, input=1.0, output=2.0, currency="¥")
    first = Usage(prompt_tokens=1000, completion_tokens=100, total_tokens=1100, cache_hit_tokens=800, cache_miss_tokens=200)
    second = Usage(prompt_tokens=1000, completion_tokens=50, total_tokens=1050, cache_hit_tokens=900, cache_miss_tokens=100)

    tracker.record(first)
    line = tracker.format_turn_line(second, pricing)

    assert "本次缓存命中 90.00%" in line
    assert "平均缓存命中 85.00%" in line
    assert "会话 tokens 2,150" in line
    assert "本次 tokens 1,050" in line
    assert "本次费用 ¥0.0002" in line


def test_usage_tracker_exports_metrics_dict():
    tracker = UsageTracker()
    tracker.record(
        Usage(prompt_tokens=100, completion_tokens=20, total_tokens=120, cache_hit_tokens=80, cache_miss_tokens=20),
        DEFAULT_DEEPSEEK_PRICING,
    )

    metrics = tracker.to_metrics()

    assert metrics["prompt_tokens"] == 100
    assert metrics["cache_hit_tokens"] == 80
    assert metrics["cost"] > 0


def test_pricing_treats_prompt_tokens_without_cache_fields_as_input_miss():
    pricing = Pricing(cache_hit=0.02, input=1.0, output=2.0, currency="¥")
    usage = Usage(prompt_tokens=100, completion_tokens=20, total_tokens=120)

    assert pricing.cost(usage) == (100 * 1.0 + 20 * 2.0) / 1_000_000


def test_console_reporter_enforces_run_token_budget():
    reporter = ConsoleProgressReporter(enabled=False, run_token_budget=100)

    with pytest.raises(TokenBudgetExceeded, match="run token budget exceeded"):
        reporter.model_usage(Usage(prompt_tokens=90, completion_tokens=20, total_tokens=110))
