# NovelExtractor - 小说信息提取工具

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

基于 LLM 的桌面端小说世界观信息提取工具，支持章节批次、模板路由、中断续跑。

## 特性

- 🎯 **配置驱动**：桌面端参数由界面输入、项目状态和内置默认配置共同管理
- 🪟 **重叠章节批次**：支持 1-5, 5-9, 9-13 顺序处理
- 🔀 **智能路由**：关键词匹配自动选择相关模板
- 💾 **中断续跑**：SQLite 状态管理，Hash 检测避免重复
- 🔍 **去重回补**：写入前通过 Reasonix 风格 grep/read_file 查询已有文档
- 📝 **直接写文档**：模型通过 write_file/edit_file/multi_edit 修改 Markdown
- 📊 **进度报告**：实时控制台输出，包含缓存命中率、tokens 和费用
- ✅ **100% 测试**：TDD 驱动，所有模块测试通过

## 快速开始

### 安装

请参考项目构建流程启动桌面端。CLI 安装方式已移除。

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

桌面端为主入口，启动后在任务页完成配置与执行。

## 架构

### 核心模块
 
桌面端由 `@novel-extractor/*` 工作区包与主进程/渲染进程模块共同构成（配置、任务、模型、提取、模板、持久化、工具链）。

### 数据流

```
桌面端启动流程
  -> load desktop project state and defaults
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
pnpm test

# 运行桌面端测试
pnpm --filter @novel-extractor/desktop test

# 查看覆盖率
pnpm --filter @novel-extractor/desktop test -- --coverage
```

**测试结果**：使用 `pnpm test` 与桌面端专项命令验证。

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
