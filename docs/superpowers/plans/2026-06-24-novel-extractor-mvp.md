# Novel Extractor MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个第一版小说拆解验证工具，按重叠章节窗口读取《凡人修仙传》，只使用 5 个指定模板进行路由、抽取、去重回补、写入和中断续跑。

**Architecture:** 程序负责批处理控制、进度账本、模板路由、目标文档索引和文件写入；大模型只负责当前章节窗口内的语义判断与回补内容生成。所有路径、窗口参数、模板名单、模板分组、模型参数和写入策略都从配置读取，避免把《凡人修仙传》或五个模板硬编码进流程。

**Tech Stack:** Python 3.11+、标准库 `argparse/sqlite3/pathlib/hashlib/dataclasses/io`、控制台进度输出、`PyYAML`、`pytest`、OpenAI-compatible chat client 用于 DeepSeek 或其他兼容模型。

---

## Scope

第一版只验证以下 5 个模板：

- `丹药分析模板.md`
- `材料分析模板.md`
- `NPC性格与代表事件模板.md`
- `势力设定模板.md`
- `事件因果链（长程因果图）模板.md`

第一版不实现完整 UI、不改 DeepSeek-Reasonix、不接入全部模板、不做并发批处理、不自动向量化检索、不做后台常驻执行。章节窗口固定支持配置化：默认窗口大小 5、步长 4，窗口序列为 `1-5`、`5-9`、`9-13`，每轮提交范围排除前置重叠章，例如 `5-9` 只提交 `6-9` 的新发现，但允许这些新章节对第 5 章已发现条目做回补。

运行生命周期必须绑定当前控制台：`run` 和 `resume` 都是前台阻塞命令，不提供 `--background`，不创建 detached process，不使用 `Start-Process`、计划任务、后台服务、守护线程或脱离父控制台的子进程。用户关闭控制台后，当前执行必须随进程一起结束，不能在后台继续读小说、调用模型或写文件。

## Current Repository Context

当前工作区 `E:\AI_Projects\NovelExtractor` 只有一个已有配置文件：

- Modify: `E:\AI_Projects\NovelExtractor\config\template_categories.yaml`

该文件已经包含全量模板分类思路。MVP 不直接扩写它，而是新增一个更小的运行配置，方便快速验证后再合并回全量分类体系。

## File Structure

- Create: `E:\AI_Projects\NovelExtractor\pyproject.toml`  
  定义 Python 包、依赖、测试命令入口。

- Create: `E:\AI_Projects\NovelExtractor\config\novel_extractor.mvp.yaml`  
  MVP 运行配置：小说路径、模板目录、目标目录、窗口参数、5 个模板、模板分组、模型参数、状态库路径。

- Create: `E:\AI_Projects\NovelExtractor\src\novel_extractor\__init__.py`  
  包版本。

- Create: `E:\AI_Projects\NovelExtractor\src\novel_extractor\config.py`  
  读取和校验 YAML 配置，提供 `ExtractorConfig`、`TemplateConfig`、`TemplateGroupConfig`。

- Create: `E:\AI_Projects\NovelExtractor\src\novel_extractor\chapters.py`  
  解析小说章节，生成重叠窗口和提交章节范围。

- Create: `E:\AI_Projects\NovelExtractor\src\novel_extractor\templates.py`  
  读取模板文件，生成模板卡片，按配置分组。

- Create: `E:\AI_Projects\NovelExtractor\src\novel_extractor\ledger.py`  
  SQLite 进度账本，记录 `(novel_id, window_id, template_group_id)` 的状态、章节 hash、模板 hash、写入 hash。

- Create: `E:\AI_Projects\NovelExtractor\src\novel_extractor\doc_index.py`  
  目标文档索引，按标题和候选实体名查找已有片段，用于同名去重与回补判断。

- Create: `E:\AI_Projects\NovelExtractor\src\novel_extractor\prompts.py`  
  组装路由 prompt 和抽取 prompt。业务输出要求是 Markdown，不要求模型输出业务 JSON。

- Create: `E:\AI_Projects\NovelExtractor\src\novel_extractor\llm.py`  
  OpenAI-compatible 客户端封装，支持 DeepSeek API 地址、模型名、温度、超时、重试。

- Create: `E:\AI_Projects\NovelExtractor\src\novel_extractor\writer.py`  
  将模型返回的 Markdown 更新块写入目标文档，按模板名去掉 `模板` 生成输出文件名。

- Create: `E:\AI_Projects\NovelExtractor\src\novel_extractor\verifier.py`  
  校验目标文件存在、非空、包含模板标题或已有标题、写入后 hash 变化合理。

- Create: `E:\AI_Projects\NovelExtractor\src\novel_extractor\pipeline.py`  
  MVP 主循环：读窗口、路由模板组、读完整模板、查已有片段、调用模型、写入、校验、checkpoint。

- Create: `E:\AI_Projects\NovelExtractor\src\novel_extractor\progress.py`  
  控制台进度输出：展示总章节数、窗口进度、模板组状态、跳过原因、模型调用、写入文件、校验结果和失败原因。

- Create: `E:\AI_Projects\NovelExtractor\src\novel_extractor\cli.py`  
  命令行入口：`plan`、`run`、`resume`、`status`、`reset-window`，并支持 `--quiet`、`--verbose` 控制进度输出。

- Create: `E:\AI_Projects\NovelExtractor\tests\test_config.py`
- Create: `E:\AI_Projects\NovelExtractor\tests\test_chapters.py`
- Create: `E:\AI_Projects\NovelExtractor\tests\test_templates.py`
- Create: `E:\AI_Projects\NovelExtractor\tests\test_ledger.py`
- Create: `E:\AI_Projects\NovelExtractor\tests\test_doc_index.py`
- Create: `E:\AI_Projects\NovelExtractor\tests\test_writer.py`
- Create: `E:\AI_Projects\NovelExtractor\tests\test_pipeline_resume.py`
- Create: `E:\AI_Projects\NovelExtractor\tests\test_progress.py`

## Data Flow

```text
CLI
  -> load config
  -> create ConsoleProgressReporter
  -> run as foreground process bound to current console
  -> parse chapters
  -> print run summary
  -> build windows: 1-5, 5-9, 9-13
  -> load template cards
  -> route template groups with cards only
  -> for each selected group:
       print window and group state
       skip if ledger says completed and hashes match
       read full templates for group
       search existing target docs by candidate names and headings
       call LLM with current chapters + full templates + existing snippets
       write Markdown updates
       verify output files
       mark completed
       print completed/skipped/failed result
```

## Configuration Design

`config\novel_extractor.mvp.yaml` should contain this exact first version:

```yaml
novel:
  id: "凡人修仙传"
  source_path: "E:/AI_Projects/CultivationWorld/docs/世界观参考/凡人修仙传/凡人修仙传.txt"
  chapter_title_pattern: "^第[一二三四五六七八九十百千万零〇两\\d]+章"

paths:
  template_dir: "E:/AI_Projects/CultivationWorld/docs/世界观参考/模板"
  output_dir: "E:/AI_Projects/CultivationWorld/docs/世界观参考/凡人修仙传"
  state_db: "E:/AI_Projects/CultivationWorld/docs/世界观参考/凡人修仙传/.novel_extractor/state.sqlite"

window:
  size: 5
  stride: 4
  max_windows: 3
  overlap_commit_policy: "exclude_leading_overlap"

llm:
  provider: "openai_compatible"
  base_url_env: "DEEPSEEK_BASE_URL"
  api_key_env: "DEEPSEEK_API_KEY"
  model_env: "DEEPSEEK_MODEL"
  default_model: "deepseek-chat"
  temperature: 0.2
  timeout_seconds: 120
  max_retries: 2

templates:
  - id: "pills"
    filename: "丹药分析模板.md"
    output_filename: "丹药分析.md"
    card: "丹药、药剂、药散、药汤、毒丹、禁丹、灵液；重点记录名称、功效、用途、丹方、来源、限制副作用、适用境界。"
  - id: "materials"
    filename: "材料分析模板.md"
    output_filename: "材料分析.md"
    card: "材料、资源、灵草、矿石、药材、灵液、产出源；重点记录名称、效果、用途、来源、适用境界。"
  - id: "npc_traits"
    filename: "NPC性格与代表事件模板.md"
    output_filename: "NPC性格与代表事件.md"
    card: "角色性格、行为选择、代表事件、性格变化；必须由具体事件支撑，不只写形容词。"
  - id: "factions"
    filename: "势力设定模板.md"
    output_filename: "势力设定.md"
    card: "宗门、家族、组织、势力区域、组织结构、资源基础、制度规则、对外关系、历史变化。"
  - id: "long_causality"
    filename: "事件因果链（长程因果图）模板.md"
    output_filename: "事件因果链（长程因果图）.md"
    card: "跨章节、跨地点、跨势力的长程因果链；关注起点、传播、升级、转移、余波和二次触发。"

template_groups:
  - id: "resource_group"
    template_ids: ["pills", "materials"]
    max_full_templates_per_call: 2
  - id: "npc_group"
    template_ids: ["npc_traits"]
    max_full_templates_per_call: 1
  - id: "faction_group"
    template_ids: ["factions"]
    max_full_templates_per_call: 1
  - id: "causality_group"
    template_ids: ["long_causality"]
    max_full_templates_per_call: 1

write_policy:
  require_chapter_evidence: true
  skip_empty_model_updates: true
  create_missing_output_file: true
  backup_before_write: true

console:
  progress: true
  verbose: false
  show_skipped: true
```

## Task 1: Project Skeleton And Config Loader

**Files:**
- Create: `E:\AI_Projects\NovelExtractor\pyproject.toml`
- Create: `E:\AI_Projects\NovelExtractor\config\novel_extractor.mvp.yaml`
- Create: `E:\AI_Projects\NovelExtractor\src\novel_extractor\__init__.py`
- Create: `E:\AI_Projects\NovelExtractor\src\novel_extractor\config.py`
- Create: `E:\AI_Projects\NovelExtractor\tests\test_config.py`

- [ ] **Step 1: Create failing config tests**

Write `tests\test_config.py`:

```python
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
  default_model: "deepseek-chat"
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
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; py -3 -m pytest tests/test_config.py -v
```

Expected: import failure because `novel_extractor.config` does not exist.

- [ ] **Step 3: Create package config implementation**

Create `pyproject.toml`:

```toml
[project]
name = "novel-extractor"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
  "PyYAML>=6.0.1",
  "openai>=1.0.0",
]

[project.optional-dependencies]
dev = [
  "pytest>=8.0.0",
]

[project.scripts]
novel-extractor = "novel_extractor.cli:main"

[tool.pytest.ini_options]
pythonpath = ["src"]
testpaths = ["tests"]
```

Create `src\novel_extractor\__init__.py`:

```python
__version__ = "0.1.0"
```

Create `src\novel_extractor\config.py` with dataclasses for `NovelConfig`, `PathsConfig`, `WindowConfig`, `LLMConfig`, `TemplateConfig`, `TemplateGroupConfig`, `WritePolicyConfig`, `ConsoleConfig`, and `ExtractorConfig`. Implement this public function:

```python
def load_config(path: Path) -> ExtractorConfig
```

The loader must:

- Load UTF-8 YAML.
- Convert path strings to `Path`.
- Preserve template ids and filenames exactly.
- Build `template_by_id(template_id: str) -> TemplateConfig`.
- Validate all `template_groups[].template_ids` exist.
- Validate `window.size >= 1`, `window.stride >= 1`, and `window.stride <= window.size`.
- Default missing `console` config to `progress=True`, `verbose=False`, `show_skipped=True`.

- [ ] **Step 4: Run config tests**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; py -3 -m pytest tests/test_config.py -v
```

Expected: both tests pass.

## Task 2: Chapter Parser And Overlap Windows

**Files:**
- Create: `E:\AI_Projects\NovelExtractor\src\novel_extractor\chapters.py`
- Create: `E:\AI_Projects\NovelExtractor\tests\test_chapters.py`

- [ ] **Step 1: Create failing chapter tests**

Write `tests\test_chapters.py`:

```python
from novel_extractor.chapters import Chapter, build_windows, parse_chapters


def test_parse_chapters_by_title_pattern():
    text = """第1章 七玄门
韩立来到山下。
第2章 入门
墨大夫出现。
第3章 药园
韩立开始照看药草。
"""

    chapters = parse_chapters(text, r"^第[一二三四五六七八九十百千万零〇两\d]+章")

    assert [chapter.number for chapter in chapters] == [1, 2, 3]
    assert chapters[0].title == "第1章 七玄门"
    assert "韩立来到山下" in chapters[0].body


def test_build_windows_uses_size_five_stride_four_and_excludes_overlap():
    chapters = [Chapter(number=i, title=f"第{i}章", body=f"正文{i}") for i in range(1, 14)]

    windows = build_windows(chapters, size=5, stride=4, max_windows=3)

    assert [(w.start, w.end) for w in windows] == [(1, 5), (5, 9), (9, 13)]
    assert [chapter.number for chapter in windows[0].context_chapters] == [1, 2, 3, 4, 5]
    assert [chapter.number for chapter in windows[0].commit_chapters] == [1, 2, 3, 4, 5]
    assert [chapter.number for chapter in windows[1].context_chapters] == [5, 6, 7, 8, 9]
    assert [chapter.number for chapter in windows[1].commit_chapters] == [6, 7, 8, 9]
    assert [chapter.number for chapter in windows[2].commit_chapters] == [10, 11, 12, 13]
```

- [ ] **Step 2: Run chapter tests and verify failure**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; py -3 -m pytest tests/test_chapters.py -v
```

Expected: import failure because `novel_extractor.chapters` does not exist.

- [ ] **Step 3: Implement chapter parser**

Implement `Chapter` and `ChapterWindow` dataclasses:

```python
@dataclass(frozen=True)
class Chapter:
    number: int
    title: str
    body: str


@dataclass(frozen=True)
class ChapterWindow:
    window_id: str
    start: int
    end: int
    context_chapters: list[Chapter]
    commit_chapters: list[Chapter]
```

Implementation rules:

- `parse_chapters` splits on title lines matched by configured regex.
- Arabic numbers are parsed directly.
- Chinese chapter numbers can initially support the common numerals used by the target source; tests must include Arabic numbers first.
- `build_windows` uses list position, not chapter number arithmetic, so missing chapter numbers do not break the loop.
- For every window after the first, `commit_chapters` excludes the first context chapter.

- [ ] **Step 4: Run chapter tests**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; py -3 -m pytest tests/test_chapters.py -v
```

Expected: both tests pass.

## Task 3: Template Catalog And MVP Routing

**Files:**
- Create: `E:\AI_Projects\NovelExtractor\src\novel_extractor\templates.py`
- Create: `E:\AI_Projects\NovelExtractor\tests\test_templates.py`

- [ ] **Step 1: Create failing template tests**

Write `tests\test_templates.py`:

```python
from pathlib import Path

from novel_extractor.config import TemplateConfig, TemplateGroupConfig
from novel_extractor.templates import TemplateCatalog, route_groups_by_cards


def test_template_catalog_reads_full_template(tmp_path):
    template_dir = tmp_path / "templates"
    template_dir.mkdir()
    (template_dir / "丹药分析模板.md").write_text("# 丹药分析模板\n\n字段要求", encoding="utf-8")

    catalog = TemplateCatalog(
        template_dir=template_dir,
        templates=[
            TemplateConfig(
                id="pills",
                filename="丹药分析模板.md",
                output_filename="丹药分析.md",
                card="丹药、药丸、药汤",
            )
        ],
    )

    assert catalog.read_template("pills").startswith("# 丹药分析模板")
    assert catalog.card_text() == "pills: 丹药、药丸、药汤"


def test_route_groups_by_cards_selects_relevant_groups():
    groups = [
        TemplateGroupConfig(id="resource_group", template_ids=["pills", "materials"], max_full_templates_per_call=2),
        TemplateGroupConfig(id="faction_group", template_ids=["factions"], max_full_templates_per_call=1),
    ]
    cards = {
        "pills": "丹药、药丸、药汤",
        "materials": "材料、药材、灵草",
        "factions": "宗门、家族、势力",
    }

    selected = route_groups_by_cards("墨大夫给厉飞雨服用抽髓丸，药性凶险。", groups, cards)

    assert [group.id for group in selected] == ["resource_group"]
```

- [ ] **Step 2: Run template tests and verify failure**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; py -3 -m pytest tests/test_templates.py -v
```

Expected: import failure because `novel_extractor.templates` does not exist.

- [ ] **Step 3: Implement template catalog and deterministic MVP router**

Implement this public class:

```python
class TemplateCatalog:
    def __init__(self, template_dir: Path, templates: list[TemplateConfig]) -> None

    def read_template(self, template_id: str) -> str

    def output_filename(self, template_id: str) -> str

    def card_text(self) -> str
```

Implement `route_groups_by_cards(chapter_text, groups, cards)` as a deterministic pre-router:

- Match if any token split by `、` or `，` appears in chapter text.
- Return groups in config order.
- If no group matches, return an empty list.

This deterministic router is only the MVP prefilter. The extraction prompt still includes the selected group and asks the model to skip when the match is accidental.

- [ ] **Step 4: Run template tests**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; py -3 -m pytest tests/test_templates.py -v
```

Expected: both tests pass.

## Task 4: SQLite Progress Ledger For Resume

**Files:**
- Create: `E:\AI_Projects\NovelExtractor\src\novel_extractor\ledger.py`
- Create: `E:\AI_Projects\NovelExtractor\tests\test_ledger.py`

- [ ] **Step 1: Create failing ledger tests**

Write `tests\test_ledger.py`:

```python
from novel_extractor.ledger import ProgressLedger


def test_completed_window_group_is_skipped_when_hashes_match(tmp_path):
    db_path = tmp_path / "state.sqlite"
    ledger = ProgressLedger(db_path)

    ledger.mark_completed(
        novel_id="凡人修仙传",
        window_id="1-5",
        template_group_id="resource_group",
        chapter_hash="chapter-a",
        template_hash="template-a",
        output_hash="output-a",
    )

    assert ledger.should_skip(
        novel_id="凡人修仙传",
        window_id="1-5",
        template_group_id="resource_group",
        chapter_hash="chapter-a",
        template_hash="template-a",
    )


def test_hash_change_forces_rerun(tmp_path):
    db_path = tmp_path / "state.sqlite"
    ledger = ProgressLedger(db_path)

    ledger.mark_completed("凡人修仙传", "1-5", "resource_group", "chapter-a", "template-a", "output-a")

    assert not ledger.should_skip("凡人修仙传", "1-5", "resource_group", "chapter-b", "template-a")
    assert not ledger.should_skip("凡人修仙传", "1-5", "resource_group", "chapter-a", "template-b")


def test_running_state_is_not_skipped_after_restart(tmp_path):
    db_path = tmp_path / "state.sqlite"
    ledger = ProgressLedger(db_path)

    ledger.mark_running("凡人修仙传", "5-9", "npc_group", "chapter-b", "template-b")

    assert not ledger.should_skip("凡人修仙传", "5-9", "npc_group", "chapter-b", "template-b")
    assert ledger.get_status("凡人修仙传", "5-9", "npc_group") == "running"
```

- [ ] **Step 2: Run ledger tests and verify failure**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; py -3 -m pytest tests/test_ledger.py -v
```

Expected: import failure because `novel_extractor.ledger` does not exist.

- [ ] **Step 3: Implement ledger**

Create one SQLite table:

```sql
CREATE TABLE IF NOT EXISTS template_runs (
  novel_id TEXT NOT NULL,
  window_id TEXT NOT NULL,
  template_group_id TEXT NOT NULL,
  chapter_hash TEXT NOT NULL,
  template_hash TEXT NOT NULL,
  output_hash TEXT,
  status TEXT NOT NULL,
  error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (novel_id, window_id, template_group_id)
);
```

Implement these methods:

```python
class ProgressLedger:
    def __init__(self, db_path: Path) -> None
    def mark_running(self, novel_id: str, window_id: str, template_group_id: str, chapter_hash: str, template_hash: str) -> None
    def mark_completed(self, novel_id: str, window_id: str, template_group_id: str, chapter_hash: str, template_hash: str, output_hash: str) -> None
    def mark_failed(self, novel_id: str, window_id: str, template_group_id: str, chapter_hash: str, template_hash: str, error: str) -> None
    def should_skip(self, novel_id: str, window_id: str, template_group_id: str, chapter_hash: str, template_hash: str) -> bool
    def get_status(self, novel_id: str, window_id: str, template_group_id: str) -> str | None
```

`should_skip` returns true only when status is `completed` and both hashes match.
`get_status` returns the current status for tests and `status` output; missing rows return `None`.

- [ ] **Step 4: Run ledger tests**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; py -3 -m pytest tests/test_ledger.py -v
```

Expected: all tests pass.

## Task 5: Target Document Index For Same-Name Lookup

**Files:**
- Create: `E:\AI_Projects\NovelExtractor\src\novel_extractor\doc_index.py`
- Create: `E:\AI_Projects\NovelExtractor\tests\test_doc_index.py`

- [ ] **Step 1: Create failing document index tests**

Write `tests\test_doc_index.py`:

```python
from novel_extractor.doc_index import DocumentIndex


def test_search_existing_doc_returns_matching_heading_snippet(tmp_path):
    output = tmp_path / "丹药分析.md"
    output.write_text(
        """# 《凡人修仙传》丹药分析

## 抽髓丸

功效：短期提升力量。
副作用：原文未说明。

## 药汤

功效：辅助修炼。
""",
        encoding="utf-8",
    )

    index = DocumentIndex(tmp_path)

    result = index.search("丹药分析.md", "抽髓丸")

    assert result.found
    assert result.filename == "丹药分析.md"
    assert "## 抽髓丸" in result.snippet
    assert "短期提升力量" in result.snippet
    assert "## 药汤" not in result.snippet


def test_search_missing_doc_returns_not_found(tmp_path):
    index = DocumentIndex(tmp_path)

    result = index.search("丹药分析.md", "抽髓丸")

    assert not result.found
    assert result.snippet == ""
```

- [ ] **Step 2: Run document index tests and verify failure**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; py -3 -m pytest tests/test_doc_index.py -v
```

Expected: import failure because `novel_extractor.doc_index` does not exist.

- [ ] **Step 3: Implement Markdown heading snippet search**

Implement:

```python
@dataclass(frozen=True)
class SearchResult:
    found: bool
    filename: str
    query: str
    snippet: str


class DocumentIndex:
    def __init__(self, output_dir: Path) -> None
    def search(self, filename: str, query: str) -> SearchResult
```

Search behavior:

- If file does not exist, return `found=False`.
- Prefer heading block match: a line starting with one or more `#` and containing the query.
- Return from matched heading until the next heading with same or higher level.
- If no heading match exists but plain text contains query, return 12 lines around the first match.
- If no match exists, return `found=False`.

- [ ] **Step 4: Run document index tests**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; py -3 -m pytest tests/test_doc_index.py -v
```

Expected: both tests pass.

## Task 6: Prompt Builder And Non-JSON Markdown Update Contract

**Files:**
- Create: `E:\AI_Projects\NovelExtractor\src\novel_extractor\prompts.py`
- Create: `E:\AI_Projects\NovelExtractor\tests\test_prompts.py`

- [ ] **Step 1: Create failing prompt tests**

Write `tests\test_prompts.py`:

```python
from novel_extractor.chapters import Chapter
from novel_extractor.prompts import build_extraction_prompt


def test_prompt_contains_context_and_commit_chapter_ranges():
    prompt = build_extraction_prompt(
        novel_id="凡人修仙传",
        window_id="5-9",
        context_chapters=[Chapter(5, "第5章", "旧上下文"), Chapter(6, "第6章", "新内容")],
        commit_chapters=[Chapter(6, "第6章", "新内容")],
        template_texts={"丹药分析.md": "# 丹药分析模板\n字段"},
        existing_snippets={"丹药分析.md:抽髓丸": "## 抽髓丸\n已有内容"},
    )

    assert "窗口：5-9" in prompt
    assert "上下文章节：5, 6" in prompt
    assert "本轮默认提交章节：6" in prompt
    assert "不要输出业务 JSON" in prompt
    assert "```doc-update" in prompt
```

- [ ] **Step 2: Run prompt tests and verify failure**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; py -3 -m pytest tests/test_prompts.py -v
```

Expected: import failure because `novel_extractor.prompts` does not exist.

- [ ] **Step 3: Implement prompt builder**

The extraction prompt must enforce this Markdown update contract:

````markdown
如果没有可写内容，输出：
NO_UPDATE

如果需要写入，输出一个或多个更新块：

```doc-update
文件：丹药分析.md
方式：append
原因：第 6 章出现新丹药，已有文档没有同名条目。
内容：
## 抽髓丸

功效：短期提升力量，但会带来明显代价。
证据章节：第 6 章
```
````

Prompt rules:

- 明确说明“不要输出业务 JSON”。
- 明确说明上下文章节只用于理解，默认只提交 `commit_chapters` 中的新发现。
- 允许新章节回补旧条目，但必须说明回补来自哪一章。
- 要求相同名字先参考 `existing_snippets`，完整则跳过，不完整则补充。
- 要求所有新增事实必须来自当前窗口章节，不允许凭印象补全。

- [ ] **Step 4: Run prompt tests**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; py -3 -m pytest tests/test_prompts.py -v
```

Expected: prompt test passes.

## Task 7: Writer And Verifier

**Files:**
- Create: `E:\AI_Projects\NovelExtractor\src\novel_extractor\writer.py`
- Create: `E:\AI_Projects\NovelExtractor\src\novel_extractor\verifier.py`
- Create: `E:\AI_Projects\NovelExtractor\tests\test_writer.py`

- [ ] **Step 1: Create failing writer tests**

Write `tests\test_writer.py`:

```python
from novel_extractor.verifier import verify_written_file
from novel_extractor.writer import parse_doc_updates, apply_doc_updates


def test_parse_and_append_doc_update(tmp_path):
    response = """```doc-update
文件：丹药分析.md
方式：append
原因：发现抽髓丸。
内容：
## 抽髓丸

功效：短期提升力量。
证据章节：第 6 章
```"""

    updates = parse_doc_updates(response)
    apply_doc_updates(tmp_path, updates, backup_before_write=True)

    output = tmp_path / "丹药分析.md"
    assert output.exists()
    text = output.read_text(encoding="utf-8")
    assert "## 抽髓丸" in text
    assert "证据章节：第 6 章" in text
    assert verify_written_file(output).ok


def test_no_update_response_returns_empty_updates():
    assert parse_doc_updates("NO_UPDATE") == []
```

- [ ] **Step 2: Run writer tests and verify failure**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; py -3 -m pytest tests/test_writer.py -v
```

Expected: import failure because `novel_extractor.writer` does not exist.

- [ ] **Step 3: Implement Markdown update parser and append writer**

Implement:

```python
@dataclass(frozen=True)
class DocUpdate:
    filename: str
    mode: str
    reason: str
    content: str
```

`parse_doc_updates` rules:

- Return empty list for exact `NO_UPDATE` after stripping whitespace.
- Find fenced blocks starting with ```` ```doc-update ````.
- Parse Chinese field headers `文件：`、`方式：`、`原因：`、`内容：`.
- Accept only `方式：append` in MVP.
- Raise `ValueError` if filename contains path separators or does not end with `.md`.

`apply_doc_updates` rules:

- Create output directory if missing.
- Create file if missing.
- If backup is enabled and file exists, write a sibling backup named `<filename>.bak`.
- Append content with exactly two newlines before the new block when the file is non-empty.

- [ ] **Step 4: Implement verifier**

Implement:

```python
@dataclass(frozen=True)
class VerificationResult:
    ok: bool
    reason: str


def verify_written_file(path: Path) -> VerificationResult:
    return VerificationResult(ok=True, reason="文件存在、UTF-8 可读、包含 Markdown 标题，且未残留更新块信封字段")
```

Verification rules:

- File must exist.
- File must be UTF-8 readable.
- File must contain at least one Markdown heading line beginning with `#`.
- File must not contain the literal strings `文件：` or `方式：` from the update envelope.

- [ ] **Step 5: Run writer tests**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; py -3 -m pytest tests/test_writer.py -v
```

Expected: both tests pass.

## Task 8: LLM Client With Fake Test Adapter

**Files:**
- Create: `E:\AI_Projects\NovelExtractor\src\novel_extractor\llm.py`
- Create: `E:\AI_Projects\NovelExtractor\tests\test_llm_fake.py`

- [ ] **Step 1: Create fake-client test**

Write `tests\test_llm_fake.py`:

```python
from novel_extractor.llm import FakeLLMClient


def test_fake_llm_returns_configured_response():
    client = FakeLLMClient({"窗口：1-5": "NO_UPDATE"})

    assert client.complete("窗口：1-5\n正文") == "NO_UPDATE"
```

- [ ] **Step 2: Implement client protocol and fake client**

Create:

```python
class LLMClient(Protocol):
    def complete(self, prompt: str) -> str:
        raise NotImplementedError


class FakeLLMClient:
    def __init__(self, responses_by_substring: dict[str, str]) -> None
    def complete(self, prompt: str) -> str
```

Add `OpenAICompatibleClient`:

```python
class OpenAICompatibleClient:
    def __init__(self, base_url: str | None, api_key: str, model: str, temperature: float, timeout_seconds: int, max_retries: int) -> None

    def complete(self, prompt: str) -> str
```

The OpenAI-compatible client sends one user message containing the built prompt. It does not expose arbitrary file tools to the model in MVP.

- [ ] **Step 3: Run fake LLM test**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; py -3 -m pytest tests/test_llm_fake.py -v
```

Expected: test passes.

## Task 9: Pipeline Resume Loop

**Files:**
- Create: `E:\AI_Projects\NovelExtractor\src\novel_extractor\pipeline.py`
- Create: `E:\AI_Projects\NovelExtractor\tests\test_pipeline_resume.py`

- [ ] **Step 1: Create pipeline resume test**

Write `tests\test_pipeline_resume.py`:

```python
from pathlib import Path

import pytest

from novel_extractor.config import load_config
from novel_extractor.ledger import ProgressLedger
from novel_extractor.llm import FakeLLMClient
from novel_extractor.pipeline import run_pipeline


def write_mvp_config(tmp_path: Path) -> Path:
    novel = tmp_path / "novel.txt"
    novel.write_text(
        """第1章 开端
韩立进入七玄门。
第2章 药物
墨大夫拿出药汤。
第3章 观察
韩立谨慎观察。
第4章 组织
七玄门内有多个堂口。
第5章 后果
药物影响继续。
""",
        encoding="utf-8",
    )
    template_dir = tmp_path / "templates"
    template_dir.mkdir()
    for filename in ["丹药分析模板.md", "材料分析模板.md", "NPC性格与代表事件模板.md", "势力设定模板.md", "事件因果链（长程因果图）模板.md"]:
        (template_dir / filename).write_text(f"# {filename}\n字段", encoding="utf-8")
    output_dir = tmp_path / "out"
    config_file = tmp_path / "config.yaml"
    config_file.write_text(
        f"""
novel:
  id: "凡人修仙传"
  source_path: "{novel.as_posix()}"
  chapter_title_pattern: "^第[一二三四五六七八九十百千万零〇两\\\\d]+章"
paths:
  template_dir: "{template_dir.as_posix()}"
  output_dir: "{output_dir.as_posix()}"
  state_db: "{(tmp_path / "state.sqlite").as_posix()}"
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
  default_model: "deepseek-chat"
  temperature: 0.2
  timeout_seconds: 120
  max_retries: 2
templates:
  - id: "pills"
    filename: "丹药分析模板.md"
    output_filename: "丹药分析.md"
    card: "丹药、药物、药汤"
  - id: "materials"
    filename: "材料分析模板.md"
    output_filename: "材料分析.md"
    card: "材料、药材"
  - id: "npc_traits"
    filename: "NPC性格与代表事件模板.md"
    output_filename: "NPC性格与代表事件.md"
    card: "性格、谨慎、行为"
  - id: "factions"
    filename: "势力设定模板.md"
    output_filename: "势力设定.md"
    card: "门派、堂口、势力"
  - id: "long_causality"
    filename: "事件因果链（长程因果图）模板.md"
    output_filename: "事件因果链（长程因果图）.md"
    card: "后果、影响、因果"
template_groups:
  - id: "resource_group"
    template_ids: ["pills", "materials"]
    max_full_templates_per_call: 2
  - id: "npc_group"
    template_ids: ["npc_traits"]
    max_full_templates_per_call: 1
  - id: "faction_group"
    template_ids: ["factions"]
    max_full_templates_per_call: 1
  - id: "causality_group"
    template_ids: ["long_causality"]
    max_full_templates_per_call: 1
write_policy:
  require_chapter_evidence: true
  skip_empty_model_updates: true
  create_missing_output_file: true
  backup_before_write: true
""",
        encoding="utf-8",
    )
    return config_file


def test_pipeline_skips_completed_window_group_on_second_run(tmp_path):
    config = load_config(write_mvp_config(tmp_path))
    response = """```doc-update
文件：丹药分析.md
方式：append
原因：第 2 章出现药汤。
内容：
## 药汤

功效：原文未说明。
证据章节：第 2 章
```"""
    client = FakeLLMClient({"resource_group": response, "npc_group": "NO_UPDATE", "faction_group": "NO_UPDATE", "causality_group": "NO_UPDATE"})

    first = run_pipeline(config, client)
    second = run_pipeline(config, client)

    assert first.completed_count >= 1
    assert second.skipped_count >= 1
    assert (config.paths.output_dir / "丹药分析.md").exists()


class InterruptingLLMClient:
    def complete(self, prompt: str) -> str:
        raise KeyboardInterrupt


def test_pipeline_marks_current_group_interrupted_on_keyboard_interrupt(tmp_path):
    config = load_config(write_mvp_config(tmp_path))

    with pytest.raises(KeyboardInterrupt):
        run_pipeline(config, InterruptingLLMClient())

    ledger = ProgressLedger(config.paths.state_db)
    assert ledger.get_status("凡人修仙传", "1-5", "resource_group") == "failed"
```

- [ ] **Step 2: Implement pipeline**

Implement:

```python
@dataclass(frozen=True)
class PipelineResult:
    completed_count: int
    skipped_count: int
    failed_count: int


def run_pipeline(config: ExtractorConfig, llm_client: LLMClient, reporter: ProgressReporter | None = None) -> PipelineResult:
    return PipelineResult(completed_count=completed_count, skipped_count=skipped_count, failed_count=failed_count)
```

Pipeline rules:

- Read novel source as UTF-8.
- Parse chapters and build windows.
- Use `NullProgressReporter` when `reporter is None`.
- Call `reporter.start_run` after chapters and windows are known.
- For each window, concatenate context chapter text.
- Call `reporter.start_window` before routing each window.
- Route groups by template cards.
- Call `reporter.routed_groups` after routing.
- Compute `chapter_hash` from context chapter titles and bodies.
- Compute `template_hash` from full template texts in the selected group.
- Use ledger `should_skip` before model call.
- Call `reporter.group_skipped` when ledger skips a completed group.
- Mark running before model call.
- Call `reporter.group_running` before model call.
- Keep execution in the foreground process. Do not spawn detached workers, daemon threads, background subprocesses, scheduled jobs, or service processes.
- Build prompt with context chapters, commit chapters, full template texts, and existing snippets.
- Existing snippets for MVP can search candidate names by scanning Markdown headings in model-visible chapter text using a conservative regex for Chinese names ending with common suffixes such as `丸`、`丹`、`汤`、`门`、`派`、`堂`.
- Call `reporter.model_call` with model name, prompt character count, and existing snippet count when verbose mode is enabled.
- Parse model updates; if empty, still mark completed with output hash `no-update`.
- Apply updates and verify every touched file.
- Mark failed with error message if parsing, writing, or verification fails.
- Call `reporter.group_completed` or `reporter.group_failed` at the end of each group.
- On `KeyboardInterrupt`, mark the current running `(window, group)` as failed with error `interrupted by user`, print the failure through the reporter, then re-raise so CLI exits instead of continuing in the background.
- Closing the console may not give Python a cleanup callback on Windows; this is acceptable because the CLI never detaches. The OS terminates the foreground process and no background worker remains.

- [ ] **Step 3: Run pipeline resume test**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; py -3 -m pytest tests/test_pipeline_resume.py -v
```

Expected: test passes.

## Task 10: Console Progress Reporter

**Files:**
- Create: `E:\AI_Projects\NovelExtractor\src\novel_extractor\progress.py`
- Create: `E:\AI_Projects\NovelExtractor\tests\test_progress.py`

- [ ] **Step 1: Create progress reporter tests**

Write `tests\test_progress.py`:

```python
from io import StringIO

from novel_extractor.progress import ConsoleProgressReporter, NullProgressReporter


def test_console_progress_reporter_prints_window_and_group_status():
    stream = StringIO()
    reporter = ConsoleProgressReporter(stream=stream, enabled=True, verbose=False, show_skipped=True)

    reporter.start_run(
        novel_id="凡人修仙传",
        total_chapters=13,
        total_windows=3,
        template_count=5,
        window_size=5,
        stride=4,
        output_dir="E:/out",
    )
    reporter.start_window(index=1, total=3, window_id="1-5")
    reporter.routed_groups(["resource_group", "npc_group"])
    reporter.group_running("resource_group", ["丹药分析.md", "材料分析.md"])
    reporter.group_completed("resource_group", ["丹药分析.md"])

    text = stream.getvalue()
    assert "[NovelExtractor] 凡人修仙传" in text
    assert "[窗口 1/3] 1-5" in text
    assert "路由命中：resource_group, npc_group" in text
    assert "[resource_group] running" in text
    assert "写入：丹药分析.md" in text
    assert "状态：completed" in text


def test_console_progress_reporter_can_hide_skipped_groups():
    stream = StringIO()
    reporter = ConsoleProgressReporter(stream=stream, enabled=True, verbose=False, show_skipped=False)

    reporter.group_skipped("resource_group", "已完成且 hash 未变化")

    assert stream.getvalue() == ""


def test_null_progress_reporter_is_silent():
    reporter = NullProgressReporter()

    reporter.start_window(index=1, total=3, window_id="1-5")
    reporter.group_failed("resource_group", "模型输出无法解析")
```

- [ ] **Step 2: Run progress tests and verify failure**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; py -3 -m pytest tests/test_progress.py -v
```

Expected: import failure because `novel_extractor.progress` does not exist.

- [ ] **Step 3: Implement progress reporter**

Implement `src\novel_extractor\progress.py`:

```python
class ProgressReporter(Protocol):
    def start_run(self, novel_id: str, total_chapters: int, total_windows: int, template_count: int, window_size: int, stride: int, output_dir: str) -> None:
        raise NotImplementedError

    def start_window(self, index: int, total: int, window_id: str) -> None:
        raise NotImplementedError

    def routed_groups(self, group_ids: list[str]) -> None:
        raise NotImplementedError

    def group_running(self, group_id: str, output_files: list[str]) -> None:
        raise NotImplementedError

    def group_skipped(self, group_id: str, reason: str) -> None:
        raise NotImplementedError

    def model_call(self, model: str, prompt_chars: int, existing_snippet_count: int) -> None:
        raise NotImplementedError

    def group_completed(self, group_id: str, written_files: list[str]) -> None:
        raise NotImplementedError

    def group_failed(self, group_id: str, error: str) -> None:
        raise NotImplementedError
```

Implementation rules:

- `ConsoleProgressReporter` writes to a text stream, defaulting to `sys.stdout`.
- `enabled=False` suppresses all output.
- `verbose=False` hides `model_call`.
- `show_skipped=False` hides skipped groups.
- Output must be line-oriented plain text so Windows terminals, Codex terminal, and redirected logs all work.
- Do not use `rich`, `tqdm`, cursor rewrites, or live terminal control in MVP.

Example run output:

```text
[NovelExtractor] 凡人修仙传
配置：5 个模板，窗口 size=5 stride=4
章节：共 13 章
目标目录：E:/out

[窗口 1/3] 1-5
  路由命中：resource_group, npc_group
  [resource_group] running
    模板输出：丹药分析.md, 材料分析.md
    写入：丹药分析.md
    状态：completed
```

- [ ] **Step 4: Run progress tests**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; py -3 -m pytest tests/test_progress.py -v
```

Expected: all tests pass.

## Task 11: CLI Commands

**Files:**
- Create: `E:\AI_Projects\NovelExtractor\src\novel_extractor\cli.py`
- Create: `E:\AI_Projects\NovelExtractor\tests\test_cli.py`

- [ ] **Step 1: Create CLI smoke tests**

Write `tests\test_cli.py`:

```python
import pytest

from novel_extractor.cli import build_parser


def test_cli_has_run_resume_status_commands():
    parser = build_parser()

    commands = parser._subparsers._group_actions[0].choices

    assert "run" in commands
    assert "resume" in commands
    assert "status" in commands
    assert "plan" in commands


def test_run_command_accepts_quiet_and_verbose_progress_flags():
    parser = build_parser()

    quiet_args = parser.parse_args(["run", "--config", "config/novel_extractor.mvp.yaml", "--quiet"])
    verbose_args = parser.parse_args(["resume", "--config", "config/novel_extractor.mvp.yaml", "--verbose"])

    assert quiet_args.quiet is True
    assert quiet_args.verbose is False
    assert verbose_args.verbose is True
    assert verbose_args.quiet is False


def test_run_command_rejects_background_flag():
    parser = build_parser()

    with pytest.raises(SystemExit):
        parser.parse_args(["run", "--config", "config/novel_extractor.mvp.yaml", "--background"])
```

- [ ] **Step 2: Implement CLI parser**

Implement commands:

```text
novel-extractor plan --config config/novel_extractor.mvp.yaml
novel-extractor run --config config/novel_extractor.mvp.yaml
novel-extractor resume --config config/novel_extractor.mvp.yaml
novel-extractor status --config config/novel_extractor.mvp.yaml
novel-extractor reset-window --config config/novel_extractor.mvp.yaml --window 5-9 --group resource_group
novel-extractor run --config config/novel_extractor.mvp.yaml --quiet
novel-extractor resume --config config/novel_extractor.mvp.yaml --verbose
```

Command behavior:

- `plan`: print planned windows and selected templates without calling the model.
- `run`: execute from the first pending window group and print progress by default.
- `resume`: same as `run`, but print a resume summary before execution.
- `status`: print counts by status from SQLite.
- `reset-window`: mark a specific `(window, group)` as failed with reason `manual reset`, forcing rerun.
- `--quiet`: suppress progress output except final error messages.
- `--verbose`: include model name, prompt character count, hash prefixes, and existing snippet count.
- `--background` must not exist. Running in the background is deliberately unsupported.

CLI construction rules:

- Build `ConsoleProgressReporter(enabled=not args.quiet, verbose=args.verbose, show_skipped=config.console.show_skipped)`.
- Pass the reporter into `run_pipeline(config, llm_client, reporter)`.
- `status` must read SQLite directly and print a summary even when no model call is made.
- Do not call `Start-Process`, `subprocess.Popen` with detached flags, `multiprocessing`, `threading.Thread` for background execution, Windows services, scheduled tasks, or shell job-control commands.
- Let `KeyboardInterrupt` exit with code `130` after pipeline has recorded the current group as interrupted.

- [ ] **Step 3: Run CLI test**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; py -3 -m pytest tests/test_cli.py -v
```

Expected: all CLI tests pass.

## Task 12: Real-Path Dry Run For The Five Templates

**Files:**
- Use: `E:\AI_Projects\NovelExtractor\config\novel_extractor.mvp.yaml`
- Use: `E:\AI_Projects\CultivationWorld\docs\世界观参考\凡人修仙传\凡人修仙传.txt`
- Use: `E:\AI_Projects\CultivationWorld\docs\世界观参考\模板\*.md`

- [ ] **Step 1: Install package in editable mode**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; py -3 -m pip install -e "E:\AI_Projects\NovelExtractor[dev]"
```

Expected: package installs without errors.

- [ ] **Step 2: Run unit tests**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; py -3 -m pytest -v
```

Expected: all tests pass.

- [ ] **Step 3: Print execution plan without model calls**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; novel-extractor plan --config "E:\AI_Projects\NovelExtractor\config\novel_extractor.mvp.yaml"
```

Expected output includes:

```text
Novel: 凡人修仙传
Window size: 5
Stride: 4
Templates: 丹药分析模板.md, 材料分析模板.md, NPC性格与代表事件模板.md, 势力设定模板.md, 事件因果链（长程因果图）模板.md
First windows: 1-5, 5-9, 9-13
```

- [ ] **Step 4: Run one real MVP pass**

Before running, set model environment variables:

```powershell
$env:DEEPSEEK_API_KEY = Read-Host "DeepSeek API Key"
$env:DEEPSEEK_BASE_URL = "https://api.deepseek.com"
$env:DEEPSEEK_MODEL = "deepseek-chat"
```

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; novel-extractor run --config "E:\AI_Projects\NovelExtractor\config\novel_extractor.mvp.yaml"
```

Expected:

- Creates or updates files under `E:\AI_Projects\CultivationWorld\docs\世界观参考\凡人修仙传`.
- Creates SQLite state file under `E:\AI_Projects\CultivationWorld\docs\世界观参考\凡人修仙传\.novel_extractor\state.sqlite`.
- Marks completed `(window, group)` records.
- Console shows `[NovelExtractor]` run summary, `[窗口 当前/总数]` progress, each template group status, written files, skipped groups, and failures when present.
- The command occupies the current console until it finishes or is interrupted. There is no background job, detached child process, service, scheduled task, or hidden worker continuing after the console closes.

- [ ] **Step 5: Run resume immediately**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; novel-extractor resume --config "E:\AI_Projects\NovelExtractor\config\novel_extractor.mvp.yaml"
```

Expected: already completed window groups are skipped when chapter and template hashes match.

## Architecture Review Checklist

- [x] 通用架构：章节读取、模板目录、输出目录、模型配置、窗口策略和模板分组均通过配置传入。
- [x] 设计模式适配：使用 Pipeline 控制流程，Repository-like `ProgressLedger` 管理状态，Catalog 管理模板，Index 管理已有文档检索，Client Protocol 隔离模型供应商。
- [x] 配置化覆盖范围：路径、章节标题正则、窗口大小、步长、最大窗口数、模板名单、模板卡片、模板分组、模型环境变量、写入策略都配置化。
- [x] 简单优先：MVP 不做 UI、不做全模板、不做向量库、不做并发、不暴露任意 shell 工具。
- [x] 中断续跑：SQLite 以 `(novel_id, window_id, template_group_id)` 为粒度记录状态，hash 未变时跳过已完成任务。
- [x] 去重回补：工具侧只检索已有文档片段，模型侧判断是否完整、是否需要回补。
- [x] 模板复杂度控制：路由阶段使用模板卡片，抽取阶段只发送命中的完整模板组。
- [x] 非业务 JSON：模型业务输出采用 Markdown 更新块，解析失败则标记当前窗口组失败，支持重跑。
- [x] 控制台进度：`ConsoleProgressReporter` 默认打印运行摘要、窗口进度、模板组状态、写入结果、跳过原因和失败原因；`--quiet` 可关闭，`--verbose` 可显示调试细节。
- [x] 前台生命周期：`run` / `resume` 不支持后台执行，不创建 detached worker；Ctrl+C 标记当前组为 interrupted 后退出，关闭控制台后不会继续后台执行。

## Verification Before Completion

最终完成第一版实现后必须运行：

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; py -3 -m pytest -v
```

并至少运行一次：

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; novel-extractor plan --config "E:\AI_Projects\NovelExtractor\config\novel_extractor.mvp.yaml"
```

如果执行真实模型调用，还必须运行一次 `resume` 并确认已完成记录被跳过。

真实模型调用时还必须确认控制台出现类似输出：

```text
[NovelExtractor] 凡人修仙传
[窗口 1/3] 1-5
  路由命中：resource_group
  [resource_group] running
    状态：completed
```

还必须人工验证一次中断行为：

```text
1. 启动 novel-extractor run。
2. 在模型调用或窗口处理中按 Ctrl+C。
3. 进程退出，不继续处理后续窗口。
4. novel-extractor status 能看到当前窗口组为 failed，错误原因包含 interrupted by user。
5. 不存在继续增长的目标 Markdown 文件或仍在调用模型的后台进程。
```

## Execution Options

Plan complete and saved to `docs/superpowers/plans/2026-06-24-novel-extractor-mvp.md`. Two execution options:

**1. Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints.
