"""Tests for progress ledger."""

from novel_extractor.ledger import ProgressLedger


def test_completed_window_group_is_skipped_when_hashes_match(tmp_path):
    db_path = tmp_path / "state.sqlite"
    ledger = ProgressLedger(db_path)

    ledger.mark_completed(
        novel_id="凡人修仙传",
        window_id="1-5",
        template_group_id="resource_group",
        chapter_hash="chapter-a",
        template_hash="template-a",
        output_hash="output-a",
    )

    assert ledger.should_skip(
        novel_id="凡人修仙传",
        window_id="1-5",
        template_group_id="resource_group",
        chapter_hash="chapter-a",
        template_hash="template-a",
    )


def test_hash_change_forces_rerun(tmp_path):
    db_path = tmp_path / "state.sqlite"
    ledger = ProgressLedger(db_path)

    ledger.mark_completed("凡人修仙传", "1-5", "resource_group", "chapter-a", "template-a", "output-a")

    assert not ledger.should_skip("凡人修仙传", "1-5", "resource_group", "chapter-b", "template-a")
    assert not ledger.should_skip("凡人修仙传", "1-5", "resource_group", "chapter-a", "template-b")


def test_running_state_is_not_skipped_after_restart(tmp_path):
    db_path = tmp_path / "state.sqlite"
    ledger = ProgressLedger(db_path)

    ledger.mark_running("凡人修仙传", "5-9", "npc_group", "chapter-b", "template-b")

    assert not ledger.should_skip("凡人修仙传", "5-9", "npc_group", "chapter-b", "template-b")
    assert ledger.get_status("凡人修仙传", "5-9", "npc_group") == "running"
