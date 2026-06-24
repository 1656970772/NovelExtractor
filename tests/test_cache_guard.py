from novel_extractor.prompts import build_system_prompt
from novel_extractor.reasonix_compat.cache_shape import capture_shape


def test_system_prompt_is_stable_for_same_template_order():
    templates = {
        "乙.md": "乙模板内容",
        "甲.md": "甲模板内容",
    }

    first = build_system_prompt(templates)
    second = build_system_prompt(dict(reversed(list(templates.items()))))

    assert capture_shape(first, [], 0).system_hash == capture_shape(second, [], 0).system_hash
