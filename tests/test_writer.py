"""Tests for writer and verifier."""

from novel_extractor.verifier import verify_written_file
from novel_extractor.writer import parse_doc_updates, apply_doc_updates


def test_parse_and_append_doc_update(tmp_path):
    response = """```doc-update
文件：丹药分析.md
方式：append
原因：发现抽髓丸。
内容：
## 抽髓丸

功效：短期提升力量。
证据章节：第 6 章
```"""

    updates = parse_doc_updates(response)
    apply_doc_updates(tmp_path, updates, backup_before_write=True)

    output = tmp_path / "丹药分析.md"
    assert output.exists()
    text = output.read_text(encoding="utf-8")
    assert "## 抽髓丸" in text
    assert "证据章节：第 6 章" in text
    assert verify_written_file(output).ok


def test_no_update_response_returns_empty_updates():
    assert parse_doc_updates("NO_UPDATE") == []
