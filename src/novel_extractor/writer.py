"""Writer for Markdown doc updates."""

import re
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class DocUpdate:
    filename: str
    mode: str
    reason: str
    content: str


def parse_doc_updates(response: str) -> list[DocUpdate]:
    """Parse doc-update blocks from model response."""
    response = response.strip()

    if response == "NO_UPDATE":
        return []

    updates = []

    # Find all doc-update blocks
    pattern = r"```doc-update\s+(.*?)```"
    matches = re.findall(pattern, response, re.DOTALL)

    for match in matches:
        lines = match.strip().split("\n")
        filename = None
        mode = None
        reason = None
        content_lines = []
        in_content = False

        for line in lines:
            if line.startswith("文件："):
                filename = line.replace("文件：", "").strip()
            elif line.startswith("方式："):
                mode = line.replace("方式：", "").strip()
            elif line.startswith("原因："):
                reason = line.replace("原因：", "").strip()
            elif line.startswith("内容："):
                in_content = True
            elif in_content:
                content_lines.append(line)

        if not filename or not mode or not content_lines:
            continue

        # Validate filename
        if "/" in filename or "\\" in filename:
            raise ValueError(f"filename contains path separator: {filename}")
        if not filename.endswith(".md"):
            raise ValueError(f"filename must end with .md: {filename}")

        # Only support append mode in MVP
        if mode != "append":
            raise ValueError(f"only 'append' mode is supported, got: {mode}")

        content = "\n".join(content_lines)
        updates.append(DocUpdate(filename=filename, mode=mode, reason=reason, content=content))

    return updates


def apply_doc_updates(output_dir: Path, updates: list[DocUpdate], backup_before_write: bool) -> None:
    """Apply doc updates to files."""
    output_dir.mkdir(parents=True, exist_ok=True)

    for update in updates:
        file_path = output_dir / update.filename

        # Backup if requested and file exists
        if backup_before_write and file_path.exists():
            backup_path = output_dir / f"{update.filename}.bak"
            backup_path.write_text(file_path.read_text(encoding="utf-8"), encoding="utf-8")

        # Read existing content or start fresh
        if file_path.exists():
            existing = file_path.read_text(encoding="utf-8")
            # Append with two newlines separator
            new_content = existing + "\n\n" + update.content
        else:
            new_content = update.content

        # Write updated content
        file_path.write_text(new_content, encoding="utf-8")
