"""Verifier for written files."""

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class VerificationResult:
    ok: bool
    reason: str


def verify_written_file(path: Path) -> VerificationResult:
    """Verify that a written file is valid."""
    if not path.exists():
        return VerificationResult(ok=False, reason="文件不存在")

    try:
        content = path.read_text(encoding="utf-8")
    except Exception as e:
        return VerificationResult(ok=False, reason=f"无法读取文件（UTF-8）: {e}")

    # Must contain at least one Markdown heading
    has_heading = False
    for line in content.split("\n"):
        if line.strip().startswith("#"):
            has_heading = True
            break

    if not has_heading:
        return VerificationResult(ok=False, reason="文件不包含 Markdown 标题")

    # Must not contain update envelope fields (indicating parsing failure)
    if "文件：" in content or "方式：" in content:
        return VerificationResult(ok=False, reason="文件包含更新块信封字段（可能是解析失败）")

    return VerificationResult(ok=True, reason="文件存在、UTF-8 可读、包含 Markdown 标题，且未残留更新块信封字段")
