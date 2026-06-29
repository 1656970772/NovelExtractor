# 桌面应用 P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 NovelExtractor P0 Windows 桌面闭环：可安装 Electron + React 应用能创建项目、配置 DeepSeek 或自定义 OpenAI-compatible 模型、上传并分章 `.txt` 小说、运行单个提取任务、写入并预览 Markdown 报告、展示关系图谱占位页，并保证日志与密钥脱敏。

**Architecture:** 采用 TypeScript monorepo，Electron Main 只负责桌面壳、文件系统权限、窗口和 IPC；Renderer 负责 React 工作台 UI；领域模型、配置 schema、LLM provider registry、工具 registry、任务 runtime、持久化 adapter 拆成独立 packages。业务逻辑通过端口与适配器、repository、service/command、event bus、registry 和 schema driven config 组织，避免把供应商、模型、模板、任务状态、菜单项、视觉 token 写死在业务逻辑里。

**Tech Stack:** Electron、React、TypeScript、Vite、pnpm workspace、Vitest、React Testing Library、Playwright、SQLite、Zod、OpenAI-compatible HTTP adapter、iconv-lite、marked、DOMPurify、electron-builder。当前 Python CLI 只作为现有测试基线修复对象；P0 桌面端核心能力用 TypeScript 新实现。

---

## 执行边界

本计划只覆盖 P0。P1/P2 能力不进入 P0 完成标准，包括多供应商预设全集、模型拉取增强、任务队列增强、意外退出恢复、失败窗口跳过继续、日志清理入口、卡片资产、关系图谱生成和无限画布。

主 agent 只做分配、检查和验收：

- 每个开发任务分配给一个 fresh worker。
- 每个任务完成后分配给独立 reviewer。
- reviewer 若发现问题，必须把复现命令、实际输出、期望输出、临时 probe 和相关日志交给新的 repair worker。
- repair worker 必须先复现 reviewer 给出的失败，再把 probe 转成 RED 测试，确认失败后做最小修复。
- 主 agent 最终独立运行关键验收命令、检查 diff 和工作树状态后才声明 P0 阶段完成。

所有命令在 Windows PowerShell 执行，保留 UTF-8 前缀：

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; <command>
```

路径均相对 `E:\AI_Projects\NovelExtractor`。执行 worker 开始每个任务前先运行：

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; git -c core.quotePath=false status --short
```

预期输出：只允许出现与当前任务相关的新增或修改；若看到无关并行改动，worker 记录并避开，不覆盖。

## 文件结构

P0 预计创建或修改的文件职责如下，实施时按任务逐步落地。

```text
package.json                                      根脚本、workspace 脚本、Node 版本约束
pnpm-workspace.yaml                               monorepo 包范围
tsconfig.base.json                                TypeScript 公共配置
vitest.workspace.ts                               Vitest workspace 配置

apps/desktop/
  package.json                                    Electron 桌面端依赖和脚本
  electron-builder.yml                            Windows 安装包配置
  index.html                                      Renderer 入口 HTML
  electron.vite.config.ts                         Electron/Vite 构建配置
  src/main/main.ts                                Electron Main 入口、窗口、菜单、IPC 绑定
  src/main/ipc.ts                                 IPC 路由组合
  src/main/appPaths.ts                            应用数据目录和工作区根目录 adapter
  src/main/credentials.ts                         系统凭据 adapter
  src/preload/index.ts                            安全 preload API
  src/renderer/App.tsx                            React 根组件和路由
  src/renderer/features/project/                  首次项目创建 UI
  src/renderer/features/assets/                   资产页和 Markdown 报告预览
  src/renderer/features/extraction/               小说提取页、上传、任务列表
  src/renderer/features/providers/                大模型配置弹窗
  src/renderer/features/graph/                    关系图谱占位页
  src/renderer/styles/tokens.css                  视觉 token 映射
  src/renderer/styles/app.css                     桌面工作台布局样式
  src/renderer/test/                              Renderer 测试工具和 fixtures

packages/config/
  src/schema.ts                                   配置 schema 和解析入口
  src/defaults.ts                                 默认策略读取，不含业务硬编码
  src/providerPresets.ts                          Provider preset registry
  src/taskStatus.ts                               任务状态和可执行操作映射
  src/menu.ts                                     用户下拉、主导航菜单配置
  src/templates.ts                                模板配置和输出文件名规则
  src/themeTokens.ts                              视觉 token schema
  src/*.test.ts                                   配置化测试

packages/domain/
  src/project.ts                                  Project、Book、Report、Chapter 领域类型
  src/job.ts                                      Job、JobStatus、JobEvent、WindowProgress 类型
  src/template.ts                                 TemplateSnapshot、TemplateSelection 类型
  src/provider.ts                                 ProviderConfig、ModelOption、ApiKeyRef 类型
  src/ports.ts                                    Repository、CredentialStore、Clock、IdGenerator 端口
  src/*.test.ts                                   纯领域规则测试

packages/persistence/
  src/sqliteProjectRepository.ts                  SQLite project repository adapter
  src/fileAssetRepository.ts                      项目资产目录 adapter
  src/safePaths.ts                                路径规范化和写入根保护
  src/*.test.ts                                   持久化和路径边界测试

packages/extraction/
  src/textEncoding.ts                             UTF-8、UTF-8 BOM、GBK、CP936 识别
  src/chapterParser.ts                            中文章节识别
  src/windowPlanner.ts                            章节窗口计划
  src/templateRouter.ts                           模板选择和报告命名
  src/*.test.ts                                   上传、分章、窗口、模板测试

packages/llm/
  src/providerRegistry.ts                         Provider registry
  src/openAiCompatibleClient.ts                   OpenAI-compatible adapter
  src/deepseekAdapter.ts                          DeepSeek preset 到通用协议的 adapter
  src/redaction.ts                                密钥、Header、凭据字段脱敏
  src/*.test.ts                                   provider、模型引用、脱敏测试

packages/tools/
  src/toolRegistry.ts                             工具 registry 和 schema 组装
  src/builtinFileTools.ts                         ls/read_file/grep/write_file/edit_file/multi_edit
  src/toolPolicy.ts                               读写顺序和可写根策略
  src/*.test.ts                                   工具 schema、读写顺序、写入边界测试

packages/jobs/
  src/jobRuntime.ts                               单任务运行、暂停、继续、失败、删除
  src/eventBus.ts                                 job event bus
  src/runLogger.ts                                运行日志和脱敏写入
  src/commands.ts                                 create/start/pause/resume/delete command service
  src/*.test.ts                                   状态机、事件流、日志、删除测试

packages/markdown/
  src/reportWriter.ts                             Markdown 报告写入和文件名保护
  src/preview.ts                                  安全 Markdown 渲染入口
  src/*.test.ts                                   报告写入、预览安全测试

e2e/
  desktop-p0.spec.ts                              Playwright 桌面闭环
  fixtures/                                       `.txt`、模型响应、项目名 fixtures
  screenshots/                                   桌面/窄屏截图输出目录
```

## P0 完成标准

- Windows 安装包可以构建，安装后首次启动可以创建命名项目。
- 应用包含资产页、小说提取页、关系图谱占位页；关系图谱页明确显示未开放能力，不提供生成按钮。
- 右上用户下拉能打开大模型配置弹窗，P0 只支持 DeepSeek 和自定义 OpenAI-compatible 两类供应商。
- 模型配置支持 API key 引用、base URL、模型名、默认模型；密钥不进入项目目录、日志和导出文件。
- 小说提取页支持上传 `.txt`，识别 UTF-8、UTF-8 BOM、GBK、CP936，复制到项目资产目录，识别章节。
- 用户能选择模板、单次章节数、提取章节数、模型，创建并运行一个任务。
- 同一时间只运行一个任务；支持开始、窗口级暂停、继续、失败展示和删除任务记录。
- Markdown 报告写入书籍资产 `reports/` 目录，资产页只读预览。
- 日志记录任务状态、窗口进度、工具调用摘要、写入文件、错误摘要、token、费用，并对 API key、Authorization header、凭据字段脱敏。
- `pytest -q` 现有 Python 基线恢复通过，作为桌面化前的代码健康底线。

## P0 禁止进入范围

- 不实现真实登录、云同步、多语言切换。
- 不迁移旧 YAML 配置、旧 SQLite 状态、旧 Python CLI 命令参数。
- 不实现关系图谱生成、人物卡、势力卡、地点卡、事件卡、无限画布。
- 不开放 token 预算、缓存策略、日志保留策略、temperature、timeout 给用户。
- 不实现多任务并发、完整任务队列、意外退出恢复、失败窗口跳过继续。
- 不把供应商、模型、模板、任务状态、菜单项、视觉 token 写入业务逻辑常量。

---

### Task 0: 守护现有 Python 测试基线

**Worker 责任:** 确认 Python 基线保持 `99 passed`，并在任务记录中说明 `multi_edit` 工具启用/注册修复已完成；本任务只守护旧 CLI 基线，不再要求后续 worker 复现历史失败。

**Reviewer 责任:** 独立运行 Reasonix focused 子集和全量 pytest，确认旧 Python CLI 仍为绿色基线；若失败，先交回主 agent 分派基线修复，不让桌面 P0 worker 带着红色 Python 基线继续执行。

**Files:**
- Read: `src/novel_extractor/pipeline.py`
- Read: `src/novel_extractor/reasonix_compat/tool_factory.py`
- Read: `src/novel_extractor/reasonix_compat/tooling.py`
- Read: `src/novel_extractor/reasonix_compat/builtin_tools.py`
- Test: `tests/test_pipeline_reasonix_flow.py`
- Test: `tests/test_reasonix_tools.py`

- [x] **Step 1: 守护 Reasonix focused 基线**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pytest tests/test_reasonix_tools.py::test_multi_edit_is_registered_for_reasonix_tool_profiles tests/test_pipeline_reasonix_flow.py -q
```

Expected: PASS，`multi_edit` 被 registry 识别，Reasonix pipeline focused 测试保持通过。

- [x] **Step 2: 确认修复记录**

确认 `tests/test_reasonix_tools.py` 已包含以下 focused 测试，证明 `multi_edit` 进入 registry 和 tool profile：

```python
def test_multi_edit_is_registered_for_reasonix_tool_profiles():
    from novel_extractor.reasonix_compat.tool_factory import build_tool_specs

    specs = build_tool_specs(["edit_file", "grep", "multi_edit", "read_file", "write_file"])

    assert [spec.name for spec in specs] == [
        "edit_file",
        "grep",
        "multi_edit",
        "read_file",
        "write_file",
    ]
```

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pytest tests/test_reasonix_tools.py::test_multi_edit_is_registered_for_reasonix_tool_profiles -q
```

Expected: PASS。

- [x] **Step 3: 回归全量基线**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pytest -q
```

Expected: `99 passed`。

**验收命令:** 同 Step 1 和 Step 3。

---

### Task 1: 创建 TypeScript monorepo 和 Electron 桌面脚手架

**Worker 责任:** 创建最小 workspace、Electron/Vite/React 入口、统一脚本和 Windows 打包配置；不实现业务 UI。

**Reviewer 责任:** 检查没有删除 Python CLI 配置；确认脚手架命令能跑通；确认生成文件路径符合文件结构。

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.workspace.ts`
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/electron-builder.yml`
- Create: `apps/desktop/electron.vite.config.ts`
- Create: `apps/desktop/index.html`
- Create: `apps/desktop/src/main/main.ts`
- Create: `apps/desktop/src/preload/index.ts`
- Create: `apps/desktop/src/renderer/App.tsx`
- Create: `apps/desktop/src/renderer/main.tsx`
- Create: `apps/desktop/src/renderer/styles/app.css`

- [x] **Step 1: 验证脚手架前状态**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; if (Test-Path -LiteralPath '.\package.json') { Get-Content -LiteralPath '.\package.json' -Encoding UTF8 } else { 'package.json missing' }
```

Expected: 当前仓库没有根 `package.json`，或 reviewer 明确记录现有内容并要求 worker 合并而不是覆盖。

- [x] **Step 2: 创建 workspace 配置**

脚手架任务不适合单元 RED。验证标准是 package manager 能解析 workspace，并且 Electron Renderer 能渲染一行 P0 壳文本。

根 `package.json` 必须包含这些脚本键：

```json
{
  "scripts": {
    "desktop:dev": "pnpm --filter @novel-extractor/desktop dev",
    "desktop:build": "pnpm --filter @novel-extractor/desktop build",
    "desktop:dist": "pnpm --filter @novel-extractor/desktop dist",
    "test:ts": "vitest run",
    "test:e2e": "playwright test",
    "typecheck": "pnpm -r typecheck"
  }
}
```

- [x] **Step 3: 创建最小 Electron/React 入口**

Renderer 初始文本使用产品名和当前页面名，不做落地页 hero，不做营销说明。

```tsx
export function App() {
  return (
    <main className="app-shell" data-testid="desktop-shell">
      <span>NovelExtractor 桌面工作台</span>
    </main>
  );
}
```

- [x] **Step 4: 验证 workspace 和类型检查**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; corepack enable; pnpm install; pnpm typecheck
```

Expected: `pnpm install` 成功生成 lockfile，`pnpm typecheck` 退出码为 0。

- [x] **Step 5: 验证开发构建**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pnpm desktop:build
```

Expected: Electron main、preload、renderer 均构建成功，输出位于 `apps/desktop/dist/`。

**验收命令:** `pnpm typecheck` 和 `pnpm desktop:build` 均成功。

---

### Task 2: 配置 schema、默认值和 registry

**Worker 责任:** 建立 `packages/config`，把 provider、模型、模板、资产类型、任务状态、用户菜单、视觉 token 放进 schema 和默认配置，业务代码只通过读取函数访问。

**Reviewer 责任:** 搜索业务包中是否出现散落 hard-coded 配置；确认 DeepSeek 与自定义 OpenAI-compatible 是 P0 唯一可见 provider 类型；确认没有写入用户禁止的模型占位名。

**Files:**
- Create: `packages/config/package.json`
- Create: `packages/config/src/schema.ts`
- Create: `packages/config/src/defaults.ts`
- Create: `packages/config/src/providerPresets.ts`
- Create: `packages/config/src/taskStatus.ts`
- Create: `packages/config/src/menu.ts`
- Create: `packages/config/src/templates.ts`
- Create: `packages/config/src/themeTokens.ts`
- Test: `packages/config/src/providerPresets.test.ts`
- Test: `packages/config/src/templates.test.ts`
- Test: `packages/config/src/taskStatus.test.ts`
- Test: `packages/config/src/themeTokens.test.ts`

- [x] **Step 1: 写 RED 测试**

```ts
import { describe, expect, it } from "vitest";
import { getProviderPresets } from "./providerPresets";
import { getTaskStatusConfig } from "./taskStatus";
import { getBuiltInTemplates, resolveReportFileName } from "./templates";
import { getThemeTokens } from "./themeTokens";

describe("P0 config registries", () => {
  it("exposes only DeepSeek and custom OpenAI-compatible providers in P0", () => {
    const presets = getProviderPresets();
    expect(presets.map((preset) => preset.id)).toEqual(["deepseek", "custom-openai-compatible"]);
    expect(presets.every((preset) => preset.kind === "openai-compatible")).toBe(true);
  });

  it("keeps model values in provider schema instead of extraction business logic", () => {
    const presets = getProviderPresets();
    expect(presets[0]).toHaveProperty("models");
    expect(presets[0]).toHaveProperty("defaultModelPolicy");
    expect(presets[1]).toHaveProperty("allowsUserModels", true);
  });

  it("resolves report names from template config", () => {
    expect(resolveReportFileName({ name: "丹药分析模板" })).toBe("丹药分析.md");
    expect(resolveReportFileName({ name: "势力设定", outputFileName: "势力谱系.md" })).toBe("势力谱系.md");
  });

  it("loads task statuses and actions from config", () => {
    expect(getTaskStatusConfig().running.allowedActions).toEqual(["pause"]);
    expect(getTaskStatusConfig().failed.allowedActions).toEqual(["delete"]);
  });

  it("loads visual tokens without relying on component constants", () => {
    expect(getThemeTokens().color.surfacePaper).toMatch(/^#/);
    expect(getThemeTokens().motion.intensity).toBe(3);
  });
});
```

- [x] **Step 2: 运行 RED**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pnpm --filter @novel-extractor/config test
```

Expected: FAIL，原因是 `getProviderPresets`、`getTaskStatusConfig`、`getBuiltInTemplates` 或 `getThemeTokens` 尚未实现。

- [x] **Step 3: 实现 schema 与默认配置**

关键类型必须包括：

```ts
export type ProviderKind = "openai-compatible";

export interface ProviderPreset {
  id: "deepseek" | "custom-openai-compatible";
  displayName: string;
  kind: ProviderKind;
  baseUrl?: string;
  authScheme: "bearer";
  models: ModelOption[];
  defaultModelPolicy: "first-enabled" | "user-required";
  allowsUserModels: boolean;
}

export interface ModelOption {
  id: string;
  displayName: string;
  contextWindow?: number;
  supportsTools: boolean;
  supportsReasoning: boolean;
  usageMapping: "openai-compatible";
}
```

`ProviderKind = "openai-compatible"` 是 P0 跨包契约，DeepSeek preset 和自定义 OpenAI-compatible provider 都使用这个协议 kind，通过 `preset.id`、用户保存后的 `providerId` 和模型配置区分具体供应商；P0 不引入第二套协议值。DeepSeek 模型 ID 只存在 provider preset schema 或用户配置中；提取、任务、UI 组件不得直接引用具体模型字符串。DeepSeek API 兼容 OpenAI `/chat/completions` 与 `/models`，执行 worker 实现连接测试时以 provider schema 和用户填写模型为准。

- [x] **Step 4: 运行 GREEN**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pnpm --filter @novel-extractor/config test
```

Expected: PASS。

- [x] **Step 5: 配置化扫描**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; if (Get-Command rg -ErrorAction SilentlyContinue) { rg 'DeepSeek|custom-openai-compatible|丹药分析模板|running|surfacePaper' apps packages -g '*.ts' -g '*.tsx' } else { Select-String -Path '.\apps\**\*.ts','.\apps\**\*.tsx','.\packages\**\*.ts','.\packages\**\*.tsx' -Pattern 'DeepSeek|custom-openai-compatible|丹药分析模板|running|surfacePaper' }
```

Expected: 命中集中在 `packages/config`、测试文件和展示层读取配置的位置；不得在 `packages/extraction`、`packages/jobs`、`packages/llm` 业务逻辑中出现散落配置常量。

**验收命令:** `pnpm --filter @novel-extractor/config test` 成功，配置化扫描无业务逻辑硬编码。

---

### Task 3: 领域模型和端口边界

**Worker 责任:** 创建 `packages/domain`，定义 Project、Book、Chapter、TemplateSnapshot、ProviderConfig、Job、JobEvent、repository/credential 端口和纯领域规则。

**Reviewer 责任:** 确认 `domain` 不依赖 Electron、React、SQLite、文件系统、fetch；确认状态类型与 Task 2 配置一致。

**Files:**
- Create: `packages/domain/package.json`
- Create: `packages/domain/src/project.ts`
- Create: `packages/domain/src/job.ts`
- Create: `packages/domain/src/template.ts`
- Create: `packages/domain/src/provider.ts`
- Create: `packages/domain/src/ports.ts`
- Test: `packages/domain/src/job.test.ts`
- Test: `packages/domain/src/project.test.ts`

- [x] **Step 1: 写 RED 测试**

```ts
import { describe, expect, it } from "vitest";
import { canTransitionJob, createProjectSlug } from "./project";
import { makeJobEvent } from "./job";

describe("domain boundaries", () => {
  it("creates filesystem-safe project slugs without using display names as directory names", () => {
    expect(createProjectSlug("仙途：第一卷")).toMatch(/^project-[a-z0-9-]+$/);
  });

  it("enforces P0 job transitions", () => {
    expect(canTransitionJob("created", "running")).toBe(true);
    expect(canTransitionJob("running", "pause_requested")).toBe(true);
    expect(canTransitionJob("completed", "running")).toBe(false);
  });

  it("emits typed job events", () => {
    expect(makeJobEvent("job.window.completed", { jobId: "job-1", windowIndex: 0 })).toEqual({
      type: "job.window.completed",
      payload: { jobId: "job-1", windowIndex: 0 },
    });
  });
});
```

- [x] **Step 2: 运行 RED**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pnpm --filter @novel-extractor/domain test
```

Expected: FAIL，领域函数或类型尚未实现。

- [x] **Step 3: 实现领域类型**

领域类型定义位置必须稳定：

- `packages/domain/src/project.ts`：`Project`、`Book`、`Chapter`、`ReportAsset`、`createProjectSlug`。
- `packages/domain/src/provider.ts`：`ApiKeyRef`、`ProviderConfig`、`ProviderModelConfig`。
- `packages/domain/src/template.ts`：`TemplateSnapshot`。
- `packages/domain/src/job.ts`：`JobStatus`、`JobEventType`、`Job`、`JobEvent`、`canTransitionJob`、`makeJobEvent`。

核心实体类型必须包括：

```ts
export interface Project {
  id: string;
  displayName: string;
  slug: string;
  rootPath: string;
  createdAt: string;
}

export interface Book {
  id: string;
  projectId: string;
  displayName: string;
  sourceAssetId: string;
  chapterCount: number;
  createdAt: string;
}

export interface Chapter {
  id: string;
  bookId: string;
  index: number;
  title: string;
  textPath: string;
}

export interface ReportAsset {
  id: string;
  bookId: string;
  fileName: string;
  displayName: string;
  relativePath: string;
  byteSize: number;
  createdAt: string;
  updatedAt: string;
}
```

Provider 和密钥引用类型必须包括：

```ts
import type { ProviderKind } from "@novel-extractor/config";

export interface ApiKeyRef {
  id: string;
  providerConfigId: string;
}

export interface ProviderModelConfig {
  id: string;
  displayName: string;
  enabled: boolean;
  isDefault: boolean;
}

export interface ProviderConfig {
  id: string;
  presetId: "deepseek" | "custom-openai-compatible";
  displayName: string;
  kind: ProviderKind;
  baseUrl?: string;
  apiKeyRef?: ApiKeyRef;
  models: ProviderModelConfig[];
  enabled: boolean;
}
```

任务状态类型必须包括：

```ts
export type JobStatus =
  | "created"
  | "running"
  | "pause_requested"
  | "paused"
  | "failed"
  | "completed"
  | "deleted";

export type JobEventType =
  | "job.created"
  | "job.started"
  | "job.window.started"
  | "job.window.completed"
  | "job.model.call"
  | "job.tool.call"
  | "job.file.written"
  | "job.usage.updated"
  | "job.pause.requested"
  | "job.paused"
  | "job.resume.requested"
  | "job.failed"
  | "job.completed";

export interface Job {
  id: string;
  bookId: string;
  templateIds: string[];
  providerConfigId: string;
  modelId: string;
  status: JobStatus;
  progressText: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface JobEvent<TPayload extends object = Record<string, unknown>> {
  type: JobEventType;
  payload: TPayload;
  createdAt: string;
}
```

`ports.ts` 只定义接口，不引入 adapter：

```ts
export interface ProjectRepository {
  createProject(input: { displayName: string }): Promise<Project>;
  findByDisplayName(displayName: string): Promise<Project | null>;
  listReports(bookId: string): Promise<ReportAsset[]>;
}

export interface CredentialStore {
  saveApiKey(ref: ApiKeyRef, value: string): Promise<void>;
  resolveApiKey(ref: ApiKeyRef): Promise<string | null>;
}
```

- [x] **Step 4: 运行 GREEN 和依赖边界检查**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pnpm --filter @novel-extractor/domain test; if (Get-Command rg -ErrorAction SilentlyContinue) { rg 'electron|react|sqlite|fs/promises|fetch' packages/domain/src } else { Select-String -Path '.\packages\domain\src\*.ts' -Pattern 'electron|react|sqlite|fs/promises|fetch' }
```

Expected: 测试 PASS；依赖边界检查无输出。

**验收命令:** 同 Step 4。

---

### Task 4: 本地工作区、SQLite 和安全路径持久化

**Worker 责任:** 实现项目创建、项目目录、书籍资产目录、报告目录、SQLite 元数据和路径逃逸防护。

**Reviewer 责任:** 用临时目录验证同名项目不覆盖；验证 `..`、绝对路径、UNC 路径、符号链接逃逸被拒绝。

**Files:**
- Create: `packages/persistence/package.json`
- Create: `packages/persistence/src/sqliteProjectRepository.ts`
- Create: `packages/persistence/src/fileAssetRepository.ts`
- Create: `packages/persistence/src/safePaths.ts`
- Test: `packages/persistence/src/sqliteProjectRepository.test.ts`
- Test: `packages/persistence/src/fileAssetRepository.test.ts`
- Test: `packages/persistence/src/safePaths.test.ts`

- [x] **Step 1: 写 RED 测试**

```ts
import { describe, expect, it } from "vitest";
import { createSafeProjectPath } from "./safePaths";

describe("safe project paths", () => {
  it("keeps report writes inside the book reports directory", () => {
    const root = "C:/NovelExtractorData/project-a/assets/books/book-a/reports";
    expect(createSafeProjectPath(root, "丹药分析.md")).toBe(
      "C:/NovelExtractorData/project-a/assets/books/book-a/reports/丹药分析.md",
    );
  });

  it.each(["../secrets.txt", "C:/Users/me/token.txt", "\\\\server\\share\\x.md"])(
    "rejects escaping report path %s",
    (candidate) => {
      expect(() => createSafeProjectPath("C:/NovelExtractorData/project-a/assets/books/book-a/reports", candidate)).toThrow(
        /outside project reports root/,
      );
    },
  );
});
```

- [x] **Step 2: 运行 RED**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pnpm --filter @novel-extractor/persistence test
```

Expected: FAIL，safe path 和 repository 尚未实现。

- [x] **Step 3: 实现 adapter**

SQLite 表至少包含 `projects`、`books`、`chapters`、`reports`、`jobs`、`job_events`、`usage_records`。项目目录格式：

```text
<workspaceRoot>/<projectSlug>/
  .novel-studio/project.sqlite
  .novel-studio/logs/
  assets/books/<bookId>/source/original.txt
  assets/books/<bookId>/reports/
  assets/books/<bookId>/templates/
```

- [x] **Step 4: 运行 GREEN**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pnpm --filter @novel-extractor/persistence test
```

Expected: PASS。

**验收命令:** `pnpm --filter @novel-extractor/persistence test` 成功。

---

### Task 5: Electron Main、preload 和 IPC 合同

**Worker 责任:** 建立安全 preload API 和 IPC 路由，Renderer 只能通过 typed API 调用项目、模型配置、上传、任务和报告能力。

**Reviewer 责任:** 确认 `contextIsolation` 开启、`nodeIntegration` 关闭；确认 Renderer 没有直接访问 `fs`、Electron main API 或明文密钥。

**Files:**
- Modify: `apps/desktop/src/main/main.ts`
- Create: `apps/desktop/src/main/ipc.ts`
- Create: `apps/desktop/src/main/appPaths.ts`
- Create: `apps/desktop/src/main/credentials.ts`
- Create: `apps/desktop/src/shared/ipcTypes.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Create: `apps/desktop/src/preload/api.ts`
- Test: `apps/desktop/src/main/ipc.test.ts`
- Test: `apps/desktop/src/preload/api.test.ts`

- [x] **Step 1: 写 RED 测试**

```ts
import { describe, expect, it } from "vitest";
import { createIpcContract } from "./ipc";

describe("desktop IPC contract", () => {
  it("exposes only P0 channels", () => {
    expect(createIpcContract().channels).toEqual([
      "project:create",
      "project:list",
      "providers:save",
      "providers:list",
      "books:uploadTxt",
      "books:listReports",
      "jobs:create",
      "jobs:start",
      "jobs:pause",
      "jobs:resume",
      "jobs:delete",
      "reports:preview",
    ]);
  });
});
```

- [x] **Step 2: 运行 RED**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pnpm --filter @novel-extractor/desktop test -- src/main/ipc.test.ts
```

Expected: FAIL，IPC contract 未实现。

- [x] **Step 3: 实现 IPC**

IPC DTO 统一创建在 `apps/desktop/src/shared/ipcTypes.ts`，Main、preload 和 Renderer 都从这里导入，不在组件里重复定义跨进程数据形状：

```ts
import type { ProviderKind } from "@novel-extractor/config";
import type { JobStatus } from "@novel-extractor/domain";

export interface ProjectDto {
  id: string;
  displayName: string;
  slug: string;
  createdAt: string;
}

export interface SaveProviderDto {
  providerId?: string;
  presetId: "deepseek" | "custom-openai-compatible";
  displayName: string;
  kind: ProviderKind;
  baseUrl?: string;
  apiKey?: string;
  modelName: string;
  defaultModel: boolean;
  enabled: boolean;
}

export interface ProviderViewDto {
  id: string;
  presetId: "deepseek" | "custom-openai-compatible";
  displayName: string;
  kind: ProviderKind;
  baseUrl?: string;
  models: Array<{ id: string; displayName: string; enabled: boolean; isDefault: boolean }>;
  hasApiKey: boolean;
  enabled: boolean;
}

export interface UploadTxtDto {
  projectId: string;
  filePath: string;
  displayName?: string;
}

export interface BookUploadResultDto {
  bookId: string;
  displayName: string;
  sourceAssetId: string;
  fileName: string;
  byteSize: number;
  encoding: "utf-8" | "utf-8-bom" | "gbk" | "cp936";
  chapterCount: number;
}

export interface ReportDto {
  id: string;
  bookId: string;
  fileName: string;
  displayName: string;
  byteSize: number;
  createdAt: string;
  updatedAt: string;
}

export interface SafeMarkdownPreviewDto {
  reportId: string;
  html: string;
  headings: Array<{ id: string; depth: number; text: string }>;
  generatedAt: string;
}

export interface CreateJobDto {
  bookId: string;
  templateIds: string[];
  providerConfigId: string;
  modelId: string;
  singleRunChapterCount: number;
  extractionChapterCount: number;
}

export interface JobDto {
  id: string;
  bookId: string;
  status: JobStatus;
  progressText: string;
  tokenText?: string;
  failureReason?: string;
  allowedActions: Array<"start" | "pause" | "resume" | "delete">;
  createdAt: string;
  updatedAt: string;
}

export interface DeleteJobDto {
  jobId: string;
  confirm: true;
}
```

Preload 暴露：

```ts
export interface NovelExtractorDesktopApi {
  createProject(input: { displayName: string }): Promise<ProjectDto>;
  listProjects(): Promise<ProjectDto[]>;
  saveProvider(input: SaveProviderDto): Promise<void>;
  listProviders(): Promise<ProviderViewDto[]>;
  uploadTxt(input: UploadTxtDto): Promise<BookUploadResultDto>;
  listReports(input: { bookId: string }): Promise<ReportDto[]>;
  previewReport(input: { reportId: string }): Promise<SafeMarkdownPreviewDto>;
  createJob(input: CreateJobDto): Promise<JobDto>;
  startJob(input: { jobId: string }): Promise<void>;
  pauseJob(input: { jobId: string }): Promise<void>;
  resumeJob(input: { jobId: string }): Promise<void>;
  deleteJob(input: DeleteJobDto): Promise<void>;
}
```

- [x] **Step 4: 运行 GREEN 和安全扫描**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pnpm --filter @novel-extractor/desktop test -- src/main/ipc.test.ts src/preload/api.test.ts; if (Get-Command rg -ErrorAction SilentlyContinue) { rg 'nodeIntegration:\\s*true|contextIsolation:\\s*false|from \"fs\"|require\\(\"fs\"\\)' apps/desktop/src/renderer apps/desktop/src/main } else { Select-String -Path '.\apps\desktop\src\renderer\**\*.tsx','.\apps\desktop\src\renderer\**\*.ts','.\apps\desktop\src\main\**\*.ts' -Pattern 'nodeIntegration:\s*true|contextIsolation:\s*false|from "fs"|require\("fs"\)' }
```

Expected: tests PASS；安全扫描无输出。

**验收命令:** 同 Step 4。

---

### Task 6: `.txt` 上传、编码识别和分章

**Worker 责任:** 实现 UTF-8、UTF-8 BOM、GBK、CP936 识别，复制源文件到书籍资产目录，按中文章节标题分章。

**Reviewer 责任:** 用 fixtures 验证四种编码和章节识别；确认编码失败不创建书籍资产。

**Files:**
- Create: `packages/extraction/package.json`
- Create: `packages/extraction/src/textEncoding.ts`
- Create: `packages/extraction/src/chapterParser.ts`
- Create: `packages/extraction/src/uploadBook.ts`
- Test: `packages/extraction/src/textEncoding.test.ts`
- Test: `packages/extraction/src/chapterParser.test.ts`
- Test: `packages/extraction/src/uploadBook.test.ts`

- [x] **Step 1: 写 RED 测试**

```ts
import { describe, expect, it } from "vitest";
import { decodeNovelText } from "./textEncoding";
import { parseChapters } from "./chapterParser";

describe("novel text upload", () => {
  it("decodes utf8 and utf8 bom", () => {
    expect(decodeNovelText(Buffer.from("第一章 起始", "utf8")).encoding).toBe("utf-8");
    expect(decodeNovelText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("第一章 起始", "utf8")])).encoding).toBe(
      "utf-8-bom",
    );
  });

  it("decodes gbk and cp936 Chinese text", () => {
    const gbkBuffer = Buffer.from([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2]);
    expect(decodeNovelText(gbkBuffer).text).toContain("第一章");
  });

  it("parses Chinese and Arabic chapter headings", () => {
    const chapters = parseChapters("第一章 起始\n正文\n第2章 转折\n正文");
    expect(chapters.map((chapter) => chapter.title)).toEqual(["第一章 起始", "第2章 转折"]);
  });
});
```

- [x] **Step 2: 运行 RED**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pnpm --filter @novel-extractor/extraction test
```

Expected: FAIL。

- [x] **Step 3: 实现编码和分章**

实现要求：

- 优先检测 UTF-8 BOM。
- 无 BOM 时先尝试严格 UTF-8。
- UTF-8 失败时使用 GBK/CP936 解码。
- 解码后统一换行为 `\n`。
- 章节规则覆盖 `第十二章`、`第12章`、`卷一 第三章`、`Chapter 1` 的常见标题。
- 分章失败返回 typed error，调用方不创建书籍资产。

- [x] **Step 4: 运行 GREEN**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pnpm --filter @novel-extractor/extraction test
```

Expected: PASS。

**验收命令:** `pnpm --filter @novel-extractor/extraction test` 成功。

---

### Task 7: 模板选择、章节窗口和报告命名

**Worker 责任:** 实现模板多选、模板快照、单次章节数、提取章节数和报告文件名规则。

**Reviewer 责任:** 确认默认模板来自 `packages/config`；确认窗口生成不读取 UI 常量；确认报告名规则只在模板服务中实现。

**Files:**
- Create: `packages/extraction/src/windowPlanner.ts`
- Create: `packages/extraction/src/templateRouter.ts`
- Test: `packages/extraction/src/windowPlanner.test.ts`
- Test: `packages/extraction/src/templateRouter.test.ts`

- [x] **Step 1: 写 RED 测试**

```ts
import { describe, expect, it } from "vitest";
import { planChapterWindows } from "./windowPlanner";
import { createTemplateSnapshots } from "./templateRouter";

describe("template routing and chapter windows", () => {
  it("creates chapter windows from configured chapter count", () => {
    const windows = planChapterWindows({ chapterIds: ["c1", "c2", "c3", "c4", "c5"], chaptersPerWindow: 2, maxChapters: 5 });
    expect(windows.map((window) => window.chapterIds)).toEqual([["c1", "c2"], ["c3", "c4"], ["c5"]]);
  });

  it("stores template snapshots for historical jobs", () => {
    const snapshots = createTemplateSnapshots([
      { id: "tpl-pill", name: "丹药分析模板", body: "抽取丹药", outputFileName: undefined },
    ]);
    expect(snapshots[0]).toMatchObject({ templateId: "tpl-pill", reportFileName: "丹药分析.md" });
  });
});
```

- [x] **Step 2: 运行 RED**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pnpm --filter @novel-extractor/extraction test -- windowPlanner templateRouter
```

Expected: FAIL。

- [x] **Step 3: 实现最小逻辑**

`planChapterWindows` 对 `maxChapters` 做上限截取；`createTemplateSnapshots` 保存模板正文快照、输出文件名和创建时间。默认 `chaptersPerWindow` 从 `packages/config` 的 strategy 读取，函数只接收已解析配置。

- [x] **Step 4: 运行 GREEN**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pnpm --filter @novel-extractor/extraction test
```

Expected: PASS。

**验收命令:** `pnpm --filter @novel-extractor/extraction test` 成功。

---

### Task 8: LLM Provider Registry 和 OpenAI-compatible adapter

**Worker 责任:** 实现 provider registry、DeepSeek preset adapter、自定义 OpenAI-compatible adapter、模型引用解析、最小连接测试和密钥脱敏。

**Reviewer 责任:** 确认业务逻辑只依赖 registry；确认 API key 只通过 `ApiKeyRef` 解析；确认日志与错误不包含明文密钥。

**Files:**
- Create: `packages/llm/package.json`
- Create: `packages/llm/src/providerRegistry.ts`
- Create: `packages/llm/src/openAiCompatibleClient.ts`
- Create: `packages/llm/src/deepseekAdapter.ts`
- Create: `packages/llm/src/redaction.ts`
- Test: `packages/llm/src/providerRegistry.test.ts`
- Test: `packages/llm/src/openAiCompatibleClient.test.ts`
- Test: `packages/llm/src/redaction.test.ts`

- [x] **Step 1: 写 RED 测试**

```ts
import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redaction";
import { parseModelRef } from "./providerRegistry";

describe("LLM provider registry", () => {
  it("parses provider scoped model references", () => {
    expect(parseModelRef("deepseek/novel-analysis")).toEqual({ providerId: "deepseek", modelId: "novel-analysis" });
  });

  it("redacts api keys and authorization headers", () => {
    const liveKey = "sk-" + "live-secret";
    const anotherKey = "sk-" + "another-secret";

    expect(
      redactSecrets({
        Authorization: `Bearer ${liveKey}`,
        apiKey: anotherKey,
        message: "request failed",
      }),
    ).toEqual({
      Authorization: "Bearer sk-***",
      apiKey: "***",
      message: "request failed",
    });
  });
});
```

- [x] **Step 2: 运行 RED**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pnpm --filter @novel-extractor/llm test
```

Expected: FAIL。

- [x] **Step 3: 实现 adapter**

OpenAI-compatible 请求形状：

```ts
export interface ChatCompletionRequest {
  providerId: string;
  modelId: string;
  messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
  tools?: ToolSchema[];
}
```

DeepSeek 和自定义供应商都走相同 `OpenAiCompatibleClient`。DeepSeek 只在 provider preset 中定义默认 base URL、认证方案和能力标记；具体模型 ID 来自 provider schema、用户配置或连接测试结果，不写进任务 runtime。

- [x] **Step 4: 运行 GREEN**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pnpm --filter @novel-extractor/llm test
```

Expected: PASS。

**验收命令:** `pnpm --filter @novel-extractor/llm test` 成功。

---

### Task 9: Reasonix 风格工具 registry 和 Markdown 写入工具

**Worker 责任:** 实现 P0 内置工具 `ls`、`read_file`、`grep`、`write_file`、`edit_file`、`multi_edit`，工具 schema 由 registry 暴露，写工具只允许写入书籍 `reports/` 目录。

**Reviewer 责任:** 验证读工具可并行、写工具顺序执行；验证所有写入路径都绑定 reports 根；验证工具错误回传给模型而不是直接崩溃。

**Files:**
- Create: `packages/tools/package.json`
- Create: `packages/tools/src/toolRegistry.ts`
- Create: `packages/tools/src/builtinFileTools.ts`
- Create: `packages/tools/src/toolPolicy.ts`
- Create: `packages/markdown/package.json`
- Create: `packages/markdown/src/reportWriter.ts`
- Test: `packages/tools/src/toolRegistry.test.ts`
- Test: `packages/tools/src/builtinFileTools.test.ts`
- Test: `packages/tools/src/toolPolicy.test.ts`
- Test: `packages/markdown/src/reportWriter.test.ts`

- [x] **Step 1: 写 RED 测试**

```ts
import { describe, expect, it } from "vitest";
import { getEnabledTools } from "./toolRegistry";
import { classifyToolEffects } from "./toolPolicy";

describe("P0 tool registry", () => {
  it("exposes the configured file tools in deterministic order", () => {
    expect(getEnabledTools(["ls", "read_file", "grep", "write_file", "edit_file", "multi_edit"]).map((tool) => tool.name)).toEqual([
      "ls",
      "read_file",
      "grep",
      "write_file",
      "edit_file",
      "multi_edit",
    ]);
  });

  it("classifies reads and writes for ordered execution", () => {
    expect(classifyToolEffects("grep")).toBe("read");
    expect(classifyToolEffects("multi_edit")).toBe("write");
  });
});
```

- [x] **Step 2: 运行 RED**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pnpm --filter @novel-extractor/tools test; pnpm --filter @novel-extractor/markdown test
```

Expected: FAIL。

- [x] **Step 3: 实现工具和 writer**

工具参数使用 JSON Schema；工具实现自己校验 raw JSON。`write_file`、`edit_file`、`multi_edit` 返回可审计摘要：

```ts
export interface ToolWriteSummary {
  path: string;
  operation: "write_file" | "edit_file" | "multi_edit";
  changedBytes: number;
  preview: string;
}
```

- [x] **Step 4: 运行 GREEN**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pnpm --filter @novel-extractor/tools test; pnpm --filter @novel-extractor/markdown test
```

Expected: PASS。

**验收命令:** 同 Step 4。

---

### Task 10: 单任务 Job Runtime、事件流和脱敏日志

**Worker 责任:** 实现 create/start/pause/resume/delete command service、单任务运行限制、窗口级安全暂停、失败展示、token/费用记录和日志脱敏。

**Reviewer 责任:** 用模拟 LLM 和模拟工具验证事件顺序；确认暂停只在窗口边界生效；确认删除任务不删除共享报告。

**Files:**
- Create: `packages/jobs/package.json`
- Create: `packages/jobs/src/eventBus.ts`
- Create: `packages/jobs/src/jobRuntime.ts`
- Create: `packages/jobs/src/runLogger.ts`
- Create: `packages/jobs/src/commands.ts`
- Test: `packages/jobs/src/jobRuntime.test.ts`
- Test: `packages/jobs/src/runLogger.test.ts`
- Test: `packages/jobs/src/commands.test.ts`

- [x] **Step 1: 写 RED 测试**

```ts
import { describe, expect, it } from "vitest";
import { createJobRuntime } from "./jobRuntime";

describe("P0 job runtime", () => {
  it("runs one job and emits window events", async () => {
    const runtime = createJobRuntime({ maxConcurrentJobs: 1 });
    const events = await runtime.runFixtureJob({ windows: [["c1"], ["c2"]] });
    expect(events.map((event) => event.type)).toEqual([
      "job.started",
      "job.window.started",
      "job.window.completed",
      "job.window.started",
      "job.window.completed",
      "job.completed",
    ]);
  });

  it("redacts secrets from run logs", async () => {
    const runtime = createJobRuntime({ maxConcurrentJobs: 1 });
    const log = await runtime.writeFixtureLog({ apiKey: "sk-secret", Authorization: "Bearer sk-secret" });
    expect(log).not.toContain("sk-secret");
    expect(log).toContain("***");
  });
});
```

- [x] **Step 2: 运行 RED**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pnpm --filter @novel-extractor/jobs test
```

Expected: FAIL。

- [x] **Step 3: 实现 runtime**

状态转换读取 `packages/config/src/taskStatus.ts`。runtime 不直接认识 UI 文案，只发 typed event。单任务策略用内部 queue guard 实现：P0 若已有运行任务，新的 start 请求返回 typed error `job_already_running`。

- [x] **Step 4: 运行 GREEN**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pnpm --filter @novel-extractor/jobs test
```

Expected: PASS。

**验收命令:** `pnpm --filter @novel-extractor/jobs test` 成功。

---

### Task 11: React 桌面工作台 UI、导航和项目创建

**Worker 责任:** 实现首次项目创建、顶部功能入口、右上用户入口、左侧窄功能栏、资产页、小说提取页、关系图谱占位页的基础布局。

**Reviewer 责任:** 根据 design-taste-frontend 约束审查 UI：不是落地页，不出现 hero、营销卡片、AI 紫色渐变；视觉 token 从 config 进入 CSS variables；三档 viewport 截图无重叠。

**Files:**
- Modify: `apps/desktop/src/renderer/App.tsx`
- Create: `apps/desktop/src/renderer/features/project/ProjectGate.tsx`
- Create: `apps/desktop/src/renderer/features/navigation/WorkbenchNav.tsx`
- Create: `apps/desktop/src/renderer/features/assets/AssetsPage.tsx`
- Create: `apps/desktop/src/renderer/features/extraction/ExtractionPage.tsx`
- Create: `apps/desktop/src/renderer/features/graph/GraphPlaceholderPage.tsx`
- Create: `apps/desktop/src/renderer/styles/tokens.css`
- Modify: `apps/desktop/src/renderer/styles/app.css`
- Test: `apps/desktop/src/renderer/features/project/ProjectGate.test.tsx`
- Test: `apps/desktop/src/renderer/features/navigation/WorkbenchNav.test.tsx`
- Test: `apps/desktop/src/renderer/features/graph/GraphPlaceholderPage.test.tsx`

- [x] **Step 1: 写 RED 测试**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../../App";

describe("desktop workbench shell", () => {
  it("shows project creation before a project exists", () => {
    render(<App initialState={{ project: null }} />);
    expect(screen.getByRole("textbox", { name: "项目名称" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建项目" })).toBeInTheDocument();
  });

  it("shows P0 navigation after project creation", () => {
    render(<App initialState={{ project: { id: "project-a", displayName: "仙途资料" } }} />);
    expect(screen.getByRole("button", { name: "资产" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "小说提取" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关系图谱" })).toBeInTheDocument();
  });
});
```

- [x] **Step 2: 运行 RED**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pnpm --filter @novel-extractor/desktop test -- src/renderer
```

Expected: FAIL。

- [x] **Step 3: 实现 UI**

设计读法必须写入代码注释或 UI task 文档，不写成可见营销文案：

```text
Reading this as: 桌面工作台 for 小说资料整理和 LLM 长任务用户, with 书香气/低饱和/现代工具化 language, leaning toward React + CSS variables + restrained motion.
DESIGN_VARIANCE=5, MOTION_INTENSITY=3, VISUAL_DENSITY=7
```

UI 规则：

- 不做落地页 hero。
- 不做营销卡片。
- 不用 AI 紫色渐变。
- 页面密度偏工具台，卡片只用于重复实体、弹窗内容或明确分组；禁止卡片套卡片，不把页面 section 做成漂浮卡片。
- CSS 使用 `tokens.css` 中的墨色背景、纸页区域、边框、选中态、进度、成功、警告、危险、圆角、阴影、动效时长变量。
- 动效只服务层级、状态切换和操作反馈；禁止纯装饰动效，所有动效都提供 reduced-motion 降级。
- 图标使用统一图标库，不手写散落 SVG。

产品 UI 状态矩阵：

| 界面 | 必须覆盖的状态 | 不适用项及原因 |
| --- | --- | --- |
| 资产页 | 空资产、空报告、资产列表加载、报告预览加载、加载错误、未选中报告时预览禁用 | 正在运行、暂停、失败属于任务运行态，资产页只读展示任务产物 |
| 小说提取页 | 空书籍、空模型、空任务、上传或任务加载、加载错误、无模型时禁用创建任务、正在运行显示暂停、暂停显示继续、失败显示失败原因和删除入口 | 全部适用 |
| 关系图谱占位页 | 空图谱占位、书籍上下文加载、加载错误、图谱操作禁用 | 正在运行、暂停、失败不适用，P0 不实现图谱生成任务 |
| 大模型配置弹窗 | 空供应商、空模型、配置加载、保存中、连接或保存错误、表单无效时保存禁用、保存中禁用底部按钮 | 正在运行、暂停、失败不适用，大模型配置不是任务 runtime |

- [x] **Step 4: 运行 GREEN**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pnpm --filter @novel-extractor/desktop test -- src/renderer
```

Expected: PASS。

**验收命令:** `pnpm --filter @novel-extractor/desktop test -- src/renderer` 成功，后续 Task 15 生成三档 viewport 截图。

---

### Task 12: 大模型配置弹窗

**Worker 责任:** 实现右上用户下拉和大模型配置中心弹窗，P0 支持 DeepSeek 与自定义 OpenAI-compatible；保存 API key 引用、base URL、模型名和默认模型。

**Reviewer 责任:** 确认弹窗不是右侧抽屉或独立页面；确认 API key 输入保存为引用；确认无模型配置时提取页提供进入配置入口。

**Files:**
- Create: `apps/desktop/src/renderer/features/providers/UserMenu.tsx`
- Create: `apps/desktop/src/renderer/features/providers/ProviderConfigModal.tsx`
- Create: `apps/desktop/src/renderer/features/providers/ProviderForm.tsx`
- Create: `apps/desktop/src/renderer/features/providers/providerViewModel.ts`
- Test: `apps/desktop/src/renderer/features/providers/ProviderConfigModal.test.tsx`
- Test: `apps/desktop/src/renderer/features/providers/providerViewModel.test.ts`

- [x] **Step 1: 写 RED 测试**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ProviderConfigModal } from "./ProviderConfigModal";
import { UserMenu } from "./UserMenu";

describe("provider config modal", () => {
  it("opens model config as a modal from user menu", async () => {
    render(<UserMenu providers={[]} />);
    await userEvent.click(screen.getByRole("button", { name: "用户菜单" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "大模型配置" }));
    expect(screen.getByRole("dialog", { name: "大模型配置" })).toBeInTheDocument();
  });

  it("shows only P0 provider modes", () => {
    render(<UserMenu providers={[]} defaultOpen />);
    expect(screen.getByRole("button", { name: "DeepSeek" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "自定义 OpenAI-compatible" })).toBeInTheDocument();
  });

  it("disables modal actions while provider config is saving", () => {
    render(<ProviderConfigModal open providers={[]} saveState="saving" />);
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
  });
});
```

- [x] **Step 2: 运行 RED**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pnpm --filter @novel-extractor/desktop test -- src/renderer/features/providers
```

Expected: FAIL。

- [x] **Step 3: 实现弹窗**

表单字段：

- 供应商模式：DeepSeek、自定义 OpenAI-compatible。
- 供应商名称。
- base URL。
- API key。
- 模型名。
- 默认模型。
- 启用状态。

保存时 UI 只把 API key 传给 preload 的 `saveProvider`，Main 使用 `CredentialStore` 保存明文并返回 `ApiKeyRef`，Renderer state 不保留明文。

- [x] **Step 4: 运行 GREEN**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pnpm --filter @novel-extractor/desktop test -- src/renderer/features/providers
```

Expected: PASS。

**验收命令:** 同 Step 4。

---

### Task 13: 小说提取页、任务创建和任务操作 UI

**Worker 责任:** 实现上传 `.txt`、显示编码和章节数、模板选择、章节参数、模型选择、创建任务、开始、暂停、继续、删除、展开日志。

**Reviewer 责任:** 确认没有模型配置时有进入大模型配置按钮；确认任务状态和操作来自 config；确认删除确认框只删除任务记录，P0 不提供共享文件删除增强。

**Files:**
- Modify: `apps/desktop/src/renderer/features/extraction/ExtractionPage.tsx`
- Create: `apps/desktop/src/renderer/features/extraction/UploadNovelPanel.tsx`
- Create: `apps/desktop/src/renderer/features/extraction/ExtractionParameters.tsx`
- Create: `apps/desktop/src/renderer/features/extraction/JobList.tsx`
- Create: `apps/desktop/src/renderer/features/extraction/JobLogPanel.tsx`
- Test: `apps/desktop/src/renderer/features/extraction/ExtractionPage.test.tsx`
- Test: `apps/desktop/src/renderer/features/extraction/JobList.test.tsx`

- [x] **Step 1: 写 RED 测试**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExtractionPage } from "./ExtractionPage";

describe("extraction page", () => {
  it("guides user to provider config when no model is enabled", () => {
    render(<ExtractionPage models={[]} books={[]} jobs={[]} />);
    expect(screen.getByRole("button", { name: "前往大模型配置" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建任务" })).toBeDisabled();
  });

  it("shows pause when a task is running", () => {
    render(
      <ExtractionPage
        models={[{ id: "model-for-test", displayName: "测试模型" }]}
        books={[]}
        jobs={[{ id: "job-1", status: "running", progressText: "1/3", tokenText: "输入 10 / 输出 5" }]}
      />,
    );
    expect(screen.getByRole("button", { name: "暂停" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "继续" })).not.toBeInTheDocument();
  });

  it("shows continue when a task is paused", () => {
    render(
      <ExtractionPage
        models={[{ id: "model-for-test", displayName: "测试模型" }]}
        books={[]}
        jobs={[{ id: "job-2", status: "paused", progressText: "1/3", tokenText: "输入 10 / 输出 5" }]}
      />,
    );
    expect(screen.getByRole("button", { name: "继续" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "暂停" })).not.toBeInTheDocument();
  });

  it("shows failure reason and delete entry when a task failed", () => {
    render(
      <ExtractionPage
        models={[{ id: "model-for-test", displayName: "测试模型" }]}
        books={[]}
        jobs={[{ id: "job-3", status: "failed", progressText: "2/3", failureReason: "模型返回格式无效" }]}
      />,
    );
    expect(screen.getByText("模型返回格式无效")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除任务" })).toBeInTheDocument();
  });
});
```

- [x] **Step 2: 运行 RED**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pnpm --filter @novel-extractor/desktop test -- src/renderer/features/extraction
```

Expected: FAIL。

- [x] **Step 3: 实现 UI 和 IPC 调用**

上传只允许 `.txt`；上传成功显示文件名、大小、编码、章节数。任务卡显示任务名、状态、窗口进度、token/费用、操作按钮、展开日志。删除任务弹窗文案明确“删除任务记录和运行日志索引”，P0 不声称会删除共享报告文件。

- [x] **Step 4: 运行 GREEN**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pnpm --filter @novel-extractor/desktop test -- src/renderer/features/extraction
```

Expected: PASS。

**验收命令:** 同 Step 4。

---

### Task 14: 资产页和安全 Markdown 预览

**Worker 责任:** 实现书籍资产列表、报告列表、只读 Markdown 预览和安全渲染。

**Reviewer 责任:** 验证 HTML、script、iframe、不可信资源不执行不加载；确认资产类型列表来自 config，P0 只显示书籍。

**Files:**
- Modify: `apps/desktop/src/renderer/features/assets/AssetsPage.tsx`
- Create: `apps/desktop/src/renderer/features/assets/BookAssetDrawer.tsx`
- Create: `apps/desktop/src/renderer/features/assets/ReportList.tsx`
- Create: `apps/desktop/src/renderer/features/assets/MarkdownPreview.tsx`
- Modify: `packages/markdown/src/preview.ts`
- Test: `apps/desktop/src/renderer/features/assets/AssetsPage.test.tsx`
- Test: `apps/desktop/src/renderer/features/assets/MarkdownPreview.test.tsx`
- Test: `packages/markdown/src/preview.test.ts`

- [x] **Step 1: 写 RED 测试**

```tsx
// apps/desktop/src/renderer/features/assets/AssetsPage.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AssetsPage } from "./AssetsPage";

describe("assets page states", () => {
  it("shows empty assets and empty reports", () => {
    render(<AssetsPage books={[]} reports={[]} state="ready" />);
    expect(screen.getByText("暂无书籍资产")).toBeInTheDocument();
    expect(screen.getByText("暂无 Markdown 报告")).toBeInTheDocument();
  });

  it("shows loading state for assets and reports", () => {
    render(<AssetsPage books={[]} reports={[]} state="loading" />);
    expect(screen.getByLabelText("资产加载中")).toBeInTheDocument();
  });

  it("shows loading error", () => {
    render(<AssetsPage books={[]} reports={[]} state="error" errorMessage="读取资产失败" />);
    expect(screen.getByText("读取资产失败")).toBeInTheDocument();
  });
});
```

```ts
// packages/markdown/src/preview.test.ts
import { describe, expect, it } from "vitest";
import { renderSafeMarkdown } from "./preview";

describe("safe markdown preview", () => {
  it("renders readable markdown blocks and strips active content", () => {
    const source = [
      "# 丹药分析",
      "",
      "- 凝气丹",
      "",
      "> 关键线索",
      "",
      "~~~ts",
      "const rank = 1;",
      "~~~",
      "",
      "| 名称 | 等级 |",
      "| --- | --- |",
      "| 凝气丹 | 一阶 |",
      "",
      "---",
      "",
      "<script>alert(1)</script>",
      "<iframe src=\"https://example.com\"></iframe>",
    ].join("\n");
    const html = renderSafeMarkdown(source);
    expect(html).toContain("<h1");
    expect(html).toContain("丹药分析");
    expect(html).toContain("<ul");
    expect(html).toContain("<blockquote");
    expect(html).toContain("<code");
    expect(html).toContain("<table");
    expect(html).toContain("<hr");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<iframe");
  });
});
```

- [x] **Step 2: 运行 RED**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pnpm --filter @novel-extractor/markdown test; pnpm --filter @novel-extractor/desktop test -- src/renderer/features/assets
```

Expected: FAIL。

- [x] **Step 3: 实现预览**

Markdown preview 只接收 Main 返回的安全 HTML 或安全 AST，不让 Renderer 读取任意文件路径。样式使用纸页 token，不加载外部资源。

- [x] **Step 4: 运行 GREEN**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pnpm --filter @novel-extractor/markdown test; pnpm --filter @novel-extractor/desktop test -- src/renderer/features/assets
```

Expected: PASS。

**验收命令:** 同 Step 4。

---

### Task 15: Windows 打包、端到端闭环和截图检查

**Worker 责任:** 配置 Windows 安装包构建，编写 Playwright/Electron E2E：启动应用、创建项目、配置自定义 OpenAI-compatible mock provider、上传小说、创建并运行单任务、写入报告、资产页预览、关系图谱占位页、桌面宽屏、常规笔记本宽度和窄屏截图检查。

**Reviewer 责任:** 独立运行打包和 E2E；打开三档 viewport 截图确认无文字溢出、按钮换行、弹窗底部操作遮挡、营销化 hero 或 AI 紫色渐变。

**Files:**
- Modify: `apps/desktop/electron-builder.yml`
- Create: `e2e/desktop-p0.spec.ts`
- Create: `e2e/fixtures/utf8-novel.txt`
- Create: `e2e/fixtures/gbk-novel.txt`
- Create: `e2e/fixtures/mock-openai-compatible.ts`
- Create: `playwright.config.ts`
- Create: `e2e/screenshots/.gitkeep`

- [x] **Step 1: 写 RED E2E**

```ts
import { expect, test } from "@playwright/test";

test("P0 desktop extraction loop", async ({ page }) => {
  await page.getByRole("textbox", { name: "项目名称" }).fill("仙途资料");
  await page.getByRole("button", { name: "创建项目" }).click();
  await page.getByRole("button", { name: "用户菜单" }).click();
  await page.getByRole("menuitem", { name: "大模型配置" }).click();
  await expect(page.getByRole("dialog", { name: "大模型配置" })).toBeVisible();
  await page.getByRole("button", { name: "自定义 OpenAI-compatible" }).click();
  await page.getByLabel("模型名").fill("novel-e2e-model");
  await page.getByRole("button", { name: "保存" }).click();
  await page.getByRole("button", { name: "小说提取" }).click();
  await page.getByLabel("上传小说").setInputFiles("e2e/fixtures/utf8-novel.txt");
  await expect(page.getByText("章节数 2")).toBeVisible();
  await page.getByRole("button", { name: "创建任务" }).click();
  await page.getByRole("button", { name: "开始" }).click();
  await expect(page.getByText("完成")).toBeVisible();
  await page.getByRole("button", { name: "资产" }).click();
  await expect(page.getByText("丹药分析.md")).toBeVisible();
  await page.getByRole("button", { name: "关系图谱" }).click();
  await expect(page.getByText("当前书籍暂无图谱资产")).toBeVisible();
});
```

- [x] **Step 2: 运行 RED**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pnpm test:e2e --grep "P0 desktop extraction loop"
```

Expected: FAIL，原因是端到端 UI 或 mock provider 尚未完整实现。

- [x] **Step 3: 实现 E2E 支撑和打包**

E2E 使用本地 mock OpenAI-compatible server，不调用真实外部模型。mock 响应必须触发工具写入报告，并返回 token/费用 fixture。打包输出 Windows installer。

- [x] **Step 4: 运行 GREEN E2E**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pnpm test:e2e --grep "P0 desktop extraction loop"
```

Expected: PASS。

- [x] **Step 5: 截图检查**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pnpm test:e2e --grep "P0 visual screenshots"
```

Expected: PASS，并按三档 viewport 生成截图：

```text
wide 1440x900:
e2e/screenshots/wide-assets.png
e2e/screenshots/wide-extraction.png
e2e/screenshots/wide-provider-modal.png

laptop 1366x768:
e2e/screenshots/laptop-assets.png
e2e/screenshots/laptop-extraction.png
e2e/screenshots/laptop-provider-modal.png

narrow 390x844:
e2e/screenshots/narrow-assets.png
e2e/screenshots/narrow-extraction.png
e2e/screenshots/narrow-provider-modal.png
```

Reviewer 检查截图结论必须覆盖：

- 三档 viewport 的资产页、小说提取页和大模型配置弹窗文字不溢出。
- 所有主要按钮标签不换行。
- 任务列表、资产列表和弹窗底部操作不被遮挡。
- 没有落地页 hero、营销卡片、AI 紫色渐变。
- 视觉 token 生效，整体为书香气、低饱和、现代工具化桌面工作台。

- [x] **Step 6: Windows 打包**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pnpm desktop:dist
```

Expected: `apps/desktop/release/` 下生成 Windows installer；安装后首次启动可创建项目。

**验收命令:** `pnpm test:e2e --grep "P0 desktop extraction loop"`、`pnpm test:e2e --grep "P0 visual screenshots"`、`pnpm desktop:dist` 均成功。

---

### Task 16: P0 总体验收和架构审查

**Worker 责任:** 不写业务代码，汇总各任务验证输出，修正文档中与实际文件路径或命令不一致的地方。

**Reviewer 责任:** 以 P0 完成标准逐条验收，确认 P1/P2 未混入完成标准，确认通用架构、设计模式适配、配置化覆盖范围全部满足。

**Files:**
- Modify: `docs/superpowers/plans/2026-06-27-desktop-p0-implementation-plan.md`
- Read: `docs/superpowers/specs/2026-06-26-desktop-architecture-design.md`

- [x] **Step 1: 运行全量测试**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; pytest -q; pnpm test:ts; pnpm typecheck; pnpm test:e2e --grep "P0 desktop extraction loop"; pnpm desktop:dist
```

Expected:

```text
99 passed
Vitest test files PASS
TypeScript typecheck PASS
P0 desktop extraction loop PASS
Windows installer generated under apps/desktop/release/
```

- [x] **Step 2: 架构审查**

检查清单：

- 通用架构：业务逻辑在 packages 中，Electron Main 和 Renderer 只做 adapter/UI。
- 设计模式适配：repository、command/service、event bus、provider registry、tool registry、schema driven config 均有测试覆盖。
- 配置化覆盖范围：供应商、模型、模板、任务状态、菜单项、视觉 token 均从 `packages/config` 或用户配置读取。
- P0 范围：只包含桌面壳、项目创建、资产页、小说提取页、关系图谱占位、DeepSeek、自定义 OpenAI-compatible、上传 txt、编码识别、分章、模板选择、单任务运行、Markdown 报告写入与预览、日志/密钥脱敏。
- P1/P2 未作为 P0 通过条件。

- [x] **Step 3: 占位词和路径一致性扫描**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; $plan = Get-Content -LiteralPath 'docs/superpowers/plans/2026-06-27-desktop-p0-implementation-plan.md' -Raw -Encoding UTF8; $blocked = @(([string][char]84 + [char]66 + [char]68), ([string][char]84 + [char]79 + [char]68 + [char]79), ([string][char]24453 + [char]23450), ([string][char]20197 + [char]21518 + [char]20877 + [char]35828), ('deepseek' + [char]45 + 'v4' + [char]45 + 'pro'), ('deepseek' + [char]45 + 'v4' + [char]45 + 'flash')); $hits = $blocked | Where-Object { $plan.Contains($_) }; if ($hits.Count -gt 0) { $hits; exit 1 }
```

Expected: 无输出。

- [x] **Step 4: Git 范围检查**

Run:

```powershell
$env:PYTHONIOENCODING = "utf-8"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 > $null; git -c core.quotePath=false status --short; git -c core.quotePath=false diff --name-only
```

Expected: 只出现当前任务实际要求的文件；若本计划作为单独交付执行，则只出现 `docs/superpowers/plans/2026-06-27-desktop-p0-implementation-plan.md`。

**验收命令:** Step 1、Step 3、Step 4 全部符合预期。

---

## 自审结果

**P0 覆盖:** 已覆盖 Electron + React 桌面壳启动和 Windows 打包、项目创建、资产页、小说提取页、关系图谱占位页、DeepSeek 和自定义 OpenAI-compatible、上传 `.txt`、UTF-8/UTF-8 BOM/GBK/CP936、分章、模板选择、章节窗口参数、模型选择、单任务运行、Markdown 报告写入和预览、日志/密钥脱敏。

**P1/P2 隔离:** 多供应商全集、模型拉取增强、任务队列增强、意外退出恢复、失败窗口跳过继续、日志清理入口、卡片资产、图谱生成、无限画布均未列入 P0 完成标准。

**通用架构:** 计划采用 monorepo、端口与适配器、repository、command/service、event bus、provider registry、tool registry、schema driven config；Electron、React、SQLite、文件系统、LLM API 均为外层 adapter。

**设计模式适配:** 每个核心边界都有独立 package 和测试，状态机、provider、工具、模板、报告写入、持久化、IPC 均按可替换接口组织。

**配置化覆盖范围:** 供应商、模型、模板、任务状态、用户菜单、视觉 token、默认章节窗口策略均进入 `packages/config` 或用户配置；业务逻辑只读取解析后的配置。

**前端约束:** 已写入 design-taste-frontend 读法：`Reading this as: 桌面工作台 for 小说资料整理和 LLM 长任务用户, with 书香气/低饱和/现代工具化 language, leaning toward React + CSS variables + restrained motion.` Dials 为 `DESIGN_VARIANCE=5`、`MOTION_INTENSITY=3`、`VISUAL_DENSITY=7`；明确禁止落地页 hero、营销卡片、AI 紫色渐变、纯装饰动效和嵌套卡片；卡片仅用于重复实体、弹窗内容或明确分组；资产页、小说提取页、关系图谱占位页、大模型配置弹窗均有适用 UI 状态矩阵；Task 15 要求桌面宽屏、常规笔记本宽度和窄屏三档截图检查。

**TDD 覆盖:** 除脚手架和打包这类不适合单元 RED 的任务外，每个代码任务均包含 RED 测试、RED 命令、最小实现、GREEN 命令和验收命令。

**禁用字面量扫描:** 计划正文未保留用户禁止的占位词或 DeepSeek 模型名字面量。

**类型和路径一致性:** 任务中的核心类型统一为 `ProviderPreset`、`ProviderKind`、`ModelOption`、`Project`、`ReportAsset`、`ApiKeyRef`、`JobStatus`、`JobEventType`、`CredentialStore`、`ProjectRepository`、`ToolWriteSummary`；IPC DTO 统一定义在 `apps/desktop/src/shared/ipcTypes.ts`，路径均在文件结构或任务 Files 中定义，任务引用与文件结构一致。

## 执行完成记录

**完成日期:** 2026-06-27

**最终状态:** P0 最小可安装桌面闭环已完成。P1/P2 功能没有被纳入 P0 通过条件。

**关键实现结果:**

- Electron + React 桌面应用已具备项目创建、用户菜单、大模型配置弹窗、资产页、小说提取页、关系图谱占位页。
- 自定义 OpenAI-compatible provider 在 Main 内通过共享 `providerStore` 和 `credentialStore` 保存；`jobs:start` / `jobs:resume` 通过 `OpenAiCompatibleClient` 请求本地 mock `/chat/completions`，不再使用 Main 硬编码报告。
- `.txt` 上传、UTF-8/GBK 编码识别、章节解析、单任务创建与运行、Markdown 报告写入和安全预览已接入 P0 E2E。
- 模型成功响应正文在写入报告前按当前 job 的 API key 做脱敏；报告文件、preview DTO、job DTO 和 provider list DTO 均不暴露 raw API key。
- Windows NSIS 安装包已生成：`apps/desktop/release/NovelExtractor Setup 0.0.0.exe`。

**最终验证矩阵:**

| 验证项 | 结果 |
| --- | --- |
| `pnpm --filter "@novel-extractor/desktop" test -- src/main/p0Handlers.test.ts src/main/providerHandlers.test.ts --reporter=dot` | 13 files / 65 tests passed |
| `pnpm test:e2e --grep "P0 desktop extraction loop"` | 1 passed |
| `pnpm test:e2e --grep "P0 visual screenshots"` | 1 passed |
| `pnpm test:ts -- --reporter=dot` | 44 files / 252 tests passed |
| `pnpm typecheck` | 9 workspace projects passed |
| `pnpm desktop:build` | main / preload / renderer build passed |
| `pytest -q` | 99 passed |
| `pnpm desktop:dist` | NSIS installer 和 blockmap 生成成功 |

**截图验收:** `e2e/screenshots/` 重新生成 9 张截图，尺寸分别为 `1440x900`、`1366x768`、`390x844`；设计 reviewer 按 design-taste-frontend 标准确认无 P0/P1 阻塞。

**审查闭环:**

- 第一轮规格 reviewer 发现 `mock HTTP provider` 未真实接入，已修复为 E2E 动态端口 mock server + Main `OpenAiCompatibleClient` 请求。
- 第二轮安全 reviewer 发现模型成功正文可回显 raw API key，已补 RED 测试并在写报告前脱敏。
- 主 agent 已独立复验修复结果、截图尺寸、安装包产物和 Electron Main 打包内联状态。

**剩余非阻塞风险:**

- P0 费用仍显示 `费用 0`，当前只读取 OpenAI-compatible usage 中的 token fixture。
- ProjectGate 首屏创建项目仍主要由 Renderer 状态驱动，上传时 Main 会 `ensureProject()` 创建 workspace；完整持久项目生命周期建议进入 P1。
- 模型内容脱敏覆盖当前 job 配置的 raw API key 精确回显；跨 provider secret inventory、分段或变体 secret 检测需要后续扩展。
- electron-builder 仍提示 package `description`、`author` 和应用图标未配置，属于产品化打磨项。

## 参考

- DeepSeek API 官方文档用于确认 P0 provider adapter 按 OpenAI-compatible `/chat/completions` 与 `/models` 设计：https://api-docs.deepseek.com/

