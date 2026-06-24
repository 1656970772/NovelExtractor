# NovelExtractor - 小说信息提取工具

[![Tests](https://img.shields.io/badge/tests-passing-brightgreen)](tests/)
[![Python](https://img.shields.io/badge/python-3.11%2B-blue)](https://www.python.org/)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

基于 LLM 的小说世界观信息自动提取工具，支持章节批次、模板路由、中断续跑。

## 特性

- 🎯 **配置驱动**：所有参数通过 YAML 配置
- 🪟 **重叠章节批次**：支持 1-5, 5-9, 9-13 顺序处理
- 🔀 **智能路由**：关键词匹配自动选择相关模板
- 💾 **中断续跑**：SQLite 状态管理，Hash 检测避免重复
- 🔍 **去重回补**：写入前通过 Reasonix 风格 grep/read_file 查询已有文档
- 📝 **直接写文档**：模型通过 write_file/edit_file/multi_edit 修改 Markdown
- 📊 **进度报告**：实时控制台输出，包含缓存命中率、tokens 和费用
- ✅ **100% 测试**：TDD 驱动，所有模块测试通过

## 快速开始

### 安装

```bash
cd E:\AI_Projects\NovelExtractor
pip install -e .
```

### 配置环境变量

```bash
# Windows PowerShell
$env:DEEPSEEK_API_KEY = "your-api-key"
$env:DEEPSEEK_BASE_URL = "https://api.deepseek.com"  # 可省略，默认就是 DeepSeek
$env:DEEPSEEK_MODEL = "deepseek-v4-flash"            # 可选：deepseek-v4-pro

# Linux/Mac
export DEEPSEEK_API_KEY="your-api-key"
export DEEPSEEK_BASE_URL="https://api.deepseek.com"
export DEEPSEEK_MODEL="deepseek-v4-flash"
```

### 使用

```bash
# 查看执行计划（不调用模型）
novel-extractor plan --config config/novel_extractor.mvp.yaml

# 执行提取任务
novel-extractor run --config config/novel_extractor.mvp.yaml

# 执行并写出机器可读 metrics
novel-extractor run --config config/novel_extractor.mvp.yaml --metrics metrics.json

# 中断后恢复
novel-extractor resume --config config/novel_extractor.mvp.yaml

# 查看任务状态
novel-extractor status --config config/novel_extractor.mvp.yaml

# 重置指定窗口
novel-extractor reset-window --config config/novel_extractor.mvp.yaml \
  --window 5-9 --group resource_group
```

## 配置示例

```yaml
novel:
  id: "凡人修仙传"
  source_path: "path/to/novel.txt"
  chapter_title_pattern: "^第[一二三四五六七八九十百千万零〇两\\d]+章"

window:
  size: 5           # 章节批次大小
  stride: 4         # 步长
  max_windows: 60   # 默认处理 60 个章节批次；null 表示全书

templates:
  - id: "pills"
    filename: "丹药分析模板.md"
    output_filename: "丹药分析.md"
    card: "丹药、药剂、药散、药汤"

token_saving:
  tool_surface:
    profile: "economy"  # economy | full
  tool_outputs:
    max_tool_result_chars: 12000
  prompt_budget:
    context_window: 1000000
    warn_ratio: 0.5
    hard_ratio: 0.8
    strategy: "split"  # split | skip | summarize
  metrics:
    run_token_budget: null
```

## 架构

### 核心模块

- **config.py** - 配置加载和验证
- **chapters.py** - 章节解析和窗口生成
- **templates.py** - 模板管理和路由
- **ledger.py** - SQLite 进度账本
- **reasonix_compat/** - Reasonix 风格工具调用、文件工具、缓存用量统计
- **prompts.py** - Prompt 构建
- **llm.py** - LLM 客户端
- **writer.py** - Markdown 写入
- **verifier.py** - 文件校验
- **pipeline.py** - 主循环
- **progress.py** - 进度报告
- **cli.py** - 命令行接口

### 数据流

```
CLI
  -> load config
  -> parse chapters
  -> build windows: 1-5, 5-9, 9-13
  -> route template groups
  -> for each window + group:
       check ledger (skip if completed)
       build prompt
       call LLM with tools
       model queries docs via grep/read_file
       model writes docs via write_file/edit_file/multi_edit
       verify
       mark completed
```

## 测试

```bash
# 运行所有测试
pytest -v

# 运行特定测试
pytest tests/test_config.py -v

# 查看覆盖率
pytest --cov=novel_extractor --cov-report=html
```

**测试结果**：使用 `pytest -q` 验证。

## 文档

- [项目实施建议报告](docs/项目实施建议报告.md) - 技术选型、风险评估、成本估算
- [实施进度报告](docs/实施进度报告.md) - 开发进度、架构亮点
- [项目完成报告](docs/项目完成报告.md) - 最终交付、使用指南

## 成本估算

### 默认验证（max_windows: 60）
- **总 tokens**: 运行时按 DeepSeek usage 实际统计
- **估算成本**: 控制台实时显示本次费用和会话费用

### 全书处理（无缓存）
- **总 tokens**: ~50,000,000
- **估算成本**: $100-200

### 全书处理（有缓存优化）
- **总 tokens**: ~20,000,000
- **估算成本**: $40-80

## 限制

- 前台执行（不支持后台）
- 单线程处理
- 字符级路由（可能误触发）
- 需要人工审查输出质量

## 下一步

1. **默认验证**：使用 `max_windows: 60`，通过控制台观察成本
2. **质量评估**：人工审查输出
3. **Prompt 调优**：根据质量调整
4. **缓存观察**：根据控制台命中率调整模板分组和批次大小
5. **全书处理**：将 `max_windows` 设为 `null`，监控成本

## 许可证

MIT

## 致谢

- 参考项目：[DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix)
- 模型：DeepSeek API
- 开发：Claude Code (Opus 4.8)
