# Reasonix Token Saving Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `E:\Github_Projects\DeepSeek-Reasonix` 中可迁移的省 token 机制接入 `NovelExtractor`，降低 DeepSeek 调用成本并建立可观测、可回归的缓存保护。

**Architecture:** 采用 Reasonix 的“配置驱动 + 稳定前缀 + 按需能力 + 低频上下文维护 + 用量观测”思路，但适配小说抽取流水线：每个窗口/模板组仍是独立任务，不引入长期聊天会话。新增能力集中在 `token_saving`、`reasonix_compat`、`llm`、`pipeline`、`progress`、`cli` 边界内，避免把策略硬编码进主循环。

**Tech Stack:** Python 3.11+、PyYAML、OpenAI-compatible DeepSeek client、pytest、标准库 `hashlib/json/dataclasses/pathlib/time`.

---

## 1. 参考项目省 token 机制盘点

### 1.1 可直接迁移

1. **DeepSeek 前缀缓存与缓存稳定前缀**
   - Reasonix 依据：`docs/SPEC.md` 写明会话在压缩之间 prepend-only/cache-friendly；`internal/boot/boot.go` 把 memory/skill index 放入稳定 system prefix；`internal/agent/cache_shape.go` 用 system/tools/rewrite hash 诊断前缀变化。
   - NovelExtractor 当前状态：已有 `build_system_prompt()` + `build_user_prompt()`，模板在 system、章节在 user；需要补“稳定性诊断”和“工具 schema 稳定排序”保护。

2. **用量、缓存命中、费用统计**
   - Reasonix 依据：`internal/provider/provider.go` 的 `Usage/Pricing`，`internal/provider/openai/openai.go` 归一化 DeepSeek `prompt_cache_hit_tokens`，`internal/cli/run_metrics.go` 导出 JSON metrics。
   - NovelExtractor 当前状态：已有 `reasonix_compat/usage.py` 和控制台汇总；缺 `--metrics` 文件输出、预算阈值、按窗口/模板组账本。

3. **工具输出限额**
   - Reasonix 依据：`read_file` 默认分页，`grep` 最多 200 matches，大 diff 超阈值省略。
   - NovelExtractor 当前状态：`read_file`、`grep`、`glob` 已有局部限制；缺配置化预算、最大字符数截断、工具结果 token 估算。

4. **缓存敏感变更保护**
   - Reasonix 依据：`scripts/check-cache-impact.sh` 和 `scripts/cache-guard.sh` 要求修改 prompt/tool/cache 表面时说明影响并跑保护测试。
   - NovelExtractor 当前状态：没有 cache guard。需要添加 focused tests，而不是复制 GitHub PR 脚本。

### 1.2 需要改造后迁移

5. **省 token 模式：缩小初始工具/技能/schema 暴露面，按需启用能力**
   - Reasonix 依据：`docs/COLLABORATION_MODES.zh-CN.md` 与 `internal/boot/token_profile.go`；`connect_tool_source` 只在需要时启用 skills/MCP/LSP/web_fetch/task。
   - NovelExtractor 适配：没有通用插件系统，不做完整 `connect_tool_source`。改成配置化 `tools.profile = "economy" | "full"`，economy 只暴露抽取必需工具，`glob/ls` 等调试工具默认关闭。

6. **低频上下文压缩**
   - Reasonix 依据：`internal/agent/compact.go` 在 `compact_ratio` 附近压缩旧消息，保留用户事实和最近尾部。
   - NovelExtractor 适配：小说抽取要求证据原文，不能默认总结章节正文。改为 `PromptBudgeter`：估算 prompt，超预算时优先拆窗口/拆模板组/缩小检索片段；“模型总结章节”只作为显式 opt-in。

7. **旧工具结果裁剪 / 冷恢复裁剪**
   - Reasonix 依据：`internal/agent/prune.go` 裁剪旧大工具结果；`internal/control/controller.go` 在缓存过期后冷恢复裁剪。
   - NovelExtractor 适配：当前每个窗口/模板组没有持久聊天 transcript，不需要冷恢复裁剪；但 `run_with_tools` 内多轮工具结果会进入下一轮，可接入“同一 tool loop 内旧大结果 elide”。

8. **两模型分会话保持缓存**
   - Reasonix 依据：`docs/SPEC.md` 说明 planner/executor 分开会话，避免在同一上下文中切模型破坏前缀。
   - NovelExtractor 适配：当前路由是确定性函数，不需要 planner。若未来引入“模型路由/质量审查模型”，必须使用独立 `LLMClient` 与独立 prompt，不混进抽取执行 prompt。

### 1.3 不建议接入或低优先级

9. **MCP handshake schema cache**
   - Reasonix 依据：`internal/plugin/cache.go` 缓存 MCP schema，主要省启动时间，不直接省模型 token。
   - NovelExtractor 当前没有 MCP 插件系统，不接入。

10. **Memory as synthesis cache**
   - Reasonix 依据：`docs/SESSION_MEMORY_RETRIEVAL.md` 把已批准稳定结论作为 synthesis cache。
   - NovelExtractor 适配为“文档索引/实体片段缓存”：不要把完整输出文档塞进 prompt，只按实体/模板/章节检索相关片段。当前 `existing_snippets = {}` 是最大缺口之一。

---

## 2. 目标架构

### 2.1 新增/修改文件职责

- Create: `src/novel_extractor/token_saving.py`
  负责 token 估算、prompt 预算决策、预算超限策略、配置对象到运行策略的转换。
- Create: `src/novel_extractor/reasonix_compat/cache_shape.py`
  负责 system prompt、tool schema、template hash、rewrite version 的稳定 hash 和诊断。
- Create: `src/novel_extractor/reasonix_compat/tool_budget.py`
  负责工具输出预算、截断标记、旧工具结果 elide。
- Modify: `src/novel_extractor/config.py`
  增加 `token_saving` 配置树，所有阈值配置化。
- Modify: `src/novel_extractor/llm.py`
  在 tool loop 中记录 cache diagnostics，支持可变工具预算和 usage 回传。
- Modify: `src/novel_extractor/pipeline.py`
  接入 `PromptBudgeter`、snippet retrieval、cache shape 记录、预算超限跳过/拆分策略。
- Modify: `src/novel_extractor/doc_index.py`
  增加按模板输出文档检索已有片段的接口。
- Modify: `src/novel_extractor/progress.py`
  输出 cache diagnostics、预算警告、metrics 汇总。
- Modify: `src/novel_extractor/cli.py`
  增加 `--metrics <path>`，写出机器可读 JSON。
- Tests:
  `tests/test_token_saving_config.py`
  `tests/test_cache_shape.py`
  `tests/test_tool_budget.py`
  `tests/test_prompt_budgeter.py`
  `tests/test_doc_index_snippets.py`
  扩展 `tests/test_llm_fake.py`、`tests/test_pipeline_reasonix_flow.py`、`tests/test_reasonix_usage.py`、`tests/test_cli.py`.

### 2.2 配置化覆盖范围

新增 YAML 示例：

```yaml
token_saving:
  prompt_cache:
    enabled: true
    stable_system_prompt: true
    diagnose_prefix_changes: true
  tool_surface:
    profile: "economy"  # economy | full
    economy_enabled_tools: ["grep", "read_file", "write_file", "edit_file", "multi_edit"]
  tool_outputs:
    read_file_default_limit: 800
    grep_max_matches: 80
    glob_max_matches: 200
    max_tool_result_chars: 12000
    elide_stale_results: true
    min_elide_chars: 2048
  prompt_budget:
    context_window: 1000000
    warn_ratio: 0.5
    hard_ratio: 0.8
    strategy: "split"  # split | skip | summarize
    allow_summarize_chapters: false
    max_existing_snippet_chars: 6000
  metrics:
    enabled: true
    daily_token_budget: null
    run_token_budget: null
    cache_guard_min_hit_rate_after_warmup: 0.10
  planner:
    enabled: false
    model_env: null
```

检查结果：
- **通用架构**：策略集中在 `token_saving.py`，主流程只调用接口，不散落阈值。
- **设计模式适配**：使用 Strategy 风格处理预算超限策略；使用 Value Object/dataclass 表示配置和诊断。
- **配置化覆盖范围**：所有阈值、工具集合、开关、预算、策略名都走 YAML，不写死。

---

## 3. Task 1: Token Saving 配置入口

**Files:**
- Modify: `src/novel_extractor/config.py`
- Modify: `config/novel_extractor.mvp.yaml`
- Create: `tests/test_token_saving_config.py`

- [ ] **Step 1: Write failing config tests**

```python
from pathlib import Path

from novel_extractor.config import load_config


def test_token_saving_config_defaults_when_missing(tmp_path):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(MINIMAL_CONFIG_WITHOUT_TOKEN_SAVING, encoding="utf-8")

    config = load_config(config_path)

    assert config.token_saving.prompt_cache.enabled is True
    assert config.token_saving.tool_surface.profile == "economy"
    assert config.token_saving.prompt_budget.strategy == "split"


def test_token_saving_config_reads_all_thresholds(tmp_path):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(CONFIG_WITH_TOKEN_SAVING, encoding="utf-8")

    config = load_config(config_path)

    assert config.token_saving.tool_outputs.read_file_default_limit == 123
    assert config.token_saving.prompt_budget.context_window == 456789
    assert config.token_saving.metrics.run_token_budget == 999
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
pytest tests/test_token_saving_config.py -q
```

Expected:

```text
FAILED ... AttributeError: 'ExtractorConfig' object has no attribute 'token_saving'
```

- [ ] **Step 3: Implement dataclasses and loader**

Add dataclasses:

```python
@dataclass(frozen=True)
class PromptCacheConfig:
    enabled: bool = True
    stable_system_prompt: bool = True
    diagnose_prefix_changes: bool = True


@dataclass(frozen=True)
class ToolSurfaceConfig:
    profile: str = "economy"
    economy_enabled_tools: list[str] = field(default_factory=lambda: ["grep", "read_file", "write_file", "edit_file", "multi_edit"])


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
class TokenSavingConfig:
    prompt_cache: PromptCacheConfig
    tool_surface: ToolSurfaceConfig
    tool_outputs: ToolOutputsConfig
    prompt_budget: PromptBudgetConfig
    metrics: MetricsConfig
    planner: PlannerConfig
```

Use helper `_load_token_saving(data.get("token_saving", {}))`.

- [ ] **Step 4: Verify GREEN**

Run:

```powershell
pytest tests/test_token_saving_config.py tests/test_config.py -q
```

Expected:

```text
passed
```

---

## 4. Task 2: Cache Shape 诊断与稳定 schema

**Files:**
- Create: `src/novel_extractor/reasonix_compat/cache_shape.py`
- Modify: `src/novel_extractor/reasonix_compat/tooling.py`
- Modify: `src/novel_extractor/llm.py`
- Test: `tests/test_cache_shape.py`

- [ ] **Step 1: Write failing cache shape tests**

```python
from novel_extractor.reasonix_compat.cache_shape import capture_shape, compare_shape
from novel_extractor.reasonix_compat.tooling import ToolRegistry


def test_cache_shape_normalizes_tool_order():
    a = ToolRegistry()
    b = ToolRegistry()
    a.add(FakeTool("read_file"))
    a.add(FakeTool("grep"))
    b.add(FakeTool("grep"))
    b.add(FakeTool("read_file"))

    assert capture_shape("system", a.openai_tools(), 0).tools_hash == capture_shape("system", b.openai_tools(), 0).tools_hash


def test_cache_shape_reports_tool_change_reason():
    prev = capture_shape("system", [{"function": {"name": "read_file"}}], 0)
    cur = capture_shape("system", [{"function": {"name": "read_file"}}, {"function": {"name": "grep"}}], 0)

    diagnostics = compare_shape(prev, cur, cache_hit_tokens=100, cache_miss_tokens=20)

    assert diagnostics.prefix_changed is True
    assert diagnostics.prefix_change_reasons == ["tools"]
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
pytest tests/test_cache_shape.py -q
```

Expected:

```text
FAILED ... ModuleNotFoundError: No module named 'novel_extractor.reasonix_compat.cache_shape'
```

- [ ] **Step 3: Implement shape capture**

Create dataclasses:

```python
@dataclass(frozen=True)
class PrefixShape:
    system_hash: str
    tools_hash: str
    prefix_hash: str
    rewrite_version: int
    tool_schema_tokens: int


@dataclass(frozen=True)
class CacheDiagnostics:
    prefix_hash: str
    prefix_changed: bool
    prefix_change_reasons: list[str]
    system_hash: str
    tools_hash: str
    rewrite_version: int
    tool_schema_tokens: int
    cache_hit_tokens: int
    cache_miss_tokens: int
```

Implementation rules:
- Hash with `json.dumps(..., sort_keys=True, ensure_ascii=False)`.
- Normalize tool list by function name + description + parameters.
- Estimate tokens by `max(len(text) // 4, cjk_rune_count_if_larger)`.

- [ ] **Step 4: Wire diagnostics into LLM tool loop**

In `run_with_tools()`:
- Capture shape before first model call.
- After every `Usage`, compare previous/current shape.
- Reporter may receive `model_cache_diagnostics(diagnostics)`.
- Keep registry schema order stable by sorting in `ToolRegistry.openai_tools()`.

- [ ] **Step 5: Verify GREEN**

Run:

```powershell
pytest tests/test_cache_shape.py tests/test_llm_fake.py tests/test_reasonix_tools.py -q
```

Expected:

```text
passed
```

---

## 5. Task 3: Tool Surface Economy Profile

**Files:**
- Modify: `src/novel_extractor/pipeline.py`
- Modify: `src/novel_extractor/reasonix_compat/file_tools.py`
- Test: `tests/test_pipeline_reasonix_flow.py`

- [ ] **Step 1: Write failing pipeline test**

```python
def test_pipeline_uses_economy_tool_profile_by_default(tmp_path):
    config = make_config(tmp_path, token_saving={"tool_surface": {"profile": "economy"}})
    client = CapturingToolClient()

    run_pipeline(config, client)

    assert client.tool_names == ["edit_file", "grep", "multi_edit", "read_file", "write_file"]
    assert "glob" not in client.tool_names
    assert "ls" not in client.tool_names
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
pytest tests/test_pipeline_reasonix_flow.py::test_pipeline_uses_economy_tool_profile_by_default -q
```

Expected:

```text
FAILED ... AssertionError ... glob/ls still present
```

- [ ] **Step 3: Implement profile selection**

Add helper:

```python
def enabled_tools_for_profile(config: ExtractorConfig) -> list[str]:
    profile = config.token_saving.tool_surface.profile
    if profile == "economy":
        return config.token_saving.tool_surface.economy_enabled_tools
    return config.tools.enabled
```

Use this helper when constructing `WorkspaceTools(...).registry(...)`.

- [ ] **Step 4: Verify GREEN**

Run:

```powershell
pytest tests/test_pipeline_reasonix_flow.py tests/test_reasonix_tools.py -q
```

Expected:

```text
passed
```

---

## 6. Task 4: Tool Output Budget and Stale Result Elision

**Files:**
- Create: `src/novel_extractor/reasonix_compat/tool_budget.py`
- Modify: `src/novel_extractor/reasonix_compat/file_tools.py`
- Modify: `src/novel_extractor/llm.py`
- Test: `tests/test_tool_budget.py`

- [ ] **Step 1: Write failing tests**

```python
from novel_extractor.reasonix_compat.tool_budget import ToolOutputBudget, elide_stale_tool_messages


def test_tool_output_budget_truncates_large_result():
    budget = ToolOutputBudget(max_tool_result_chars=20)

    assert budget.apply("read_file", "x" * 50) == "[truncated read_file result: 50 chars, showing first 20]\n" + "x" * 20


def test_elide_stale_tool_messages_keeps_recent_tail():
    messages = [
        {"role": "tool", "name": "read_file", "content": "a" * 3000},
        {"role": "assistant", "content": "ok"},
        {"role": "tool", "name": "grep", "content": "b" * 3000},
    ]

    result = elide_stale_tool_messages(messages, min_elide_chars=2048, recent_keep=1)

    assert "elided tool result" in result[0]["content"]
    assert result[2]["content"] == "b" * 3000
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
pytest tests/test_tool_budget.py -q
```

Expected:

```text
FAILED ... ModuleNotFoundError
```

- [ ] **Step 3: Implement budget object**

Rules:
- `read_file_default_limit` controls default read file lines.
- `grep_max_matches` controls max grep matches.
- `glob_max_matches` controls glob output length.
- `max_tool_result_chars` truncates any single tool return.
- `elide_stale_results` applies before sending next model request in the tool loop.
- Always preserve the most recent `recent_keep` messages.

- [ ] **Step 4: Wire into tools and LLM**

`WorkspaceTools.registry()` accepts `tool_outputs_config`.
`OpenAICompatibleClient.run_with_tools()` accepts optional `tool_budget`.
Before each `chat.completions.create`, call `elide_stale_tool_messages(messages, ...)`.

- [ ] **Step 5: Verify GREEN**

Run:

```powershell
pytest tests/test_tool_budget.py tests/test_reasonix_tools.py tests/test_llm_fake.py -q
```

Expected:

```text
passed
```

---

## 7. Task 5: Prompt Budgeter and Safe Split Strategy

**Files:**
- Create: `src/novel_extractor/token_saving.py`
- Modify: `src/novel_extractor/pipeline.py`
- Test: `tests/test_prompt_budgeter.py`

- [ ] **Step 1: Write failing tests**

```python
from novel_extractor.token_saving import PromptBudgeter, PromptBudgetDecision


def test_prompt_budgeter_warns_above_warn_ratio():
    budgeter = PromptBudgeter(context_window=1000, warn_ratio=0.5, hard_ratio=0.8)

    decision = budgeter.evaluate(system_prompt="x" * 1200, user_prompt="y" * 900)

    assert decision.level == "warn"


def test_prompt_budgeter_hard_split_above_hard_ratio():
    budgeter = PromptBudgeter(context_window=1000, warn_ratio=0.5, hard_ratio=0.8, strategy="split")

    decision = budgeter.evaluate(system_prompt="x" * 2000, user_prompt="y" * 2000)

    assert decision.level == "hard"
    assert decision.action == "split"
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
pytest tests/test_prompt_budgeter.py -q
```

Expected:

```text
FAILED ... ModuleNotFoundError
```

- [ ] **Step 3: Implement budgeter**

Implementation sketch:

```python
@dataclass(frozen=True)
class PromptBudgetDecision:
    prompt_tokens_estimate: int
    context_window: int
    ratio: float
    level: str  # ok | warn | hard
    action: str # continue | split | skip | summarize


class PromptBudgeter:
    def evaluate(self, system_prompt: str, user_prompt: str) -> PromptBudgetDecision:
        tokens = estimate_tokens(system_prompt) + estimate_tokens(user_prompt)
        ratio = tokens / self.context_window if self.context_window else 0
        ...
```

Token estimator:
- Use `max((len(text) + 3) // 4, cjk_rune_count(text))`.
- This mirrors Reasonix `estimateTextTokens()` design.

- [ ] **Step 4: Wire into pipeline**

Before model call:
- Evaluate `system_prompt + user_prompt`.
- `ok`: continue.
- `warn`: reporter prints warning, continue.
- `hard + split`: raise a typed `PromptBudgetExceeded` for this task version, then mark group failed with actionable message. Actual auto-splitting is a later runtime feature; this plan first adds the budget boundary and diagnostics.
- `hard + skip`: mark skipped/failed based on config.
- `hard + summarize`: reject unless `token_saving.prompt_budget.allow_summarize_chapters = true`.

- [ ] **Step 5: Verify GREEN**

Run:

```powershell
pytest tests/test_prompt_budgeter.py tests/test_pipeline_reasonix_flow.py -q
```

Expected:

```text
passed
```

---

## 8. Task 6: Existing Snippet Retrieval as Synthesis Cache

**Files:**
- Modify: `src/novel_extractor/doc_index.py`
- Modify: `src/novel_extractor/pipeline.py`
- Test: `tests/test_doc_index_snippets.py`

- [ ] **Step 1: Write failing snippet retrieval tests**

```python
from novel_extractor.doc_index import find_relevant_snippets


def test_find_relevant_snippets_limits_per_file_chars(tmp_path):
    doc = tmp_path / "丹药分析.md"
    doc.write_text("# 抽髓丸\n" + "甲" * 5000 + "\n# 清灵散\n乙", encoding="utf-8")

    snippets = find_relevant_snippets(tmp_path, ["丹药分析.md"], query_text="抽髓丸", max_chars=200)

    assert "抽髓丸" in snippets["丹药分析.md"]
    assert len(snippets["丹药分析.md"]) <= 220
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
pytest tests/test_doc_index_snippets.py -q
```

Expected:

```text
FAILED ... cannot import name 'find_relevant_snippets'
```

- [ ] **Step 3: Implement snippet retrieval**

Rules:
- Inputs: `output_dir`, `output_files`, `query_text`, `max_chars`.
- Search target docs by candidate names/keywords from current window.
- Return only heading-bounded snippets, capped by config.
- Do not read full output docs into prompt.

- [ ] **Step 4: Wire into pipeline**

Replace:

```python
existing_snippets = {}
```

with:

```python
existing_snippets = find_relevant_snippets(
    config.paths.output_dir,
    output_files,
    context_text,
    max_chars=config.token_saving.prompt_budget.max_existing_snippet_chars,
)
```

- [ ] **Step 5: Verify GREEN**

Run:

```powershell
pytest tests/test_doc_index_snippets.py tests/test_pipeline_reasonix_flow.py -q
```

Expected:

```text
passed
```

---

## 9. Task 7: Metrics JSON and Budget Enforcement

**Files:**
- Modify: `src/novel_extractor/cli.py`
- Modify: `src/novel_extractor/progress.py`
- Modify: `src/novel_extractor/reasonix_compat/usage.py`
- Test: `tests/test_cli.py`, `tests/test_reasonix_usage.py`

- [ ] **Step 1: Write failing metrics tests**

```python
def test_cli_run_accepts_metrics_argument():
    parser = build_parser()

    args = parser.parse_args(["run", "--config", "config/novel_extractor.mvp.yaml", "--metrics", "metrics.json"])

    assert args.metrics == "metrics.json"
```

```python
def test_usage_tracker_exports_metrics_dict():
    tracker = UsageTracker()
    tracker.record(Usage(prompt_tokens=100, completion_tokens=20, total_tokens=120, cache_hit_tokens=80, cache_miss_tokens=20), DEFAULT_DEEPSEEK_PRICING)

    metrics = tracker.to_metrics()

    assert metrics["prompt_tokens"] == 100
    assert metrics["cache_hit_tokens"] == 80
    assert metrics["cost"] > 0
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
pytest tests/test_cli.py::test_cli_run_accepts_metrics_argument tests/test_reasonix_usage.py::test_usage_tracker_exports_metrics_dict -q
```

Expected:

```text
FAILED
```

- [ ] **Step 3: Implement metrics export**

Add:
- `UsageTracker.to_metrics(pricing) -> dict`
- `cmd_run()` writes JSON when `--metrics` is set.
- Include: prompt tokens, completion tokens, hit/miss, request count, cost, currency, completed/skipped/failed.

- [ ] **Step 4: Add budget checks**

Rules:
- `run_token_budget`: after each usage event, if exceeded, raise `TokenBudgetExceeded`.
- `daily_token_budget`: low priority; needs persistent dated usage ledger, implement only after run budget.

- [ ] **Step 5: Verify GREEN**

Run:

```powershell
pytest tests/test_cli.py tests/test_reasonix_usage.py -q
```

Expected:

```text
passed
```

---

## 10. Task 8: Cache Guard Regression Tests

**Files:**
- Create: `tests/test_cache_guard.py`
- Modify: `README.md`

- [ ] **Step 1: Write guard tests**

```python
def test_system_prompt_is_stable_for_same_template_order(tmp_path):
    templates = {
        "乙.md": "乙模板内容",
        "甲.md": "甲模板内容",
    }

    first = build_system_prompt(templates)
    second = build_system_prompt(dict(reversed(list(templates.items()))))

    assert capture_shape(first, [], 0).system_hash == capture_shape(second, [], 0).system_hash
```

If current implementation preserves input dict order, decide intentionally:
- Either sort templates by filename for stable prefix.
- Or document that template ordering in config is part of the cache contract.

Recommended: sort by output filename before building system prompt.

- [ ] **Step 2: Verify RED**

Run:

```powershell
pytest tests/test_cache_guard.py -q
```

Expected:

```text
FAILED if prompt order is not stable
```

- [ ] **Step 3: Stabilize prompt/template ordering**

In `build_system_prompt()`:

```python
for filename in sorted(template_texts):
    content = template_texts[filename]
```

In `pipeline.py`, build `template_texts` with sorted output filenames.

- [ ] **Step 4: Verify GREEN**

Run:

```powershell
pytest tests/test_cache_guard.py tests/test_prompts.py tests/test_pipeline_reasonix_flow.py -q
```

Expected:

```text
passed
```

---

## 11. Task 9: Optional Two-Model Isolation Contract

**Files:**
- Modify: `src/novel_extractor/config.py`
- Create: `tests/test_two_model_isolation.py`

- [ ] **Step 1: Add config-only contract test**

```python
def test_optional_planner_model_config_is_separate_from_executor():
    config = load_config(config_path_with_planner)

    assert config.token_saving.planner.enabled is True
    assert config.token_saving.planner.model_env == "DEEPSEEK_PLANNER_MODEL"
```

- [ ] **Step 2: Implement only config, not runtime**

Do not add a planner call until there is a real model-routed feature. The contract exists so future routing/QA models do not reuse executor transcript and damage cache shape.

- [ ] **Step 3: Verify**

Run:

```powershell
pytest tests/test_two_model_isolation.py tests/test_config.py -q
```

Expected:

```text
passed
```

---

## 12. Implementation Order

1. Task 1 config first, because every later mechanism must be configurable.
2. Task 2 diagnostics next, so later changes can prove whether they perturb cache shape.
3. Task 3 economy tool profile, low risk and immediately reduces tool schema.
4. Task 4 tool output budgets, reduces tool-loop prompt growth.
5. Task 5 prompt budgeter, prevents runaway prompts before adding auto-split.
6. Task 6 snippet retrieval, largest domain-specific savings after prefix cache.
7. Task 7 metrics/budget enforcement, makes savings visible and controllable.
8. Task 8 guard tests, locks in stable prefix behavior.
9. Task 9 config-only two-model isolation, leave runtime disabled until needed.

---

## 13. Acceptance Criteria

- `pytest -q` passes.
- `novel-extractor run --config config/novel_extractor.mvp.yaml --metrics <path>` writes JSON metrics.
- Verbose output shows cache hit/miss, estimated prompt tokens, and prefix change reason when it changes.
- Economy tool profile excludes `glob/ls` unless configured.
- Tool outputs obey configured line/match/char limits.
- Existing snippets are capped and targeted; no full output document is injected by default.
- Cache guard tests fail if template order/tool schema order/system prompt wording changes unexpectedly.
- No API key or model-specific secret is hardcoded in source code.

---

## 14. Risks and Decisions

- **Do not default to chapter summarization.** 小说抽取依赖原文证据，默认 summarization 会引入事实损失；超预算先拆分。
- **Do not copy MCP cache.** 当前项目没有 MCP，复制只会增加复杂度。
- **Tool profile must remain configurable.** 有些调试场景需要 `glob/ls`，不能永久删掉。
- **Cache guard should be tests, not流程口头约定。** 本项目不是 Git 仓库，PR body check 价值有限；pytest guard 更直接。
- **Cold resume prune is currently not applicable.** 没有持久 transcript 时，不实现伪功能。
