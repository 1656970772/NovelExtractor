"""Tests for prompt building."""

from novel_extractor.chapters import Chapter
from novel_extractor.prompts import build_extraction_prompt


def test_prompt_contains_context_and_commit_chapter_ranges():
    prompt = build_extraction_prompt(
        novel_id="凡人修仙传",
        window_id="5-9",
        context_chapters=[Chapter(5, "第5章", "旧上下文"), Chapter(6, "第6章", "新内容")],
        commit_chapters=[Chapter(6, "第6章", "新内容")],
        template_texts={"丹药分析.md": "# 丹药分析模板\n字段"},
        existing_snippets={"丹药分析.md:抽髓丸": "## 抽髓丸\n已有内容"},
    )

    assert "窗口：5-9" in prompt
    assert "上下文章节：5, 6" in prompt
    assert "本轮默认提交章节：6" in prompt
    assert "不要输出业务 JSON" in prompt
    assert "使用 grep 或 read_file 查询目标文档" in prompt
    assert "使用 write_file、edit_file 或 multi_edit 直接写入 Markdown 文档" in prompt
    assert "```doc-update" not in prompt
