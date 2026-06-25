"""Tests for per-run audit logging."""

import json
import os

from novel_extractor.run_log import RunLogger


def _read_events(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def test_run_logger_writes_jsonl_events_and_retains_latest_files(tmp_path):
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    for index in range(25):
        path = log_dir / f"novel-extractor-20260101-0000{index:02d}.jsonl"
        path.write_text("{}\n", encoding="utf-8")
        os.utime(path, (index, index))

    logger = RunLogger(log_dir, retention_files=20)
    try:
        logger.log("custom_event", {"中文": "内容"})
        current_path = logger.path
    finally:
        logger.close()

    files = sorted(log_dir.glob("novel-extractor-*.jsonl"))
    assert len(files) == 20
    assert current_path in files
    assert log_dir / "novel-extractor-20260101-000000.jsonl" not in files

    events = _read_events(current_path)
    assert events[0]["event"] == "run_log_started"
    assert events[1]["event"] == "custom_event"
    assert events[1]["data"] == {"中文": "内容"}
