"""Reasonix-compatible tool abstractions."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Protocol

from novel_extractor.reasonix_compat.tool_budget import ToolOutputBudget
from novel_extractor.reasonix_compat.usage import Usage


class Tool(Protocol):
    name: str
    description: str
    schema: str
    read_only: bool

    def execute(self, args: dict[str, Any]) -> str:
        raise NotImplementedError


@dataclass(frozen=True)
class ToolLoopResult:
    final_text: str
    usage_events: list[Usage] = field(default_factory=list)


@dataclass(frozen=True)
class ToolEvent:
    index: int
    tool_name: str
    filename: str
    kind: str
    content: str = ""
    success: bool = True


class ToolExecutionLedger:
    """Records file queries and writes within one model/tool loop."""

    def __init__(self, workspace: Path | None = None) -> None:
        self.workspace = Path(workspace).resolve() if workspace is not None else None
        self.events: list[ToolEvent] = []
        self.queried_files: set[str] = set()
        self.written_files: set[str] = set()
        self.write_contents: dict[str, list[str]] = {}

    def record_query(self, tool_name: str, path: str | Path, success: bool = True) -> None:
        filename = self._normalize(path)
        self.queried_files.add(filename)
        self.events.append(ToolEvent(len(self.events), tool_name, filename, "query", success=success))

    def record_write(self, tool_name: str, path: str | Path, content: str, success: bool = True) -> None:
        filename = self._normalize(path)
        self.written_files.add(filename)
        self.write_contents.setdefault(filename, []).append(content)
        self.events.append(ToolEvent(len(self.events), tool_name, filename, "write", content=content, success=success))

    def was_queried_before_write(self, filename: str) -> bool:
        normalized = self._normalize(filename)
        first_write = None
        for event in self.events:
            if event.filename == normalized and event.kind == "write":
                first_write = event.index
                break
        if first_write is None:
            return False
        return any(
            event.filename == normalized and event.kind == "query" and event.index < first_write
            for event in self.events
        )

    def _normalize(self, path: str | Path) -> str:
        p = Path(path)
        if self.workspace is not None:
            try:
                absolute = p.resolve() if p.is_absolute() else (self.workspace / p).resolve()
                return absolute.relative_to(self.workspace).as_posix()
            except ValueError:
                return p.name
        return p.as_posix()


class ToolRegistry:
    """Per-run tool registry, mirroring Reasonix's registry role."""

    def __init__(self, output_budget: ToolOutputBudget | None = None) -> None:
        self._tools: dict[str, Tool] = {}
        self._order: list[str] = []
        self.output_budget = output_budget
        self._event_callback: Callable[[str, dict[str, Any], str, bool], None] | None = None

    def add(self, tool: Tool) -> None:
        if tool.name not in self._tools:
            self._order.append(tool.name)
        self._tools[tool.name] = tool

    def get(self, name: str) -> Tool:
        try:
            return self._tools[name]
        except KeyError as exc:
            raise ValueError(f"unknown tool: {name}") from exc

    def execute(self, name: str, args: dict[str, Any] | str | bytes) -> str:
        if isinstance(args, (str, bytes)):
            parsed = json.loads(args)
        else:
            parsed = args
        try:
            result = self.get(name).execute(parsed)
            if self.output_budget is not None:
                result = self.output_budget.apply(name, result)
        except Exception as exc:
            if self._event_callback is not None:
                self._event_callback(name, parsed, f"error: {exc}", False)
            raise
        if self._event_callback is not None:
            self._event_callback(name, parsed, result, True)
        return result

    def openai_tools(self) -> list[dict[str, Any]]:
        tools = []
        # Keep the exported schema order stable so cache shape stays deterministic.
        for name in sorted(self._order):
            tool = self._tools[name]
            tools.append(
                {
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": json.loads(tool.schema),
                    },
                }
            )
        return tools

    def names(self) -> list[str]:
        return list(self._order)

    def set_event_callback(self, callback: Callable[[str, dict[str, Any], str, bool], None]) -> None:
        self._event_callback = callback
