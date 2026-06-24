"""Tests for Reasonix-compatible local file tools."""

import json

import pytest

from novel_extractor.reasonix_compat.file_tools import WorkspaceTools
from novel_extractor.reasonix_compat.tool_budget import ToolOutputBudget
from novel_extractor.reasonix_compat.tooling import ToolExecutionLedger


def test_workspace_tools_read_file_paginates_with_line_numbers(tmp_path):
    workspace = tmp_path
    (workspace / "章节.md").write_text("第一行\n第二行\n第三行\n", encoding="utf-8")
    ledger = ToolExecutionLedger(workspace)
    registry = WorkspaceTools(workspace, ledger).registry(["read_file"])

    output = registry.execute("read_file", {"path": "章节.md", "offset": 1, "limit": 1})

    assert "   2→第二行" in output
    assert "total lines: 3" in output
    assert ledger.queried_files == {"章节.md"}


def test_workspace_tools_read_file_uses_configured_default_limit(tmp_path):
    workspace = tmp_path
    (workspace / "章节.md").write_text("第一行\n第二行\n第三行\n", encoding="utf-8")
    ledger = ToolExecutionLedger(workspace)
    budget = ToolOutputBudget(read_file_default_limit=1)
    registry = WorkspaceTools(workspace, ledger, budget).registry(["read_file"])

    output = registry.execute("read_file", {"path": "章节.md"})

    assert "   1→第一行" in output
    assert "   2→第二行" not in output
    assert "next offset: 1" in output


def test_workspace_tools_grep_searches_chinese_text_and_records_query(tmp_path):
    workspace = tmp_path
    (workspace / "丹药分析.md").write_text("# 丹药分析\n\n## 抽髓丸\n证据章节：第 20 章\n", encoding="utf-8")
    ledger = ToolExecutionLedger(workspace)
    registry = WorkspaceTools(workspace, ledger).registry(["grep"])

    output = registry.execute("grep", {"path": ".", "pattern": "抽髓丸"})

    assert "丹药分析.md:3:## 抽髓丸" in output
    assert "丹药分析.md" in ledger.queried_files


def test_workspace_tools_grep_uses_configured_match_limit(tmp_path):
    workspace = tmp_path
    for index in range(3):
        (workspace / f"文档{index}.md").write_text("抽髓丸\n", encoding="utf-8")
    ledger = ToolExecutionLedger(workspace)
    budget = ToolOutputBudget(grep_max_matches=1)
    registry = WorkspaceTools(workspace, ledger, budget).registry(["grep"])

    output = registry.execute("grep", {"path": ".", "pattern": "抽髓丸"})

    assert output.count("抽髓丸") == 1
    assert "... (truncated at 1 matches)" in output


def test_workspace_tools_write_file_is_confined_to_workspace(tmp_path):
    ledger = ToolExecutionLedger(tmp_path)
    registry = WorkspaceTools(tmp_path, ledger).registry(["write_file"])

    with pytest.raises(ValueError, match="outside workspace"):
        registry.execute("write_file", {"path": "../escape.md", "content": "# bad"})


def test_workspace_tools_write_file_records_write_after_prior_query(tmp_path):
    workspace = tmp_path
    (workspace / "丹药分析.md").write_text("# 丹药分析\n", encoding="utf-8")
    ledger = ToolExecutionLedger(workspace)
    registry = WorkspaceTools(workspace, ledger).registry(["read_file", "write_file"])

    registry.execute("read_file", {"path": "丹药分析.md"})
    registry.execute(
        "write_file",
        {"path": "丹药分析.md", "content": "# 丹药分析\n\n## 抽髓丸\n证据章节：第 1 章\n"},
    )

    assert ledger.was_queried_before_write("丹药分析.md")
    assert ledger.written_files == {"丹药分析.md"}


def test_registry_exports_openai_tool_schema():
    ledger = ToolExecutionLedger()
    registry = WorkspaceTools(None, ledger).registry(["read_file"])

    schemas = registry.openai_tools()

    assert schemas == [
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": registry.get("read_file").description,
                "parameters": json.loads(registry.get("read_file").schema),
            },
        }
    ]


def test_registry_respects_explicit_empty_enabled_tool_list(tmp_path):
    ledger = ToolExecutionLedger(tmp_path)
    registry = WorkspaceTools(tmp_path, ledger).registry([])

    assert registry.openai_tools() == []


def test_registry_rejects_unknown_enabled_tool_name(tmp_path):
    ledger = ToolExecutionLedger(tmp_path)

    with pytest.raises(ValueError, match="unknown enabled tool"):
        WorkspaceTools(tmp_path, ledger).registry(["readfile"])
