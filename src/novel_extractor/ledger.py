"""Progress ledger for tracking extraction state."""

import sqlite3
from datetime import datetime
from pathlib import Path


class ProgressLedger:
    """SQLite-based progress tracker for window-group extraction state."""

    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self._init_db()

    def _init_db(self) -> None:
        """Initialize database schema."""
        # Create parent directory if needed
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

        conn = sqlite3.connect(self.db_path)
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS template_runs (
                novel_id TEXT NOT NULL,
                window_id TEXT NOT NULL,
                template_group_id TEXT NOT NULL,
                chapter_hash TEXT NOT NULL,
                template_hash TEXT NOT NULL,
                output_hash TEXT,
                status TEXT NOT NULL,
                error TEXT,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (novel_id, window_id, template_group_id)
            )
            """
        )
        conn.commit()
        conn.close()

    def mark_running(
        self,
        novel_id: str,
        window_id: str,
        template_group_id: str,
        chapter_hash: str,
        template_hash: str,
    ) -> None:
        """Mark a window-group as currently running."""
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            """
            INSERT OR REPLACE INTO template_runs
            (novel_id, window_id, template_group_id, chapter_hash, template_hash,
             output_hash, status, error, updated_at)
            VALUES (?, ?, ?, ?, ?, NULL, 'running', NULL, ?)
            """,
            (novel_id, window_id, template_group_id, chapter_hash, template_hash, datetime.now().isoformat()),
        )
        conn.commit()
        conn.close()

    def mark_completed(
        self,
        novel_id: str,
        window_id: str,
        template_group_id: str,
        chapter_hash: str,
        template_hash: str,
        output_hash: str,
    ) -> None:
        """Mark a window-group as completed."""
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            """
            INSERT OR REPLACE INTO template_runs
            (novel_id, window_id, template_group_id, chapter_hash, template_hash,
             output_hash, status, error, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'completed', NULL, ?)
            """,
            (
                novel_id,
                window_id,
                template_group_id,
                chapter_hash,
                template_hash,
                output_hash,
                datetime.now().isoformat(),
            ),
        )
        conn.commit()
        conn.close()

    def mark_no_update(
        self,
        novel_id: str,
        window_id: str,
        template_group_id: str,
        chapter_hash: str,
        template_hash: str,
        output_hash: str = "no-update",
    ) -> None:
        """Mark a window-group as completed with no document changes."""
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            """
            INSERT OR REPLACE INTO template_runs
            (novel_id, window_id, template_group_id, chapter_hash, template_hash,
             output_hash, status, error, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'no-update', NULL, ?)
            """,
            (
                novel_id,
                window_id,
                template_group_id,
                chapter_hash,
                template_hash,
                output_hash,
                datetime.now().isoformat(),
            ),
        )
        conn.commit()
        conn.close()

    def mark_failed(
        self,
        novel_id: str,
        window_id: str,
        template_group_id: str,
        chapter_hash: str,
        template_hash: str,
        error: str,
    ) -> None:
        """Mark a window-group as failed."""
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            """
            INSERT OR REPLACE INTO template_runs
            (novel_id, window_id, template_group_id, chapter_hash, template_hash,
             output_hash, status, error, updated_at)
            VALUES (?, ?, ?, ?, ?, NULL, 'failed', ?, ?)
            """,
            (novel_id, window_id, template_group_id, chapter_hash, template_hash, error, datetime.now().isoformat()),
        )
        conn.commit()
        conn.close()

    def should_skip(
        self,
        novel_id: str,
        window_id: str,
        template_group_id: str,
        chapter_hash: str,
        template_hash: str,
    ) -> bool:
        """Check if a window-group should be skipped (completed with matching hashes)."""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.execute(
            """
            SELECT status, chapter_hash, template_hash
            FROM template_runs
            WHERE novel_id = ? AND window_id = ? AND template_group_id = ?
            """,
            (novel_id, window_id, template_group_id),
        )
        row = cursor.fetchone()
        conn.close()

        if row is None:
            return False

        status, stored_chapter_hash, stored_template_hash = row
        return status in {"completed", "no-update"} and chapter_hash == stored_chapter_hash and template_hash == stored_template_hash

    def get_status(self, novel_id: str, window_id: str, template_group_id: str) -> str | None:
        """Get current status for a window-group."""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.execute(
            """
            SELECT status
            FROM template_runs
            WHERE novel_id = ? AND window_id = ? AND template_group_id = ?
            """,
            (novel_id, window_id, template_group_id),
        )
        row = cursor.fetchone()
        conn.close()

        return row[0] if row else None

    def status_counts(self, novel_id: str) -> dict[str, int]:
        """Return status counts for a novel."""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.execute(
            """
            SELECT status, COUNT(*)
            FROM template_runs
            WHERE novel_id = ?
            GROUP BY status
            """,
            (novel_id,),
        )
        rows = cursor.fetchall()
        conn.close()
        return {status: count for status, count in rows}
