"""Tool registry factory for Reasonix-compatible built-in tools."""

from __future__ import annotations

from pathlib import Path
from typing import Iterable

from novel_extractor.reasonix_compat.builtin_tools import BUILTIN_TOOLS
from novel_extractor.reasonix_compat.tool_budget import ToolOutputBudget
from novel_extractor.reasonix_compat.tooling import ToolExecutionLedger, ToolRegistry


def create_tool_registry(
    workspace: Path | None = None,
    ledger: ToolExecutionLedger | None = None,
    budget: ToolOutputBudget | None = None,
    enabled: Iterable[str] | None = None,
) -> ToolRegistry:
    """Create a ToolRegistry with built-in tools.

    Args:
        workspace: Optional workspace path for path resolution and confinement
        ledger: Optional execution ledger for tracking tool usage
        budget: Optional output budget for limiting tool results
        enabled: Optional list of tool names to enable (default: all built-in tools)

    Returns:
        Configured ToolRegistry instance
    """
    if ledger is None:
        ledger = ToolExecutionLedger(workspace)

    if budget is None:
        budget = ToolOutputBudget()

    work_dir = str(workspace) if workspace else ""
    roots = [str(workspace)] if workspace else []

    # Default to all built-in tools if not specified
    default_tools = ["read_file", "write_file", "edit_file", "grep", "glob", "ls"]
    enabled_set = set(default_tools if enabled is None else enabled)

    # Check for unknown tools
    unknown = enabled_set - set(BUILTIN_TOOLS.keys())
    if unknown:
        raise ValueError(f"unknown enabled tool(s): {', '.join(sorted(unknown))}")

    registry = ToolRegistry(budget)

    # Instantiate and register enabled tools
    for tool_name in enabled_set:
        tool_class = BUILTIN_TOOLS[tool_name]

        # Instantiate with appropriate parameters
        if tool_name in {"write_file", "edit_file"}:
            tool = tool_class(roots=roots, work_dir=work_dir, ledger=ledger)
        elif tool_name == "grep":
            # Pass budget's grep_max_matches to grep tool
            tool = tool_class(work_dir=work_dir, ledger=ledger, max_matches=budget.grep_max_matches)
        elif tool_name == "read_file":
            # Pass budget to read_file tool
            tool = tool_class(work_dir=work_dir, ledger=ledger, _budget=budget)
        else:
            tool = tool_class(work_dir=work_dir, ledger=ledger)

        registry.add(tool)

    return registry


class WorkspaceTools:
    """Factory for workspace-confined Reasonix-compatible tools.

    This class provides a convenient interface for creating tool registries
    with workspace confinement, matching the original API.
    """

    def __init__(
        self,
        workspace: Path | None,
        ledger: ToolExecutionLedger,
        tool_outputs_config=None
    ) -> None:
        self.workspace = Path(workspace).resolve() if workspace is not None else None
        self.ledger = ledger
        self.budget = ToolOutputBudget.from_config(tool_outputs_config)

    def registry(self, enabled: Iterable[str] | None = None) -> ToolRegistry:
        """Create a tool registry with specified enabled tools."""
        return create_tool_registry(
            workspace=self.workspace,
            ledger=self.ledger,
            budget=self.budget,
            enabled=enabled,
        )
