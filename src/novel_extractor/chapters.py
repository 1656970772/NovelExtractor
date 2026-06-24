"""Chapter parsing and window generation."""

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class Chapter:
    number: int
    title: str
    body: str


@dataclass(frozen=True)
class ChapterWindow:
    window_id: str
    start: int
    end: int
    context_chapters: list[Chapter]
    commit_chapters: list[Chapter]


def parse_chapters(text: str, pattern: str) -> list[Chapter]:
    """Parse chapters from novel text using title pattern."""
    lines = text.split("\n")
    chapters = []
    current_title = None
    current_body = []
    chapter_number = 0

    for line in lines:
        # Check if line matches chapter title pattern
        if re.match(pattern, line.strip()):
            # Save previous chapter if exists
            if current_title is not None:
                chapters.append(
                    Chapter(
                        number=chapter_number,
                        title=current_title,
                        body="\n".join(current_body).strip(),
                    )
                )

            # Start new chapter
            chapter_number += 1
            current_title = line.strip()
            current_body = []
        elif current_title is not None:
            # Accumulate body lines
            current_body.append(line)

    # Don't forget the last chapter
    if current_title is not None:
        chapters.append(
            Chapter(
                number=chapter_number,
                title=current_title,
                body="\n".join(current_body).strip(),
            )
        )

    return chapters


def build_windows(
    chapters: list[Chapter], size: int, stride: int, max_windows: int | None
) -> list[ChapterWindow]:
    """Build overlapping windows from chapters.

    First window commits all chapters.
    Subsequent windows exclude the first (overlapping) chapter from commit.
    """
    windows = []

    for i in range(0, len(chapters), stride):
        if max_windows is not None and len(windows) >= max_windows:
            break

        # Get window slice
        end_idx = min(i + size, len(chapters))
        window_chapters = chapters[i:end_idx]

        if not window_chapters:
            break

        # Determine commit chapters (exclude first chapter if not first window)
        if i == 0:
            commit_chapters = window_chapters
        else:
            commit_chapters = window_chapters[1:]

        # Create window
        window = ChapterWindow(
            window_id=f"{window_chapters[0].number}-{window_chapters[-1].number}",
            start=window_chapters[0].number,
            end=window_chapters[-1].number,
            context_chapters=window_chapters,
            commit_chapters=commit_chapters,
        )
        windows.append(window)

    return windows
