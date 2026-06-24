from novel_extractor.doc_index import find_relevant_snippets


def test_find_relevant_snippets_limits_per_file_chars(tmp_path):
    doc = tmp_path / "丹药分析.md"
    doc.write_text("# 抽髓丸\n" + "甲" * 5000 + "\n# 清灵散\n乙", encoding="utf-8")

    snippets = find_relevant_snippets(tmp_path, ["丹药分析.md"], query_text="抽髓丸", max_chars=200)

    assert "抽髓丸" in snippets["丹药分析.md"]
    assert len(snippets["丹药分析.md"]) <= 220


def test_find_relevant_snippets_finds_nested_entity_heading(tmp_path):
    doc = tmp_path / "丹药分析.md"
    doc.write_text(
        "# 丹药分析\n\n## 抽髓丸\n证据章节：第 1 章\n\n## 清灵散\n乙",
        encoding="utf-8",
    )

    snippets = find_relevant_snippets(
        tmp_path,
        ["丹药分析.md"],
        query_text="韩立发现抽髓丸这种丹药",
        max_chars=200,
    )

    assert "## 抽髓丸" in snippets["丹药分析.md"]
    assert "清灵散" not in snippets["丹药分析.md"]
