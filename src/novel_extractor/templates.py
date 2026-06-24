"""Template catalog and routing logic."""

from pathlib import Path

from novel_extractor.config import TemplateConfig, TemplateGroupConfig


class TemplateCatalog:
    """Manages template files and provides access to template content."""

    def __init__(self, template_dir: Path, templates: list[TemplateConfig]) -> None:
        self.template_dir = template_dir
        self.templates = {t.id: t for t in templates}

    def read_template(self, template_id: str) -> str:
        """Read full template content from file."""
        template = self.templates[template_id]
        template_path = self.template_dir / template.filename
        return template_path.read_text(encoding="utf-8")

    def output_filename(self, template_id: str) -> str:
        """Get output filename for a template."""
        return self.templates[template_id].output_filename

    def card_text(self) -> str:
        """Get card text for all templates (for display)."""
        lines = []
        for tid, template in self.templates.items():
            lines.append(f"{tid}: {template.card}")
        return "\n".join(lines)


def route_groups_by_cards(
    chapter_text: str,
    groups: list[TemplateGroupConfig],
    cards: dict[str, str],
) -> list[TemplateGroupConfig]:
    """Route template groups using simple keyword matching.

    This is a deterministic pre-filter. The extraction prompt will ask
    the model to skip if the match is accidental.

    Matches if ANY character from the keywords appears in the chapter text.
    This is intentionally permissive - false positives are filtered by the model.
    """
    selected = []
    import re

    for group in groups:
        # Check if any template in this group matches
        group_matches = False
        for template_id in group.template_ids:
            card = cards.get(template_id, "")
            # Split by all separators
            parts = re.split(r'[、，；,;]', card)

            # Check if any keyword or its characters appear in chapter text
            for part in parts:
                part = part.strip()
                if not part:
                    continue

                # First try exact match
                if part in chapter_text:
                    group_matches = True
                    break

                # Then try character-level match (any character from keyword)
                for char in part:
                    if char in chapter_text:
                        group_matches = True
                        break

                if group_matches:
                    break

            if group_matches:
                break

        if group_matches:
            selected.append(group)

    return selected
