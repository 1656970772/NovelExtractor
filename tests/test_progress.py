"""Tests for console progress output."""

from io import StringIO

from novel_extractor.progress import ConsoleProgressReporter


def test_console_progress_explains_group_ids_with_labels():
    stream = StringIO()
    reporter = ConsoleProgressReporter(
        stream=stream,
        group_labels={"npc_group": "NPC性格与代表事件"},
    )

    reporter.routed_groups(["npc_group"])
    reporter.group_running("npc_group", ["NPC性格与代表事件.md"])

    text = stream.getvalue()
    assert "路由命中模板组：npc_group（NPC性格与代表事件）" in text
    assert "模板组 [npc_group] NPC性格与代表事件：处理中" in text
    assert "输出文件：NPC性格与代表事件.md" in text


def test_console_activity_prints_start_and_finish_for_non_tty_stream():
    stream = StringIO()
    reporter = ConsoleProgressReporter(stream=stream)

    with reporter.activity("模型处理中：npc_group"):
        pass

    text = stream.getvalue()
    assert "模型处理中：npc_group" in text
    assert "模型响应完成" in text
