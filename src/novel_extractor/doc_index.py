"""Document index for searching existing snippets."""

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class SearchResult:
    found: bool
    filename: str
    query: str
    snippet: str


class DocumentIndex:
    """Index for searching existing document snippets."""

    def __init__(self, output_dir: Path) -> None:
        self.output_dir = output_dir

    def search(self, filename: str, query: str) -> SearchResult:
        """Search for a heading or text snippet in a document."""
        file_path = self.output_dir / filename

        if not file_path.exists():
            return SearchResult(found=False, filename=filename, query=query, snippet="")

        try:
            content = file_path.read_text(encoding="utf-8")
        except Exception:
            return SearchResult(found=False, filename=filename, query=query, snippet="")

        lines = content.split("\n")

        # First, try to find heading match
        for i, line in enumerate(lines):
            if line.startswith("#") and query in line:
                # Extract snippet from this heading to next same-level heading
                snippet_lines = [line]
                heading_level = len(line) - len(line.lstrip("#"))

                for j in range(i + 1, len(lines)):
                    next_line = lines[j]
                    if next_line.startswith("#"):
                        next_level = len(next_line) - len(next_line.lstrip("#"))
                        if next_level <= heading_level:
                            break
                    snippet_lines.append(next_line)

                return SearchResult(
                    found=True,
                    filename=filename,
                    query=query,
                    snippet="\n".join(snippet_lines),
                )

        # If no heading match, try plain text match
        for i, line in enumerate(lines):
            if query in line:
                # Return 12 lines of context
                start = max(0, i - 6)
                end = min(len(lines), i + 6)
                snippet = "\n".join(lines[start:end])
                return SearchResult(found=True, filename=filename, query=query, snippet=snippet)

        return SearchResult(found=False, filename=filename, query=query, snippet="")


def find_relevant_snippets(
    output_dir: Path,
    output_files: list[str],
    query_text: str,
    max_chars: int,
) -> dict[str, str]:
    """Find capped, heading-bounded snippets from existing output documents."""
    snippets: dict[str, str] = {}
    for filename in output_files:
        path = output_dir / filename
        if not path.exists() or max_chars <= 0:
            continue
        try:
            content = path.read_text(encoding="utf-8")
        except Exception:
            continue
        snippet = _find_heading_snippet(content, query_text, max_chars)
        if snippet:
            snippets[filename] = snippet
    return snippets


def _find_heading_snippet(content: str, query_text: str, max_chars: int) -> str:
    sections = _heading_sections(content)
    for heading, section in sections:
        if heading and heading in query_text:
            return section[:max_chars]
    for heading, section in sections:
        if heading and heading in section and any(term in section for term in _candidate_terms(query_text)):
            return section[:max_chars]
    return ""


def _heading_sections(content: str) -> list[tuple[str, str]]:
    lines = content.splitlines()
    sections: list[tuple[str, str]] = []
    for index, line in enumerate(lines):
        if not line.startswith("#"):
            continue
        level = len(line) - len(line.lstrip("#"))
        start = index
        end = index + 1
        while end < len(lines):
            next_line = lines[end]
            if next_line.startswith("#"):
                next_level = len(next_line) - len(next_line.lstrip("#"))
                if next_level <= level:
                    break
            end += 1
        heading = line.lstrip("#").strip()
        sections.append((heading, "\n".join(lines[start:end])))
    return sections


def _candidate_terms(text: str) -> list[str]:
    return [part for part in text.replace("\n", " ").split(" ") if len(part) >= 2]
