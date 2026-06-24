"""CLI commands for novel extractor."""

import argparse
import json
import sys
from pathlib import Path

from novel_extractor.config import load_config
from novel_extractor.llm import create_llm_client_from_config
from novel_extractor.pipeline import run_pipeline
from novel_extractor.progress import ConsoleProgressReporter
from novel_extractor.reasonix_compat.usage import DEFAULT_DEEPSEEK_PRICING, Pricing


def _resolve_config_path(config_path: str) -> Path:
    path = Path(config_path)
    if path.is_absolute() or path.exists():
        return path

    project_path = Path(__file__).resolve().parents[2] / path
    if project_path.exists():
        return project_path

    return path


def build_parser() -> argparse.ArgumentParser:
    """Build CLI argument parser."""
    parser = argparse.ArgumentParser(description="Novel Extractor - 小说信息提取工具")

    subparsers = parser.add_subparsers(dest="command", help="可用命令")

    # plan command
    plan_parser = subparsers.add_parser("plan", help="显示执行计划（不调用模型）")
    plan_parser.add_argument("--config", required=True, help="配置文件路径")

    # run command
    run_parser = subparsers.add_parser("run", help="执行提取任务")
    run_parser.add_argument("--config", required=True, help="配置文件路径")
    run_parser.add_argument("--quiet", action="store_true", help="静默模式（只显示错误）")
    run_parser.add_argument("--verbose", action="store_true", help="详细模式（显示调试信息）")
    run_parser.add_argument("--metrics", help="写出机器可读 JSON metrics 文件")

    # resume command
    resume_parser = subparsers.add_parser("resume", help="恢复中断的任务")
    resume_parser.add_argument("--config", required=True, help="配置文件路径")
    resume_parser.add_argument("--quiet", action="store_true", help="静默模式（只显示错误）")
    resume_parser.add_argument("--verbose", action="store_true", help="详细模式（显示调试信息）")
    resume_parser.add_argument("--metrics", help="写出机器可读 JSON metrics 文件")

    # status command
    status_parser = subparsers.add_parser("status", help="显示任务状态")
    status_parser.add_argument("--config", required=True, help="配置文件路径")

    # reset-window command
    reset_parser = subparsers.add_parser("reset-window", help="重置指定窗口状态")
    reset_parser.add_argument("--config", required=True, help="配置文件路径")
    reset_parser.add_argument("--window", required=True, help="窗口 ID（例如：5-9）")
    reset_parser.add_argument("--group", required=True, help="模板组 ID（例如：resource_group）")

    return parser


def cmd_plan(args) -> None:
    """Execute plan command."""
    config = load_config(_resolve_config_path(args.config))

    print(f"Novel: {config.novel.id}")
    print(f"Window size: {config.window.size}")
    print(f"Stride: {config.window.stride}")
    if config.window.max_windows is None:
        print("Max windows: unlimited")
    else:
        print(f"Max windows: {config.window.max_windows}")
    print(f"Templates: {', '.join(t.filename for t in config.templates)}")

    # Parse chapters to show windows
    from novel_extractor.chapters import build_windows, parse_chapters

    novel_text = config.novel.source_path.read_text(encoding="utf-8")
    chapters = parse_chapters(novel_text, config.novel.chapter_title_pattern)
    windows = build_windows(chapters, config.window.size, config.window.stride, config.window.max_windows)
    all_windows = build_windows(chapters, config.window.size, config.window.stride, None)

    print(f"Chapter batches: total {len(all_windows)}, will process {len(windows)}")
    print(f"First chapter batches: {', '.join(w.window_id for w in windows[:10])}")


def cmd_run(args) -> None:
    """Execute run command."""
    config = load_config(_resolve_config_path(args.config))

    reporter = ConsoleProgressReporter(
        enabled=not args.quiet,
        verbose=args.verbose,
        show_skipped=config.console.show_skipped,
        pricing=_pricing_from_config(config.llm.pricing),
        run_token_budget=config.token_saving.metrics.run_token_budget,
    )

    try:
        llm_client = create_llm_client_from_config(
            config.llm,
            enable_cache=config.token_saving.prompt_cache.enabled,
        )
        result = run_pipeline(config, llm_client, reporter)
        if args.metrics:
            _write_metrics(Path(args.metrics), reporter, result)

        print(f"\n完成：{result.completed_count} | 跳过：{result.skipped_count} | 失败：{result.failed_count}")
        if reporter.usage_tracker.request_count:
            print(f"用量：{reporter.usage_summary()}")

    except KeyboardInterrupt:
        print("\n\n用户中断，任务已停止", file=sys.stderr)
        sys.exit(130)
    except Exception as e:
        print(f"\n错误：{e}", file=sys.stderr)
        sys.exit(1)


def cmd_resume(args) -> None:
    """Execute resume command (same as run)."""
    print("恢复任务...\n")
    cmd_run(args)


def cmd_status(args) -> None:
    """Execute status command."""
    config = load_config(_resolve_config_path(args.config))

    from novel_extractor.ledger import ProgressLedger

    ledger = ProgressLedger(config.paths.state_db)

    print(f"状态文件：{config.paths.state_db}")
    counts = ledger.status_counts(config.novel.id)
    if not counts:
        print("\n暂无运行记录")
    else:
        print("")
        for status in sorted(counts):
            print(f"{status}: {counts[status]}")


def cmd_reset_window(args) -> None:
    """Execute reset-window command."""
    config = load_config(_resolve_config_path(args.config))

    from novel_extractor.ledger import ProgressLedger

    ledger = ProgressLedger(config.paths.state_db)
    ledger.mark_failed(config.novel.id, args.window, args.group, "reset", "reset", "manual reset")

    print(f"已重置：窗口 {args.window}，组 {args.group}")


def _pricing_from_config(pricing_config) -> Pricing:
    if pricing_config is None:
        return DEFAULT_DEEPSEEK_PRICING
    return Pricing(
        cache_hit=pricing_config.cache_hit,
        input=pricing_config.input,
        output=pricing_config.output,
        currency=pricing_config.currency,
    )


def _write_metrics(path: Path, reporter: ConsoleProgressReporter, result) -> None:
    metrics = reporter.usage_tracker.to_metrics()
    metrics.update(
        {
            "completed_count": result.completed_count,
            "skipped_count": result.skipped_count,
            "failed_count": result.failed_count,
        }
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    """Main CLI entry point."""
    parser = build_parser()
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    if args.command == "plan":
        cmd_plan(args)
    elif args.command == "run":
        cmd_run(args)
    elif args.command == "resume":
        cmd_resume(args)
    elif args.command == "status":
        cmd_status(args)
    elif args.command == "reset-window":
        cmd_reset_window(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
