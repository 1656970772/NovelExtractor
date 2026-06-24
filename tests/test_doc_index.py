"""Tests for document index."""

from novel_extractor.doc_index import DocumentIndex


def test_search_existing_doc_returns_matching_heading_snippet(tmp_path):
    output = tmp_path / "丹药分析.md"
    output.write_text(
        """# 《凡人修仙传》丹药分析

## 抽髓丸

功效：短期提升力量。
副作用：原文未说明。

## 药汤

功效：辅助修炼。
""",
        encoding="utf-8",
    )

    index = DocumentIndex(tmp_path)

    result = index.search("丹药分析.md", "抽髓丸")

    assert result.found
    assert result.filename == "丹药分析.md"
    assert "## 抽髓丸" in result.snippet
    assert "短期提升力量" in result.snippet
    assert "## 药汤" not in result.snippet


def test_search_missing_doc_returns_not_found(tmp_path):
    index = DocumentIndex(tmp_path)

    result = index.search("丹药分析.md", "抽髓丸")

    assert not result.found
    assert result.snippet == ""
