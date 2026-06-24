"""Capture and compare cache-relevant prompt shape."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any


_CJK_RE = re.compile(
    "[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff"
    "\U00020000-\U0002ceaf\U0002f800-\U0002fa1f]"
)


@dataclass(frozen=True)
class PrefixShape:
    system_hash: str
    tools_hash: str
    prefix_hash: str
    rewrite_version: int
    tool_schema_tokens: int


@dataclass(frozen=True)
class CacheDiagnostics:
    prefix_hash: str
    prefix_changed: bool
    prefix_change_reasons: list[str]
    system_hash: str
    tools_hash: str
    rewrite_version: int
    tool_schema_tokens: int
    cache_hit_tokens: int
    cache_miss_tokens: int


def capture_shape(system_prompt: str, tools: list[dict[str, Any]], rewrite_version: int) -> PrefixShape:
    normalized_system = _canonical_json(system_prompt)
    normalized_tools = _canonical_json(_normalize_tools(tools))
    system_hash = _hash_json(normalized_system)
    tools_hash = _hash_json(normalized_tools)
    prefix_hash = _hash_json(
        json.dumps(
            {
                "system_hash": system_hash,
                "tools_hash": tools_hash,
                "rewrite_version": rewrite_version,
            },
            sort_keys=True,
            ensure_ascii=False,
        )
    )
    return PrefixShape(
        system_hash=system_hash,
        tools_hash=tools_hash,
        prefix_hash=prefix_hash,
        rewrite_version=rewrite_version,
        tool_schema_tokens=_estimate_tokens(normalized_tools),
    )


def compare_shape(
    previous: PrefixShape,
    current: PrefixShape,
    cache_hit_tokens: int,
    cache_miss_tokens: int,
) -> CacheDiagnostics:
    reasons: list[str] = []
    if previous.system_hash != current.system_hash:
        reasons.append("system")
    if previous.tools_hash != current.tools_hash:
        reasons.append("tools")
    if previous.rewrite_version != current.rewrite_version:
        reasons.append("rewrite_version")

    return CacheDiagnostics(
        prefix_hash=current.prefix_hash,
        prefix_changed=bool(reasons),
        prefix_change_reasons=reasons,
        system_hash=current.system_hash,
        tools_hash=current.tools_hash,
        rewrite_version=current.rewrite_version,
        tool_schema_tokens=current.tool_schema_tokens,
        cache_hit_tokens=cache_hit_tokens,
        cache_miss_tokens=cache_miss_tokens,
    )


def _normalize_tools(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for tool in tools:
        normalized_tool = dict(tool)
        function = normalized_tool.get("function")
        if isinstance(function, dict):
            normalized_tool["function"] = dict(function)
        normalized.append(normalized_tool)
    return sorted(
        normalized,
        key=lambda item: (
            (item.get("function") or {}).get("name") or "",
            (item.get("function") or {}).get("description") or "",
            _canonical_json((item.get("function") or {}).get("parameters") or {}),
            _canonical_json(item),
        ),
    )


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


def _hash_json(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _estimate_tokens(text: str) -> int:
    approx = len(text) // 4
    cjk = len(_CJK_RE.findall(text))
    return max(approx, cjk)
