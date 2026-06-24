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


def test_optional_planner_model_config_is_separate_from_executor(tmp_path):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        MINIMAL_CONFIG_WITHOUT_TOKEN_SAVING
        + """
token_saving:
  planner:
    enabled: true
    model_env: "DEEPSEEK_PLANNER_MODEL"
""",
        encoding="utf-8",
    )

    config = load_config(config_path)

    assert config.token_saving.planner.enabled is True
    assert config.token_saving.planner.model_env == "DEEPSEEK_PLANNER_MODEL"
    assert config.llm.model_env == "DEEPSEEK_MODEL"
