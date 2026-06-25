"""Per-run JSONL audit logging."""

from __future__ import annotations

import json
from dataclasses import asdict, is_dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


class RunLogger:
    """Writes one timestamped JSONL log for each CLI run."""

    def __init__(self, log_dir: Path, retention_files: int = 20) -> None:
        if retention_files < 1:
            raise ValueError("retention_files must be >= 1")
        self.log_dir = Path(log_dir)
        self.retention_files = retention_files
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self.path = self._new_log_path()
        self._file = self.path.open("a", encoding="utf-8")
        self.log("run_log_started", {"path": str(self.path)})
        self._prune_old_logs()

    def log(self, event: str, data: dict[str, Any]) -> None:
        record = {
            "timestamp": datetime.now().isoformat(timespec="seconds"),
            "event": event,
            "data": data,
        }
        json.dump(record, self._file, ensure_ascii=False, default=_json_default)
        self._file.write("\n")
        self._file.flush()

    def close(self) -> None:
        if not self._file.closed:
            self.log("run_log_closed", {"path": str(self.path)})
            self._file.close()

    def _new_log_path(self) -> Path:
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        base = self.log_dir / f"novel-extractor-{timestamp}.jsonl"
        if not base.exists():
            return base
        for index in range(1, 1000):
            candidate = self.log_dir / f"novel-extractor-{timestamp}-{index:03d}.jsonl"
            if not candidate.exists():
                return candidate
        raise RuntimeError("could not allocate a unique run log path")

    def _prune_old_logs(self) -> None:
        files = sorted(
            self.log_dir.glob("novel-extractor-*.jsonl"),
            key=lambda path: (path.stat().st_mtime, path.name),
        )
        for path in files[: -self.retention_files]:
            if path == self.path:
                continue
            path.unlink()


def _json_default(value: Any) -> Any:
    if isinstance(value, Path):
        return str(value)
    if is_dataclass(value):
        return asdict(value)
    return str(value)
