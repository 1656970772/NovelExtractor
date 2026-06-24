"""Tests for configuration loading."""

from pathlib import Path

import pytest

from novel_extractor.config import load_config


def test_load_mvp_config_has_five_templates():
    config = load_config(Path("config/novel_extractor.mvp.yaml"))

    assert config.novel.id == "凡人修仙传"
    assert config.window.size == 5
    assert config.window.stride == 4
    assert config.console.progress is True
    assert config.console.verbose is False
    assert config.console.show_skipped is True
    assert config.llm.default_model == "deepseek-v4-flash"
    assert [template.id for template in config.templates] == [
        "pills",
        "materials",
        "npc_traits",
        "factions",
        "long_causality",
    ]
    assert config.template_by_id("pills").output_filename == "丹药分析.md"


def test_template_group_references_must_exist(tmp_path):
    config_file = tmp_path / "bad.yaml"
    config_file.write_text(
        """
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
  - id: "bad_group"
    template_ids: ["missing"]
    max_full_templates_per_call: 1
write_policy:
  require_chapter_evidence: true
  skip_empty_model_updates: true
  create_missing_output_file: true
  backup_before_write: true
""",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="unknown template id: missing"):
        load_config(config_file)


def test_window_max_windows_defaults_to_sixty_when_omitted(tmp_path):
    config_file = tmp_path / "default_window.yaml"
    config_file.write_text(
        """
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
""",
        encoding="utf-8",
    )

    config = load_config(config_file)

    assert config.window.max_windows == 60


def test_window_max_windows_null_means_unlimited(tmp_path):
    config_file = tmp_path / "unlimited_window.yaml"
    config_file.write_text(
        """
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
  max_windows: null
  overlap_commit_policy: "exclude_leading_overlap"
llm:
  provider: "openai_compatible"
  base_url_env: "DEEPSEEK_BASE_URL"
  api_key_env: "DEEPSEEK_MODEL"
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
""",
        encoding="utf-8",
    )

    config = load_config(config_file)

    assert config.window.max_windows is None
