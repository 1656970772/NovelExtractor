import json
from pathlib import Path
from types import SimpleNamespace

from novel_extractor import cli
from novel_extractor.cli import build_parser, cmd_run
from novel_extractor.pipeline import PipelineResult
from novel_extractor.reasonix_compat.usage import Usage


def test_cli_run_accepts_metrics_argument():
    parser = build_parser()

    args = parser.parse_args(["run", "--config", "config/novel_extractor.mvp.yaml", "--metrics", "metrics.json"])

    assert args.metrics == "metrics.json"


def test_cli_run_writes_metrics_file(monkeypatch, tmp_path):
    metrics_path = tmp_path / "metrics.json"
    config = SimpleNamespace(
        llm=SimpleNamespace(pricing=None),
        console=SimpleNamespace(show_skipped=True),
        token_saving=SimpleNamespace(
            prompt_cache=SimpleNamespace(enabled=True),
            metrics=SimpleNamespace(run_token_budget=None),
        ),
    )

    monkeypatch.setattr("novel_extractor.cli.load_config", lambda path: config)
    monkeypatch.setattr("novel_extractor.cli.create_llm_client_from_config", lambda llm, enable_cache=True: object())

    def fake_run_pipeline(config, llm_client, reporter):
        reporter.model_usage(Usage(prompt_tokens=100, completion_tokens=20, total_tokens=120, cache_hit_tokens=80))
        return PipelineResult(completed_count=1, skipped_count=2, failed_count=3)

    monkeypatch.setattr("novel_extractor.cli.run_pipeline", fake_run_pipeline)

    cmd_run(SimpleNamespace(config="config.yaml", quiet=True, verbose=False, metrics=str(metrics_path)))

    metrics = json.loads(metrics_path.read_text(encoding="utf-8"))
    assert metrics["prompt_tokens"] == 100
    assert metrics["cache_hit_tokens"] == 80
    assert metrics["completed_count"] == 1
    assert metrics["failed_count"] == 3


def test_cli_run_passes_prompt_cache_enabled_to_client_factory(monkeypatch):
    config = SimpleNamespace(
        llm=SimpleNamespace(pricing=None),
        console=SimpleNamespace(show_skipped=True),
        token_saving=SimpleNamespace(
            prompt_cache=SimpleNamespace(enabled=False),
            metrics=SimpleNamespace(run_token_budget=None),
        ),
    )
    captured = {}

    monkeypatch.setattr("novel_extractor.cli.load_config", lambda path: config)

    def fake_create_client(llm_config, enable_cache=True):
        captured["enable_cache"] = enable_cache
        return object()

    monkeypatch.setattr("novel_extractor.cli.create_llm_client_from_config", fake_create_client)
    monkeypatch.setattr(
        "novel_extractor.cli.run_pipeline",
        lambda config, llm_client, reporter: PipelineResult(completed_count=0, skipped_count=0, failed_count=0),
    )

    cmd_run(SimpleNamespace(config="config.yaml", quiet=True, verbose=False, metrics=None))

    assert captured["enable_cache"] is False


def test_cli_run_resolves_project_relative_config_when_called_from_elsewhere(monkeypatch, tmp_path):
    config = SimpleNamespace(
        llm=SimpleNamespace(pricing=None),
        console=SimpleNamespace(show_skipped=True),
        token_saving=SimpleNamespace(
            prompt_cache=SimpleNamespace(enabled=True),
            metrics=SimpleNamespace(run_token_budget=None),
        ),
    )
    captured = {}

    monkeypatch.chdir(tmp_path)

    def fake_load_config(path):
        captured["path"] = path
        return config

    monkeypatch.setattr("novel_extractor.cli.load_config", fake_load_config)
    monkeypatch.setattr("novel_extractor.cli.create_llm_client_from_config", lambda llm, enable_cache=True: object())
    monkeypatch.setattr(
        "novel_extractor.cli.run_pipeline",
        lambda config, llm_client, reporter: PipelineResult(completed_count=0, skipped_count=0, failed_count=0),
    )

    cmd_run(
        SimpleNamespace(
            config="config/novel_extractor.mvp.yaml",
            quiet=True,
            verbose=False,
            metrics=None,
        )
    )

    assert captured["path"] == Path(cli.__file__).resolve().parents[2] / "config" / "novel_extractor.mvp.yaml"
