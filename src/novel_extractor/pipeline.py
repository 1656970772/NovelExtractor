"""Main pipeline for extraction."""

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

from novel_extractor.chapters import build_windows, parse_chapters
from novel_extractor.config import ExtractorConfig
from novel_extractor.doc_index import find_relevant_snippets
from novel_extractor.ledger import ProgressLedger
from novel_extractor.llm import LLMClient
from novel_extractor.progress import NullProgressReporter, ProgressReporter
from novel_extractor.prompts import build_extraction_prompt, build_system_prompt, build_user_prompt
from novel_extractor.reasonix_compat.file_tools import WorkspaceTools
from novel_extractor.reasonix_compat.tool_budget import ToolOutputBudget
from novel_extractor.reasonix_compat.tooling import ToolExecutionLedger
from novel_extractor.reasonix_compat.usage import TokenBudgetExceeded
from novel_extractor.templates import TemplateCatalog, route_groups_by_cards
from novel_extractor.token_saving import PromptBudgetExceeded, PromptBudgeter
from novel_extractor.verifier import verify_written_file
from novel_extractor.writer import apply_doc_updates, parse_doc_updates


@dataclass(frozen=True)
class PipelineResult:
    completed_count: int
    skipped_count: int
    failed_count: int


def _compute_hash(text: str) -> str:
    """Compute SHA256 hash of text."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def enabled_tools_for_profile(config: ExtractorConfig) -> list[str]:
    """Resolve the configured tool surface for model tool calls."""
    if config.token_saving.tool_surface.profile == "economy":
        return config.token_saving.tool_surface.economy_enabled_tools
    return config.tools.enabled


def run_pipeline(
    config: ExtractorConfig,
    llm_client: LLMClient,
    reporter: ProgressReporter | None = None,
) -> PipelineResult:
    """Run the extraction pipeline."""
    if reporter is None:
        reporter = NullProgressReporter()

    # Read novel
    novel_text = Path(config.novel.source_path).read_text(encoding="utf-8")
    chapters = parse_chapters(novel_text, config.novel.chapter_title_pattern)
    windows = build_windows(chapters, config.window.size, config.window.stride, config.window.max_windows)

    # Initialize components
    ledger = ProgressLedger(config.paths.state_db)
    catalog = TemplateCatalog(config.paths.template_dir, config.templates)

    # Report run start
    reporter.start_run(
        novel_id=config.novel.id,
        total_chapters=len(chapters),
        total_windows=len(windows),
        template_count=len(config.templates),
        window_size=config.window.size,
        stride=config.window.stride,
        output_dir=str(config.paths.output_dir),
    )

    completed_count = 0
    skipped_count = 0
    failed_count = 0

    # Process each window
    for window_idx, window in enumerate(windows, 1):
        reporter.start_window(window_idx, len(windows), window.window_id)

        # Combine context chapters
        context_text = "\n\n".join(f"{ch.title}\n{ch.body}" for ch in window.context_chapters)

        # Route groups
        template_cards = {t.id: t.card for t in config.templates}
        selected_groups = route_groups_by_cards(context_text, config.template_groups, template_cards)
        reporter.routed_groups([g.id for g in selected_groups])

        # Process each group
        for group in selected_groups:
            try:
                # Compute hashes
                chapter_hash = _compute_hash(context_text)
                sorted_template_ids = sorted(group.template_ids, key=catalog.output_filename)
                template_texts = {
                    catalog.output_filename(tid): catalog.read_template(tid)
                    for tid in sorted_template_ids
                }
                template_hash = _compute_hash("".join(template_texts.values()))

                # Check if should skip
                if ledger.should_skip(config.novel.id, window.window_id, group.id, chapter_hash, template_hash):
                    reporter.group_skipped(group.id, "已完成且 hash 未变化")
                    skipped_count += 1
                    continue

                # Mark running
                ledger.mark_running(config.novel.id, window.window_id, group.id, chapter_hash, template_hash)
                output_files = list(template_texts)
                reporter.group_running(group.id, output_files)

                existing_snippets = find_relevant_snippets(
                    config.paths.output_dir,
                    output_files,
                    query_text=context_text,
                    max_chars=config.token_saving.prompt_budget.max_existing_snippet_chars,
                )

                system_prompt = build_system_prompt(template_texts)
                user_prompt = build_user_prompt(
                    novel_id=config.novel.id,
                    window_id=window.window_id,
                    context_chapters=window.context_chapters,
                    commit_chapters=window.commit_chapters,
                    existing_snippets=existing_snippets,
                )
                prompt_budgeter = PromptBudgeter.from_config(config.token_saving.prompt_budget)
                budget_decision = prompt_budgeter.evaluate(system_prompt, user_prompt)
                if hasattr(reporter, "prompt_budget_status"):
                    reporter.prompt_budget_status(budget_decision)
                if budget_decision.level == "warn" and hasattr(reporter, "prompt_budget_warning"):
                    reporter.prompt_budget_warning(budget_decision)
                if budget_decision.level == "hard":
                    raise PromptBudgetExceeded(budget_decision)

                # Call model with cache optimization
                if reporter and hasattr(reporter, "verbose") and reporter.verbose:
                    total_chars = len(system_prompt) + len(user_prompt)
                    reporter.model_call("model", total_chars, len(existing_snippets))

                if hasattr(llm_client, "run_with_tools"):
                    tool_ledger = ToolExecutionLedger(config.paths.output_dir)
                    tool_budget = ToolOutputBudget.from_config(config.token_saving.tool_outputs)
                    registry = WorkspaceTools(config.paths.output_dir, tool_ledger, tool_budget).registry(
                        enabled_tools_for_profile(config)
                    )
                    tool_result = llm_client.run_with_tools(
                        system_prompt,
                        user_prompt,
                        registry,
                        reporter,
                        tool_budget=tool_budget,
                        diagnose_cache_shape=config.token_saving.prompt_cache.diagnose_prefix_changes,
                    )
                    written_files = _validate_tool_loop_result(
                        final_text=tool_result.final_text,
                        tool_ledger=tool_ledger,
                        output_files=output_files,
                        output_dir=config.paths.output_dir,
                        evidence_required=config.write_policy.require_chapter_evidence,
                        context_chapters=window.context_chapters,
                    )
                    output_hash = _compute_hash(tool_result.final_text + "".join(written_files))
                    if written_files:
                        reporter.group_completed(group.id, written_files)
                        ledger.mark_completed(
                            config.novel.id, window.window_id, group.id, chapter_hash, template_hash, output_hash
                        )
                    else:
                        reporter.group_completed(group.id, [])
                        ledger.mark_no_update(
                            config.novel.id, window.window_id, group.id, chapter_hash, template_hash, output_hash
                        )
                    completed_count += 1
                    continue

                # Legacy fallback for old clients.
                if hasattr(llm_client, "complete_with_cache"):
                    response = llm_client.complete_with_cache(system_prompt, user_prompt)
                else:
                    # Fallback for clients without cache support
                    prompt = build_extraction_prompt(
                        novel_id=config.novel.id,
                        window_id=window.window_id,
                        context_chapters=window.context_chapters,
                        commit_chapters=window.commit_chapters,
                        template_texts=template_texts,
                        existing_snippets=existing_snippets,
                    )
                    response = llm_client.complete(prompt)

                # Parse and apply updates
                updates = parse_doc_updates(response)
                if updates:
                    apply_doc_updates(config.paths.output_dir, updates, config.write_policy.backup_before_write)

                    # Verify written files
                    written_files = []
                    for update in updates:
                        file_path = config.paths.output_dir / update.filename
                        result = verify_written_file(file_path)
                        if not result.ok:
                            raise ValueError(f"Verification failed for {update.filename}: {result.reason}")
                        written_files.append(update.filename)

                    output_hash = _compute_hash(response)
                    reporter.group_completed(group.id, written_files)
                else:
                    output_hash = "no-update"
                    reporter.group_completed(group.id, [])

                # Mark completed
                ledger.mark_completed(config.novel.id, window.window_id, group.id, chapter_hash, template_hash, output_hash)
                completed_count += 1

            except KeyboardInterrupt:
                # User interrupted
                ledger.mark_failed(config.novel.id, window.window_id, group.id, chapter_hash, template_hash, "interrupted by user")
                reporter.group_failed(group.id, "interrupted by user")
                raise

            except TokenBudgetExceeded as e:
                ledger.mark_failed(config.novel.id, window.window_id, group.id, chapter_hash, template_hash, str(e))
                reporter.group_failed(group.id, str(e))
                raise

            except Exception as e:
                if _is_authentication_failure(e):
                    ledger.mark_failed(config.novel.id, window.window_id, group.id, chapter_hash, template_hash, str(e))
                    reporter.group_failed(group.id, str(e))
                    raise
                # Other error
                ledger.mark_failed(config.novel.id, window.window_id, group.id, chapter_hash, template_hash, str(e))
                reporter.group_failed(group.id, str(e))
                failed_count += 1

    return PipelineResult(completed_count=completed_count, skipped_count=skipped_count, failed_count=failed_count)


def _is_authentication_failure(exc: Exception) -> bool:
    if getattr(exc, "status_code", None) == 401:
        return True
    message = str(exc).lower()
    return "authentication_error" in message or "authentication fails" in message or "api key" in message and "invalid" in message


def _validate_tool_loop_result(
    final_text: str,
    tool_ledger: ToolExecutionLedger,
    output_files: list[str],
    output_dir: Path,
    evidence_required: bool,
    context_chapters,
) -> list[str]:
    """Validate Reasonix-style direct file writes."""
    written_files = sorted(tool_ledger.written_files)
    if not written_files:
        if final_text.strip() == "NO_UPDATE":
            return []
        raise ValueError("model finished without writer tool calls and did not output exact NO_UPDATE")

    allowed_outputs = set(output_files)
    for filename in written_files:
        if filename not in allowed_outputs:
            raise ValueError(f"model wrote unexpected file: {filename}")
        if not tool_ledger.was_queried_before_write(filename):
            raise ValueError(f"model wrote {filename} before querying it with grep/read_file")

        file_path = output_dir / filename
        result = verify_written_file(file_path)
        if not result.ok:
            raise ValueError(f"Verification failed for {filename}: {result.reason}")

        if evidence_required:
            for content in tool_ledger.write_contents.get(filename, []):
                if content.strip() and not _has_valid_evidence(content, context_chapters):
                    raise ValueError(f"{filename} update lacks required evidence chapter in current batch")

    return written_files


def _has_valid_evidence(content: str, context_chapters) -> bool:
    if "证据章节" not in content:
        return False
    allowed_numbers = {chapter.number for chapter in context_chapters}
    for number in re.findall(r"第\s*(\d+)\s*章", content):
        if int(number) in allowed_numbers:
            return True
    return any(chapter.title in content for chapter in context_chapters)
