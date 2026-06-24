"""Reasonix-compatible local file tools."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from novel_extractor.reasonix_compat.tool_budget import ToolOutputBudget
from novel_extractor.reasonix_compat.tooling import ToolExecutionLedger, ToolRegistry


@dataclass
class _WorkspaceTool:
    workspace: Path | None
    ledger: ToolExecutionLedger
    budget: ToolOutputBudget

    def _resolve(self, path: str, *, confine: bool = True) -> Path:
        if not path:
            raise ValueError("path is required")
        raw = Path(path)
        if self.workspace is None:
            return raw.resolve()
        resolved = raw.resolve() if raw.is_absolute() else (self.workspace / raw).resolve()
        if confine:
            try:
                resolved.relative_to(self.workspace)
            except ValueError as exc:
                raise ValueError(f"path is outside workspace: {path}") from exc
        return resolved

    def _rel(self, path: Path) -> str:
        if self.workspace is None:
            return path.as_posix()
        try:
            return path.resolve().relative_to(self.workspace).as_posix()
        except ValueError:
            return path.name


class ReadFileTool(_WorkspaceTool):
    name = "read_file"
    description = (
        "Read a text file with optional line offset/limit. Output prefixes each line with its 1-based number "
        "and includes total line count for pagination."
    )
    schema = json.dumps(
        {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path"},
                "offset": {"type": "integer", "minimum": 0, "description": "0-based line offset"},
                "limit": {"type": "integer", "minimum": 1, "description": "Maximum lines to return"},
            },
            "required": ["path"],
        }
    )
    read_only = True

    def execute(self, args: dict[str, Any]) -> str:
        path = self._resolve(str(args.get("path", "")))
        if path.is_dir():
            raise ValueError(f"{self._rel(path)} is a directory, use ls")
        offset = max(int(args.get("offset") or 0), 0)
        limit = int(args.get("limit") or self.budget.read_file_default_limit)
        if limit <= 0:
            limit = self.budget.read_file_default_limit
        text = path.read_text(encoding="utf-8-sig")
        lines = text.splitlines()
        selected = lines[offset : offset + limit]
        body = [f"{offset + idx + 1:4}→{line}" for idx, line in enumerate(selected)]
        body.append(f"... total lines: {len(lines)}")
        if offset + limit < len(lines):
            body.append(f"... next offset: {offset + limit}")
        self.ledger.record_query(self.name, path)
        return "\n".join(body)


class WriteFileTool(_WorkspaceTool):
    name = "write_file"
    description = "Write content to a file at the given path, overwriting existing content. Creates parents as needed."
    schema = json.dumps(
        {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path"},
                "content": {"type": "string", "description": "Full content to write"},
            },
            "required": ["path", "content"],
        }
    )
    read_only = False

    def execute(self, args: dict[str, Any]) -> str:
        path = self._resolve(str(args.get("path", "")))
        content = str(args.get("content", ""))
        path.parent.mkdir(parents=True, exist_ok=True)
        old = path.read_text(encoding="utf-8") if path.exists() else None
        if old == content:
            return f"{self._rel(path)} already contains the exact content; no changes made"
        path.write_text(content, encoding="utf-8")
        self.ledger.record_write(self.name, path, content)
        return f"wrote {len(content.encode('utf-8'))} bytes to {self._rel(path)}"


class EditFileTool(_WorkspaceTool):
    name = "edit_file"
    description = "Replace text in a file using old_string/new_string. Fails when old_string is absent."
    schema = json.dumps(
        {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "old_string": {"type": "string"},
                "new_string": {"type": "string"},
                "replace_all": {"type": "boolean"},
            },
            "required": ["path", "old_string", "new_string"],
        }
    )
    read_only = False

    def execute(self, args: dict[str, Any]) -> str:
        path = self._resolve(str(args.get("path", "")))
        old_string = str(args.get("old_string", ""))
        new_string = str(args.get("new_string", ""))
        replace_all = bool(args.get("replace_all", False))
        text = path.read_text(encoding="utf-8")
        if old_string not in text:
            raise ValueError(f"old_string not found in {self._rel(path)}")
        count = -1 if replace_all else 1
        updated = text.replace(old_string, new_string, count)
        path.write_text(updated, encoding="utf-8")
        self.ledger.record_write(self.name, path, new_string)
        return f"edited {self._rel(path)}"


class MultiEditTool(_WorkspaceTool):
    name = "multi_edit"
    description = "Apply multiple old_string/new_string replacements to one file in order."
    schema = json.dumps(
        {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "edits": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "old_string": {"type": "string"},
                            "new_string": {"type": "string"},
                            "replace_all": {"type": "boolean"},
                        },
                        "required": ["old_string", "new_string"],
                    },
                },
            },
            "required": ["path", "edits"],
        }
    )
    read_only = False

    def execute(self, args: dict[str, Any]) -> str:
        path = self._resolve(str(args.get("path", "")))
        text = path.read_text(encoding="utf-8")
        written_parts = []
        for edit in args.get("edits", []):
            old_string = str(edit.get("old_string", ""))
            new_string = str(edit.get("new_string", ""))
            replace_all = bool(edit.get("replace_all", False))
            if old_string not in text:
                raise ValueError(f"old_string not found in {self._rel(path)}")
            text = text.replace(old_string, new_string, -1 if replace_all else 1)
            written_parts.append(new_string)
        path.write_text(text, encoding="utf-8")
        self.ledger.record_write(self.name, path, "\n".join(written_parts))
        return f"applied {len(written_parts)} edits to {self._rel(path)}"


class GrepTool(_WorkspaceTool):
    name = "grep"
    description = "Search for a regular expression in a file or recursively under a directory. Returns path:line:text."
    schema = json.dumps(
        {
            "type": "object",
            "properties": {
                "pattern": {"type": "string"},
                "path": {"type": "string"},
            },
            "required": ["pattern", "path"],
        }
    )
    read_only = True

    def execute(self, args: dict[str, Any]) -> str:
        pattern = str(args.get("pattern", ""))
        if not pattern:
            raise ValueError("pattern is required")
        root = self._resolve(str(args.get("path", ".")))
        regex = re.compile(pattern)
        matches = []
        for file_path in _iter_text_files(root):
            try:
                lines = file_path.read_text(encoding="utf-8-sig").splitlines()
            except UnicodeDecodeError:
                continue
            for line_no, line in enumerate(lines, 1):
                if regex.search(line):
                    matches.append(f"{self._rel(file_path)}:{line_no}:{line}")
                    self.ledger.record_query(self.name, file_path)
                    break
            if len(matches) >= self.budget.grep_max_matches:
                matches.append(f"... (truncated at {self.budget.grep_max_matches} matches)")
                break
        return "\n".join(matches)


class GlobTool(_WorkspaceTool):
    name = "glob"
    description = "Find files matching a glob pattern under the workspace."
    schema = json.dumps(
        {
            "type": "object",
            "properties": {"pattern": {"type": "string"}},
            "required": ["pattern"],
        }
    )
    read_only = True

    def execute(self, args: dict[str, Any]) -> str:
        pattern = str(args.get("pattern", ""))
        if not pattern:
            raise ValueError("pattern is required")
        base = self.workspace or Path.cwd()
        matches = sorted(base.glob(pattern))
        selected = [self._rel(path) for path in matches[: self.budget.glob_max_matches]]
        if len(matches) > self.budget.glob_max_matches:
            selected.append(f"... (truncated at {self.budget.glob_max_matches} matches)")
        return "\n".join(selected)


class LsTool(_WorkspaceTool):
    name = "ls"
    description = "List files and directories in a directory."
    schema = json.dumps(
        {
            "type": "object",
            "properties": {"path": {"type": "string"}},
        }
    )
    read_only = True

    def execute(self, args: dict[str, Any]) -> str:
        path = self._resolve(str(args.get("path", ".")))
        if not path.is_dir():
            raise ValueError(f"{self._rel(path)} is not a directory")
        entries = sorted(path.iterdir(), key=lambda p: p.name)
        return "\n".join(self._rel(entry) + ("/" if entry.is_dir() else "") for entry in entries)


class WorkspaceTools:
    """Factory for workspace-confined Reasonix-compatible tools."""

    def __init__(self, workspace: Path | None, ledger: ToolExecutionLedger, tool_outputs_config=None) -> None:
        self.workspace = Path(workspace).resolve() if workspace is not None else None
        self.ledger = ledger
        self.budget = ToolOutputBudget.from_config(tool_outputs_config)

    def registry(self, enabled: Iterable[str] | None = None) -> ToolRegistry:
        default_tools = ["grep", "read_file", "write_file", "edit_file", "multi_edit", "glob", "ls"]
        enabled_set = set(default_tools if enabled is None else enabled)
        all_tools = {
            "read_file": ReadFileTool(self.workspace, self.ledger, self.budget),
            "write_file": WriteFileTool(self.workspace, self.ledger, self.budget),
            "edit_file": EditFileTool(self.workspace, self.ledger, self.budget),
            "multi_edit": MultiEditTool(self.workspace, self.ledger, self.budget),
            "grep": GrepTool(self.workspace, self.ledger, self.budget),
            "glob": GlobTool(self.workspace, self.ledger, self.budget),
            "ls": LsTool(self.workspace, self.ledger, self.budget),
        }
        unknown_tools = sorted(enabled_set - set(all_tools))
        if unknown_tools:
            raise ValueError(f"unknown enabled tool(s): {', '.join(unknown_tools)}")
        registry = ToolRegistry(self.budget)
        for name, tool in all_tools.items():
            if name in enabled_set:
                registry.add(tool)
        return registry


def _iter_text_files(root: Path) -> Iterable[Path]:
    if root.is_file():
        yield root
        return
    if not root.exists():
        return
    for path in root.rglob("*"):
        if path.is_file() and path.suffix.lower() in {"", ".md", ".txt"}:
            yield path
