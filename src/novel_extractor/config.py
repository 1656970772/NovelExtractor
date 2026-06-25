"""Configuration loader and validators."""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


@dataclass(frozen=True)
class NovelConfig:
    id: str
    source_path: Path
    chapter_title_pattern: str


@dataclass(frozen=True)
class PathsConfig:
    template_dir: Path
    output_dir: Path
    state_db: Path


@dataclass(frozen=True)
class WindowConfig:
    size: int
    stride: int
    max_windows: int | None
    overlap_commit_policy: str


@dataclass(frozen=True)
class LLMConfig:
    provider: str
    base_url_env: str
    api_key_env: str
    model_env: str
    default_model: str
    temperature: float
    timeout_seconds: int
    max_retries: int
    pricing: "PricingConfig | None"
    credentials_file: Path | None = None


@dataclass(frozen=True)
class PricingConfig:
    cache_hit: float
    input: float
    output: float
    currency: str


@dataclass(frozen=True)
class TemplateConfig:
    id: str
    filename: str
    output_filename: str
    card: str


@dataclass(frozen=True)
class TemplateGroupConfig:
    id: str
    template_ids: list[str]
    max_full_templates_per_call: int


@dataclass(frozen=True)
class WritePolicyConfig:
    require_chapter_evidence: bool
    skip_empty_model_updates: bool
    create_missing_output_file: bool
    backup_before_write: bool


@dataclass(frozen=True)
class ToolsConfig:
    enabled: list[str]


@dataclass(frozen=True)
class TemplateDiscoveryConfig:
    enabled: bool


@dataclass(frozen=True)
class ConsoleConfig:
    progress: bool
    verbose: bool
    show_skipped: bool


@dataclass(frozen=True)
class PromptCacheConfig:
    enabled: bool = True
    stable_system_prompt: bool = True
    diagnose_prefix_changes: bool = True


@dataclass(frozen=True)
class ToolSurfaceConfig:
    profile: str = "economy"
    economy_enabled_tools: list[str] = field(
        default_factory=lambda: ["grep", "read_file", "write_file", "edit_file", "multi_edit"]
    )


@dataclass(frozen=True)
class ToolOutputsConfig:
    read_file_default_limit: int = 800
    grep_max_matches: int = 80
    glob_max_matches: int = 200
    max_tool_result_chars: int = 12000
    elide_stale_results: bool = True
    min_elide_chars: int = 2048


@dataclass(frozen=True)
class PromptBudgetConfig:
    context_window: int = 1_000_000
    warn_ratio: float = 0.5
    hard_ratio: float = 0.8
    strategy: str = "split"
    allow_summarize_chapters: bool = False
    max_existing_snippet_chars: int = 6000


@dataclass(frozen=True)
class MetricsConfig:
    enabled: bool = True
    daily_token_budget: int | None = None
    run_token_budget: int | None = None
    cache_guard_min_hit_rate_after_warmup: float = 0.10


@dataclass(frozen=True)
class PlannerConfig:
    enabled: bool = False
    model_env: str | None = None


@dataclass(frozen=True)
class RunLoggingConfig:
    enabled: bool
    log_dir: Path
    retention_files: int


@dataclass(frozen=True)
class TokenSavingConfig:
    prompt_cache: PromptCacheConfig
    tool_surface: ToolSurfaceConfig
    tool_outputs: ToolOutputsConfig
    prompt_budget: PromptBudgetConfig
    metrics: MetricsConfig
    planner: PlannerConfig


@dataclass(frozen=True)
class ExtractorConfig:
    novel: NovelConfig
    paths: PathsConfig
    window: WindowConfig
    llm: LLMConfig
    templates: list[TemplateConfig]
    template_groups: list[TemplateGroupConfig]
    write_policy: WritePolicyConfig
    console: ConsoleConfig
    tools: ToolsConfig
    template_discovery: TemplateDiscoveryConfig
    token_saving: TokenSavingConfig
    logging: RunLoggingConfig

    def template_by_id(self, template_id: str) -> TemplateConfig:
        """Get template config by ID."""
        for template in self.templates:
            if template.id == template_id:
                return template
        raise ValueError(f"Template with id '{template_id}' not found")


def load_config(path: Path) -> ExtractorConfig:
    """Load and validate configuration from YAML file."""
    with open(path, encoding="utf-8") as f:
        data = yaml.safe_load(f)

    # Parse novel config
    novel = NovelConfig(
        id=data["novel"]["id"],
        source_path=Path(data["novel"]["source_path"]),
        chapter_title_pattern=data["novel"]["chapter_title_pattern"],
    )

    # Parse paths config
    paths = PathsConfig(
        template_dir=Path(data["paths"]["template_dir"]),
        output_dir=Path(data["paths"]["output_dir"]),
        state_db=Path(data["paths"]["state_db"]),
    )

    # Parse window config
    window_data = data["window"]
    if window_data["size"] < 1:
        raise ValueError("window.size must be >= 1")
    if window_data["stride"] < 1:
        raise ValueError("window.stride must be >= 1")
    if window_data["stride"] > window_data["size"]:
        raise ValueError("window.stride must be <= window.size")
    max_windows = window_data.get("max_windows", 60)
    if max_windows is not None and max_windows < 1:
        raise ValueError("window.max_windows must be >= 1 or null")

    window = WindowConfig(
        size=window_data["size"],
        stride=window_data["stride"],
        max_windows=max_windows,
        overlap_commit_policy=window_data["overlap_commit_policy"],
    )

    # Parse LLM config
    llm_data = data["llm"]
    pricing_data = llm_data.get("pricing")
    pricing = None
    if pricing_data:
        pricing = PricingConfig(
            cache_hit=pricing_data["cache_hit"],
            input=pricing_data["input"],
            output=pricing_data["output"],
            currency=pricing_data.get("currency", "¥"),
        )

    llm = LLMConfig(
        provider=llm_data["provider"],
        base_url_env=llm_data["base_url_env"],
        api_key_env=llm_data["api_key_env"],
        model_env=llm_data["model_env"],
        default_model=llm_data["default_model"],
        temperature=llm_data["temperature"],
        timeout_seconds=llm_data["timeout_seconds"],
        max_retries=llm_data["max_retries"],
        pricing=pricing,
        credentials_file=Path(llm_data["credentials_file"]) if llm_data.get("credentials_file") else None,
    )

    # Parse templates
    template_discovery = TemplateDiscoveryConfig(enabled=False)
    templates_data = data["templates"]
    if isinstance(templates_data, dict):
        template_discovery = TemplateDiscoveryConfig(
            enabled=templates_data.get("discovery", {}).get("enabled", False)
        )
        templates_data = templates_data.get("items", [])

    templates = []
    for tmpl in templates_data:
        templates.append(
            TemplateConfig(
                id=tmpl["id"],
                filename=tmpl["filename"],
                output_filename=tmpl["output_filename"],
                card=tmpl["card"],
            )
        )

    # Parse template groups
    template_groups = []
    template_ids = {t.id for t in templates}
    for group in data["template_groups"]:
        for tid in group["template_ids"]:
            if tid not in template_ids:
                raise ValueError(f"unknown template id: {tid}")
        template_groups.append(
            TemplateGroupConfig(
                id=group["id"],
                template_ids=group["template_ids"],
                max_full_templates_per_call=group["max_full_templates_per_call"],
            )
        )

    # Parse write policy
    write_policy = WritePolicyConfig(
        require_chapter_evidence=data["write_policy"]["require_chapter_evidence"],
        skip_empty_model_updates=data["write_policy"]["skip_empty_model_updates"],
        create_missing_output_file=data["write_policy"]["create_missing_output_file"],
        backup_before_write=data["write_policy"]["backup_before_write"],
    )

    # Parse console config with defaults
    console_data = data.get("console", {})
    console = ConsoleConfig(
        progress=console_data.get("progress", True),
        verbose=console_data.get("verbose", False),
        show_skipped=console_data.get("show_skipped", True),
    )

    tools_data = data.get("tools", {})
    tools = ToolsConfig(
        enabled=tools_data.get("enabled", ["grep", "read_file", "write_file", "edit_file", "multi_edit", "glob", "ls"])
    )

    token_saving = _load_token_saving(_section(data, "token_saving", "token_saving"))
    run_logging = _load_run_logging(_section(data, "logging", "logging"), paths)

    return ExtractorConfig(
        novel=novel,
        paths=paths,
        window=window,
        llm=llm,
        templates=templates,
        template_groups=template_groups,
        write_policy=write_policy,
        console=console,
        tools=tools,
        template_discovery=template_discovery,
        token_saving=token_saving,
        logging=run_logging,
    )


def _section(data: dict[str, Any] | None, key: str, path: str) -> dict[str, Any]:
    value = {} if data is None else data.get(key)
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError(f"{path} must be a mapping")
    return value


def _string_list(value: Any, path: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError(f"{path} must be a list of strings")
    return value


def _positive_int(value: Any, path: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise ValueError(f"{path} must be a positive integer")
    return value


def _non_negative_int(value: Any, path: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError(f"{path} must be a non-negative integer")
    return value


def _optional_non_negative_int(value: Any, path: str) -> int | None:
    if value is None:
        return None
    return _non_negative_int(value, path)


def _ratio(value: Any, path: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0 or value > 1:
        raise ValueError(f"{path} must be a number between 0 and 1")
    return float(value)


def _load_token_saving(data: dict[str, Any]) -> TokenSavingConfig:
    prompt_cache_data = _section(data, "prompt_cache", "token_saving.prompt_cache")
    tool_surface_data = _section(data, "tool_surface", "token_saving.tool_surface")
    tool_outputs_data = _section(data, "tool_outputs", "token_saving.tool_outputs")
    prompt_budget_data = _section(data, "prompt_budget", "token_saving.prompt_budget")
    metrics_data = _section(data, "metrics", "token_saving.metrics")
    planner_data = _section(data, "planner", "token_saving.planner")
    tool_surface_profile = tool_surface_data.get("profile", "economy")
    if tool_surface_profile not in {"economy", "full"}:
        raise ValueError("token_saving.tool_surface.profile must be one of: economy, full")
    prompt_budget_strategy = prompt_budget_data.get("strategy", "split")
    if prompt_budget_strategy not in {"split", "skip", "summarize"}:
        raise ValueError("token_saving.prompt_budget.strategy must be one of: split, skip, summarize")
    economy_enabled_tools = _string_list(
        tool_surface_data.get(
            "economy_enabled_tools",
            ["grep", "read_file", "write_file", "edit_file", "multi_edit"],
        ),
        "token_saving.tool_surface.economy_enabled_tools",
    )
    read_file_default_limit = _positive_int(
        tool_outputs_data.get("read_file_default_limit", 800),
        "token_saving.tool_outputs.read_file_default_limit",
    )
    grep_max_matches = _positive_int(
        tool_outputs_data.get("grep_max_matches", 80),
        "token_saving.tool_outputs.grep_max_matches",
    )
    glob_max_matches = _positive_int(
        tool_outputs_data.get("glob_max_matches", 200),
        "token_saving.tool_outputs.glob_max_matches",
    )
    max_tool_result_chars = _positive_int(
        tool_outputs_data.get("max_tool_result_chars", 12000),
        "token_saving.tool_outputs.max_tool_result_chars",
    )
    min_elide_chars = _positive_int(
        tool_outputs_data.get("min_elide_chars", 2048),
        "token_saving.tool_outputs.min_elide_chars",
    )
    context_window = _positive_int(
        prompt_budget_data.get("context_window", 1_000_000),
        "token_saving.prompt_budget.context_window",
    )
    warn_ratio = _ratio(prompt_budget_data.get("warn_ratio", 0.5), "token_saving.prompt_budget.warn_ratio")
    hard_ratio = _ratio(prompt_budget_data.get("hard_ratio", 0.8), "token_saving.prompt_budget.hard_ratio")
    if warn_ratio > hard_ratio:
        raise ValueError("token_saving.prompt_budget.warn_ratio must be <= hard_ratio")
    max_existing_snippet_chars = _non_negative_int(
        prompt_budget_data.get("max_existing_snippet_chars", 6000),
        "token_saving.prompt_budget.max_existing_snippet_chars",
    )
    daily_token_budget = _optional_non_negative_int(
        metrics_data.get("daily_token_budget"),
        "token_saving.metrics.daily_token_budget",
    )
    run_token_budget = _optional_non_negative_int(
        metrics_data.get("run_token_budget"),
        "token_saving.metrics.run_token_budget",
    )
    cache_guard_min_hit_rate_after_warmup = _ratio(
        metrics_data.get("cache_guard_min_hit_rate_after_warmup", 0.10),
        "token_saving.metrics.cache_guard_min_hit_rate_after_warmup",
    )

    return TokenSavingConfig(
        prompt_cache=PromptCacheConfig(
            enabled=prompt_cache_data.get("enabled", True),
            stable_system_prompt=prompt_cache_data.get("stable_system_prompt", True),
            diagnose_prefix_changes=prompt_cache_data.get("diagnose_prefix_changes", True),
        ),
        tool_surface=ToolSurfaceConfig(
            profile=tool_surface_profile,
            economy_enabled_tools=economy_enabled_tools,
        ),
        tool_outputs=ToolOutputsConfig(
            read_file_default_limit=read_file_default_limit,
            grep_max_matches=grep_max_matches,
            glob_max_matches=glob_max_matches,
            max_tool_result_chars=max_tool_result_chars,
            elide_stale_results=tool_outputs_data.get("elide_stale_results", True),
            min_elide_chars=min_elide_chars,
        ),
        prompt_budget=PromptBudgetConfig(
            context_window=context_window,
            warn_ratio=warn_ratio,
            hard_ratio=hard_ratio,
            strategy=prompt_budget_strategy,
            allow_summarize_chapters=prompt_budget_data.get("allow_summarize_chapters", False),
            max_existing_snippet_chars=max_existing_snippet_chars,
        ),
        metrics=MetricsConfig(
            enabled=metrics_data.get("enabled", True),
            daily_token_budget=daily_token_budget,
            run_token_budget=run_token_budget,
            cache_guard_min_hit_rate_after_warmup=cache_guard_min_hit_rate_after_warmup,
        ),
        planner=PlannerConfig(
            enabled=planner_data.get("enabled", False),
            model_env=planner_data.get("model_env"),
        ),
    )


def _load_run_logging(data: dict[str, Any], paths: PathsConfig) -> RunLoggingConfig:
    return RunLoggingConfig(
        enabled=bool(data.get("enabled", True)),
        log_dir=Path(data.get("log_dir", paths.state_db.parent / "logs")),
        retention_files=_positive_int(data.get("retention_files", 20), "logging.retention_files"),
    )
