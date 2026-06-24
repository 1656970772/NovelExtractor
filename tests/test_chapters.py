"""Tests for chapter parsing and window generation."""

from novel_extractor.chapters import Chapter, build_windows, parse_chapters


def test_parse_chapters_by_title_pattern():
    text = """第1章 七玄门
韩立来到山下。
第2章 入门
墨大夫出现。
第3章 药园
韩立开始照看药草。
"""

    chapters = parse_chapters(text, r"^第[一二三四五六七八九十百千万零〇两\d]+章")

    assert [chapter.number for chapter in chapters] == [1, 2, 3]
    assert chapters[0].title == "第1章 七玄门"
    assert "韩立来到山下" in chapters[0].body


def test_build_windows_uses_size_five_stride_four_and_excludes_overlap():
    chapters = [Chapter(number=i, title=f"第{i}章", body=f"正文{i}") for i in range(1, 14)]

    windows = build_windows(chapters, size=5, stride=4, max_windows=3)

    assert [(w.start, w.end) for w in windows] == [(1, 5), (5, 9), (9, 13)]
    assert [chapter.number for chapter in windows[0].context_chapters] == [1, 2, 3, 4, 5]
    assert [chapter.number for chapter in windows[0].commit_chapters] == [1, 2, 3, 4, 5]
    assert [chapter.number for chapter in windows[1].context_chapters] == [5, 6, 7, 8, 9]
    assert [chapter.number for chapter in windows[1].commit_chapters] == [6, 7, 8, 9]
    assert [chapter.number for chapter in windows[2].commit_chapters] == [10, 11, 12, 13]


def test_build_windows_allows_unlimited_when_max_windows_is_none():
    chapters = [Chapter(number=i, title=f"第{i}章", body=f"正文{i}") for i in range(1, 20)]

    windows = build_windows(chapters, size=5, stride=4, max_windows=None)

    assert [(w.start, w.end) for w in windows] == [(1, 5), (5, 9), (9, 13), (13, 17), (17, 19)]
