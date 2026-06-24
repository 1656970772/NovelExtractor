"""Tests for template catalog and routing."""

from pathlib import Path

from novel_extractor.config import TemplateConfig, TemplateGroupConfig
from novel_extractor.templates import TemplateCatalog, route_groups_by_cards


def test_template_catalog_reads_full_template(tmp_path):
    template_dir = tmp_path / "templates"
    template_dir.mkdir()
    (template_dir / "丹药分析模板.md").write_text("# 丹药分析模板\n\n字段要求", encoding="utf-8")

    catalog = TemplateCatalog(
        template_dir=template_dir,
        templates=[
            TemplateConfig(
                id="pills",
                filename="丹药分析模板.md",
                output_filename="丹药分析.md",
                card="丹药、药丸、药汤",
            )
        ],
    )

    assert catalog.read_template("pills").startswith("# 丹药分析模板")
    assert catalog.card_text() == "pills: 丹药、药丸、药汤"


def test_route_groups_by_cards_selects_relevant_groups():
    groups = [
        TemplateGroupConfig(id="resource_group", template_ids=["pills", "materials"], max_full_templates_per_call=2),
        TemplateGroupConfig(id="faction_group", template_ids=["factions"], max_full_templates_per_call=1),
    ]
    cards = {
        "pills": "丹药、药丸、药汤",
        "materials": "材料、药材、灵草",
        "factions": "宗门、家族、势力",
    }

    selected = route_groups_by_cards("墨大夫给厉飞雨服用抽髓丸，药性凶险。", groups, cards)

    assert [group.id for group in selected] == ["resource_group"]
