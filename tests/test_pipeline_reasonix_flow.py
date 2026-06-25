"""Pipeline tests for Reasonix-style tool writing."""

import textwrap
import json
from contextlib import contextmanager
from pathlib import Path

import pytest
import yaml

from novel_extractor.config import load_config
from novel_extractor.ledger import ProgressLedger
from novel_extractor.pipeline import run_pipeline
from novel_extractor.progress import NullProgressReporter
from novel_extractor.reasonix_compat.tooling import ToolLoopResult
from novel_extractor.run_log import RunLogger


class ScriptedToolClient:
    def __init__(self, calls: list[tuple[str, dict]], final_text: str = "完成") -> None:
        self.calls = calls
        self.final_text = final_text

    def run_with_tools(
        self,
        system_prompt,
        user_prompt,
        registry,
        reporter=None,
        tool_budget=None,
        diagnose_cache_shape=True,
    ):
        for name, args in self.calls:
            registry.execute(name, args)
        return ToolLoopResult(final_text=self.final_text, usage_events=[])


class CapturingToolClient:
    def __init__(self) -> None:
        self.tool_names: list[str] = []
        self.user_prompt = ""
        self.diagnose_cache_shape = None

    def run_with_tools(
        self,
        system_prompt,
        user_prompt,
        registry,
        reporter=None,
        tool_budget=None,
        diagnose_cache_shape=True,
    ):
        self.user_prompt = user_prompt
        self.diagnose_cache_shape = diagnose_cache_shape
        self.tool_names = [tool["function"]["name"] for tool in registry.openai_tools()]
        return ToolLoopResult(final_text="NO_UPDATE", usage_events=[])


class AuthenticationFailingToolClient:
    def __init__(self) -> None:
        self.call_count = 0

    def run_with_tools(
        self,
        system_prompt,
        user_prompt,
        registry,
        reporter=None,
        tool_budget=None,
        diagnose_cache_shape=True,
    ):
        self.call_count += 1
        raise RuntimeError(
            "Error code: 401 - {'error': {'message': 'Authentication Fails, Your api key is invalid', "
            "'type': 'authentication_error'}}"
        )


class ActivityCapturingReporter(NullProgressReporter):
    def __init__(self) -> None:
        self.activities: list[tuple[str, str]] = []
        self.failures: list[tuple[str, str]] = []

    @contextmanager
    def activity(self, message: str):
        self.activities.append(("start", message))
        try:
            yield
        finally:
            self.activities.append(("end", message))

    def group_failed(self, group_id: str, error: str) -> None:
        self.failures.append((group_id, error))


def make_config(tmp_path: Path, max_windows=1, token_saving: dict | None = None):
    novel_path = tmp_path / "凡人修仙传.txt"
    novel_path.write_text("第1章 开端\n韩立发现抽髓丸这种丹药。\n", encoding="utf-8")
    template_dir = tmp_path / "模板"
    template_dir.mkdir()
    (template_dir / "丹药分析模板.md").write_text("# 丹药分析模板\n记录名称、用途、证据章节。\n", encoding="utf-8")
    output_dir = tmp_path / "凡人修仙传"
    output_dir.mkdir()
    (output_dir / "丹药分析.md").write_text("# 丹药分析\n", encoding="utf-8")
    max_windows_value = "null" if max_windows is None else str(max_windows)
    token_saving_block = ""
    if token_saving is not None:
        token_saving_yaml = yaml.safe_dump(token_saving, allow_unicode=True, sort_keys=False)
        token_saving_block = "\ntoken_saving:\n" + textwrap.indent(token_saving_yaml, "  ")
    config_file = tmp_path / "config.yaml"
    config_file.write_text(
        f"""
novel:
  id: "凡人修仙传"
  source_path: "{novel_path.as_posix()}"
  chapter_title_pattern: "^第[一二三四五六七八九十百千万零〇两\\\\d]+章"
paths:
  template_dir: "{template_dir.as_posix()}"
  output_dir: "{output_dir.as_posix()}"
  state_db: "{(output_dir / '.novel_extractor' / 'state.sqlite').as_posix()}"
window:
  size: 5
  stride: 4
  max_windows: {max_windows_value}
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
  backup_before_write: false
{token_saving_block}
""",
        encoding="utf-8",
    )
    return load_config(config_file)


def test_pipeline_fails_when_model_writes_without_querying_target_doc(tmp_path):
    config = make_config(tmp_path)
    client = ScriptedToolClient(
        [
            (
                "write_file",
                {"path": "丹药分析.md", "content": "# 丹药分析\n\n## 抽髓丸\n证据章节：第 1 章\n"},
            )
        ]
    )

    result = run_pipeline(config, client, NullProgressReporter())

    assert result.failed_count == 1
    ledger = ProgressLedger(config.paths.state_db)
    assert ledger.get_status("凡人修仙传", "1-1", "resource_group") == "failed"


def test_pipeline_completes_when_model_queries_then_writes_with_evidence(tmp_path):
    config = make_config(tmp_path)
    client = ScriptedToolClient(
        [
            ("read_file", {"path": "丹药分析.md"}),
            (
                "write_file",
                {"path": "丹药分析.md", "content": "# 丹药分析\n\n## 抽髓丸\n证据章节：第 1 章\n"},
            ),
        ]
    )

    result = run_pipeline(config, client, NullProgressReporter())

    assert result.completed_count == 1
    assert result.failed_count == 0
    ledger = ProgressLedger(config.paths.state_db)
    assert ledger.get_status("凡人修仙传", "1-1", "resource_group") == "completed"


def test_pipeline_marks_explicit_no_update_as_no_update_status(tmp_path):
    config = make_config(tmp_path)
    client = ScriptedToolClient([], final_text="NO_UPDATE")

    result = run_pipeline(config, client, NullProgressReporter())

    assert result.completed_count == 1
    ledger = ProgressLedger(config.paths.state_db)
    assert ledger.get_status("凡人修仙传", "1-1", "resource_group") == "no-update"


def test_pipeline_wraps_tool_model_call_in_activity(tmp_path):
    config = make_config(tmp_path)
    client = ScriptedToolClient([], final_text="NO_UPDATE")
    reporter = ActivityCapturingReporter()

    result = run_pipeline(config, client, reporter)

    assert result.completed_count == 1
    assert reporter.activities == [
        ("start", "模型处理中：resource_group"),
        ("end", "模型处理中：resource_group"),
    ]


def test_pipeline_reports_friendly_error_when_model_ignores_tool_protocol(tmp_path):
    config = make_config(tmp_path)
    client = ScriptedToolClient([], final_text="没有按协议返回")
    reporter = ActivityCapturingReporter()

    result = run_pipeline(config, client, reporter)

    assert result.failed_count == 1
    assert reporter.failures == [
        (
            "resource_group",
            "模型没有按写入协议操作：未调用文件写入工具，也没有精确返回 NO_UPDATE。",
        )
    ]


def test_pipeline_logs_model_io_and_tool_results(tmp_path):
    config = make_config(tmp_path)
    client = ScriptedToolClient(
        [
            ("read_file", {"path": "丹药分析.md"}),
            (
                "write_file",
                {"path": "丹药分析.md", "content": "# 丹药分析\n\n## 抽髓丸\n证据章节：第 1 章\n"},
            ),
        ],
        final_text="完成",
    )
    logger = RunLogger(tmp_path / "logs", retention_files=20)
    try:
        result = run_pipeline(config, client, NullProgressReporter(), run_logger=logger)
        log_path = logger.path
    finally:
        logger.close()

    assert result.completed_count == 1
    events = [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines()]
    model_request = next(event for event in events if event["event"] == "model_request")
    assert model_request["data"]["window_id"] == "1-1"
    assert model_request["data"]["group_id"] == "resource_group"
    assert "system_prompt" in model_request["data"]
    assert "user_prompt" in model_request["data"]

    tool_events = [event for event in events if event["event"] == "tool_call"]
    assert tool_events[0]["data"]["name"] == "read_file"
    assert tool_events[0]["data"]["args"] == {"path": "丹药分析.md"}
    assert "# 丹药分析" in tool_events[0]["data"]["result"]
    assert tool_events[1]["data"]["name"] == "write_file"
    assert "wrote" in tool_events[1]["data"]["result"]

    model_response = next(event for event in events if event["event"] == "model_response")
    assert model_response["data"]["final_text"] == "完成"


def test_pipeline_fails_when_written_content_lacks_required_evidence(tmp_path):
    config = make_config(tmp_path)
    client = ScriptedToolClient(
        [
            ("read_file", {"path": "丹药分析.md"}),
            ("write_file", {"path": "丹药分析.md", "content": "# 丹药分析\n\n## 抽髓丸\n"}),
        ]
    )

    result = run_pipeline(config, client, NullProgressReporter())

    assert result.failed_count == 1
    ledger = ProgressLedger(config.paths.state_db)
    assert ledger.get_status("凡人修仙传", "1-1", "resource_group") == "failed"


def test_pipeline_uses_economy_tool_profile_by_default(tmp_path):
    config = make_config(tmp_path, token_saving={"tool_surface": {"profile": "economy"}})
    client = CapturingToolClient()

    run_pipeline(config, client, NullProgressReporter())

    assert client.tool_names == ["edit_file", "grep", "multi_edit", "read_file", "write_file"]
    assert "glob" not in client.tool_names
    assert "ls" not in client.tool_names


def test_pipeline_fails_before_model_call_when_prompt_exceeds_hard_budget(tmp_path):
    config = make_config(
        tmp_path,
        token_saving={
            "prompt_budget": {
                "context_window": 10,
                "warn_ratio": 0.5,
                "hard_ratio": 0.8,
                "strategy": "split",
            }
        },
    )
    client = CapturingToolClient()

    result = run_pipeline(config, client, NullProgressReporter())

    assert result.failed_count == 1
    assert client.tool_names == []


def test_pipeline_injects_relevant_existing_snippets(tmp_path):
    config = make_config(
        tmp_path,
        token_saving={"prompt_budget": {"max_existing_snippet_chars": 120}},
    )
    (config.paths.output_dir / "丹药分析.md").write_text(
        "# 抽髓丸\n" + "甲" * 1000 + "\n# 清灵散\n乙",
        encoding="utf-8",
    )
    client = CapturingToolClient()

    result = run_pipeline(config, client, NullProgressReporter())

    assert result.completed_count == 1
    assert "## 已有片段" in client.user_prompt
    assert "# 抽髓丸" in client.user_prompt
    assert "清灵散" not in client.user_prompt


def test_pipeline_passes_cache_diagnostics_setting_to_tool_loop(tmp_path):
    config = make_config(
        tmp_path,
        token_saving={"prompt_cache": {"diagnose_prefix_changes": False}},
    )
    client = CapturingToolClient()

    run_pipeline(config, client, NullProgressReporter())

    assert client.diagnose_cache_shape is False


def test_pipeline_stops_immediately_on_authentication_error(tmp_path):
    config = make_config(tmp_path, max_windows=None)
    client = AuthenticationFailingToolClient()

    with pytest.raises(RuntimeError, match="Authentication Fails"):
        run_pipeline(config, client, NullProgressReporter())

    assert client.call_count == 1
