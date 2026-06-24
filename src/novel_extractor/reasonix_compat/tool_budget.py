"""Tool output budgeting and stale-result elision."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ToolOutputBudget:
    read_file_default_limit: int = 800
    grep_max_matches: int = 80
    glob_max_matches: int = 200
    max_tool_result_chars: int = 12000
    elide_stale_results: bool = True
    min_elide_chars: int = 2048

    @classmethod
    def from_config(cls, config: Any | None) -> "ToolOutputBudget":
        if config is None:
            return cls()
        return cls(
            read_file_default_limit=getattr(config, "read_file_default_limit", cls.read_file_default_limit),
            grep_max_matches=getattr(config, "grep_max_matches", cls.grep_max_matches),
            glob_max_matches=getattr(config, "glob_max_matches", cls.glob_max_matches),
            max_tool_result_chars=getattr(config, "max_tool_result_chars", cls.max_tool_result_chars),
            elide_stale_results=getattr(config, "elide_stale_results", cls.elide_stale_results),
            min_elide_chars=getattr(config, "min_elide_chars", cls.min_elide_chars),
        )

    def apply(self, tool_name: str, result: str) -> str:
        if len(result) <= self.max_tool_result_chars:
            return result
        return (
            f"[truncated {tool_name} result: {len(result)} chars, "
            f"showing first {self.max_tool_result_chars}]\n"
            f"{result[: self.max_tool_result_chars]}"
        )


def elide_stale_tool_messages(
    messages: list[dict[str, Any]],
    *,
    min_elide_chars: int,
    recent_keep: int = 1,
) -> list[dict[str, Any]]:
    """Elide old large tool results while preserving recent tool context."""
    tool_indices = [index for index, message in enumerate(messages) if message.get("role") == "tool"]
    protected = set(tool_indices[-recent_keep:]) if recent_keep > 0 else set()
    result: list[dict[str, Any]] = []

    for index, message in enumerate(messages):
        content = message.get("content")
        if (
            index not in protected
            and message.get("role") == "tool"
            and isinstance(content, str)
            and len(content) >= min_elide_chars
        ):
            copied = dict(message)
            name = copied.get("name") or "tool"
            copied["content"] = f"[elided tool result: {name}, {len(content)} chars]"
            result.append(copied)
        else:
            result.append(dict(message))

    return result
