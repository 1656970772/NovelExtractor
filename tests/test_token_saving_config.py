import pytest

from novel_extractor.config import load_config


MINIMAL_CONFIG_WITHOUT_TOKEN_SAVING = """
novel:
  id: "x"
  source_path: "novel.txt"
  chapter_title_pattern: "^第"
paths:
  template_dir: "templates"
  output_dir: "out"
  state_db: "state.sqlite"
window:
  size: 5
  stride: 4
  max_windows: 1
  overlap_commit_policy: "exclude_leading_overlap"
llm:
  provider: "openai_compatible"
  base_url_env: "DEEPSEEK_BASE_URL"
  api_key_env: "DEEPSEEK_API_KEY"
  model_env: "DEEPSEEK_MODEL"
  default_model: "deepseek-v4-flash"
  temperature: 0.2
  timeout_seconds: 120
  max_retries: 2
templates:
  - id: "pills"
    filename: "丹药分析模板.md"
    output_filename: "丹药分析.md"
    card: "丹药"
template_groups:
  - id: "resource_group"
    template_ids: ["pills"]
    max_full_templates_per_call: 1
write_policy:
  require_chapter_evidence: true
  skip_empty_model_updates: true
  create_missing_output_file: true
  backup_before_write: true
"""


CONFIG_WITH_TOKEN_SAVING = """
novel:
  id: "x"
  source_path: "novel.txt"
  chapter_title_pattern: "^第"
paths:
  template_dir: "templates"
  output_dir: "out"
  state_db: "state.sqlite"
window:
  size: 5
  stride: 4
  max_windows: 1
  overlap_commit_policy: "exclude_leading_overlap"
llm:
  provider: "openai_compatible"
  base_url_env: "DEEPSEEK_BASE_URL"
  api_key_env: "DEEPSEEK_API_KEY"
  model_env: "DEEPSEEK_MODEL"
  default_model: "deepseek-v4-flash"
  temperature: 0.2
  timeout_seconds: 120
  max_retries: 2
templates:
  - id: "pills"
    filename: "丹药分析模板.md"
    output_filename: "丹药分析.md"
    card: "丹药"
template_groups:
  - id: "resource_group"
    template_ids: ["pills"]
    max_full_templates_per_call: 1
write_policy:
  require_chapter_evidence: true
  skip_empty_model_updates: true
  create_missing_output_file: true
  backup_before_write: true
token_saving:
  prompt_cache:
    enabled: false
    stable_system_prompt: false
    diagnose_prefix_changes: false
  tool_surface:
    profile: "full"
    economy_enabled_tools: ["read_file", "grep"]
  tool_outputs:
    read_file_default_limit: 123
    grep_max_matches: 321
    glob_max_matches: 654
    max_tool_result_chars: 9876
    elide_stale_results: false
    min_elide_chars: 4321
  prompt_budget:
    context_window: 456789
    warn_ratio: 0.25
    hard_ratio: 0.75
    strategy: "skip"
    allow_summarize_chapters: true
    max_existing_snippet_chars: 1357
  metrics:
    enabled: false
    daily_token_budget: 111
    run_token_budget: 999
    cache_guard_min_hit_rate_after_warmup: 0.42
  planner:
    enabled: true
    model_env: "PLANNER_MODEL"
"""


def test_token_saving_config_defaults_when_missing(tmp_path):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(MINIMAL_CONFIG_WITHOUT_TOKEN_SAVING, encoding="utf-8")

    config = load_config(config_path)

    assert config.token_saving.prompt_cache.enabled is True
    assert config.token_saving.tool_surface.profile == "economy"
    assert config.token_saving.prompt_budget.strategy == "split"


def test_token_saving_empty_sections_use_defaults(tmp_path):
    for config_text in (
        MINIMAL_CONFIG_WITHOUT_TOKEN_SAVING + "\ntoken_saving:\n",
        MINIMAL_CONFIG_WITHOUT_TOKEN_SAVING + "\ntoken_saving:\n  prompt_cache:\n",
    ):
        config_path = tmp_path / "config.yaml"
        config_path.write_text(config_text, encoding="utf-8")

        config = load_config(config_path)

        assert config.token_saving.prompt_cache.enabled is True
        assert config.token_saving.prompt_cache.stable_system_prompt is True
        assert config.token_saving.prompt_cache.diagnose_prefix_changes is True
        assert config.token_saving.tool_surface.profile == "economy"
        assert config.token_saving.tool_surface.economy_enabled_tools == [
            "grep",
            "read_file",
            "write_file",
            "edit_file",
            "multi_edit",
        ]
        assert config.token_saving.tool_outputs.read_file_default_limit == 800
        assert config.token_saving.tool_outputs.grep_max_matches == 80
        assert config.token_saving.tool_outputs.glob_max_matches == 200
        assert config.token_saving.tool_outputs.max_tool_result_chars == 12000
        assert config.token_saving.tool_outputs.elide_stale_results is True
        assert config.token_saving.tool_outputs.min_elide_chars == 2048
        assert config.token_saving.prompt_budget.context_window == 1_000_000
        assert config.token_saving.prompt_budget.warn_ratio == 0.5
        assert config.token_saving.prompt_budget.hard_ratio == 0.8
        assert config.token_saving.prompt_budget.strategy == "split"
        assert config.token_saving.prompt_budget.allow_summarize_chapters is False
        assert config.token_saving.prompt_budget.max_existing_snippet_chars == 6000
        assert config.token_saving.metrics.enabled is True
        assert config.token_saving.metrics.daily_token_budget is None
        assert config.token_saving.metrics.run_token_budget is None
        assert config.token_saving.metrics.cache_guard_min_hit_rate_after_warmup == 0.10
        assert config.token_saving.planner.enabled is False
        assert config.token_saving.planner.model_env is None


def test_token_saving_config_reads_all_thresholds(tmp_path):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(CONFIG_WITH_TOKEN_SAVING, encoding="utf-8")

    config = load_config(config_path)

    assert config.token_saving.prompt_cache.enabled is False
    assert config.token_saving.prompt_cache.stable_system_prompt is False
    assert config.token_saving.prompt_cache.diagnose_prefix_changes is False
    assert config.token_saving.tool_surface.profile == "full"
    assert config.token_saving.tool_surface.economy_enabled_tools == [
        "read_file",
        "grep",
    ]
    assert config.token_saving.tool_outputs.read_file_default_limit == 123
    assert config.token_saving.tool_outputs.grep_max_matches == 321
    assert config.token_saving.tool_outputs.glob_max_matches == 654
    assert config.token_saving.tool_outputs.max_tool_result_chars == 9876
    assert config.token_saving.tool_outputs.elide_stale_results is False
    assert config.token_saving.tool_outputs.min_elide_chars == 4321
    assert config.token_saving.prompt_budget.context_window == 456789
    assert config.token_saving.prompt_budget.warn_ratio == 0.25
    assert config.token_saving.prompt_budget.hard_ratio == 0.75
    assert config.token_saving.prompt_budget.strategy == "skip"
    assert config.token_saving.prompt_budget.allow_summarize_chapters is True
    assert config.token_saving.prompt_budget.max_existing_snippet_chars == 1357
    assert config.token_saving.metrics.enabled is False
    assert config.token_saving.metrics.daily_token_budget == 111
    assert config.token_saving.metrics.run_token_budget == 999
    assert config.token_saving.metrics.cache_guard_min_hit_rate_after_warmup == 0.42
    assert config.token_saving.planner.enabled is True
    assert config.token_saving.planner.model_env == "PLANNER_MODEL"


def test_mvp_config_includes_token_saving_defaults():
    config = load_config("config/novel_extractor.mvp.yaml")

    assert config.token_saving.tool_surface.profile == "economy"
    assert config.token_saving.tool_outputs.max_tool_result_chars == 12000
    assert config.token_saving.prompt_budget.context_window == 1_000_000
    assert config.token_saving.metrics.enabled is True
    assert config.token_saving.planner.enabled is False


def test_token_saving_rejects_unknown_tool_surface_profile(tmp_path):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        MINIMAL_CONFIG_WITHOUT_TOKEN_SAVING
        + """
token_saving:
  tool_surface:
    profile: "ecomony"
""",
        encoding="utf-8",
    )

    try:
        load_config(config_path)
    except ValueError as exc:
        assert "token_saving.tool_surface.profile" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_token_saving_rejects_unknown_prompt_budget_strategy(tmp_path):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        MINIMAL_CONFIG_WITHOUT_TOKEN_SAVING
        + """
token_saving:
  prompt_budget:
    strategy: "budget"
""",
        encoding="utf-8",
    )

    try:
        load_config(config_path)
    except ValueError as exc:
        assert "token_saving.prompt_budget.strategy" in str(exc)
    else:
        raise AssertionError("expected ValueError")


@pytest.mark.parametrize(
    ("token_saving_yaml", "message"),
    [
        (
            "  tool_surface:\n    economy_enabled_tools: read_file\n",
            "token_saving.tool_surface.economy_enabled_tools",
        ),
        (
            "  tool_outputs:\n    max_tool_result_chars: 0\n",
            "token_saving.tool_outputs.max_tool_result_chars",
        ),
        (
            "  prompt_budget:\n    context_window: 0\n",
            "token_saving.prompt_budget.context_window",
        ),
        (
            "  prompt_budget:\n    warn_ratio: -0.1\n",
            "token_saving.prompt_budget.warn_ratio",
        ),
        (
            "  prompt_budget:\n    hard_ratio: 1.1\n",
            "token_saving.prompt_budget.hard_ratio",
        ),
        (
            "  prompt_budget:\n    warn_ratio: 0.9\n    hard_ratio: 0.8\n",
            "token_saving.prompt_budget.warn_ratio",
        ),
        (
            "  metrics:\n    run_token_budget: -1\n",
            "token_saving.metrics.run_token_budget",
        ),
        (
            "  metrics:\n    cache_guard_min_hit_rate_after_warmup: 1.5\n",
            "token_saving.metrics.cache_guard_min_hit_rate_after_warmup",
        ),
    ],
)
def test_token_saving_rejects_invalid_boundary_values(tmp_path, token_saving_yaml, message):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        MINIMAL_CONFIG_WITHOUT_TOKEN_SAVING + "\ntoken_saving:\n" + token_saving_yaml,
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match=message):
        load_config(config_path)
