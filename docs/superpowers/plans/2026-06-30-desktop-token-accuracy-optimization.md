# 桌面端提取流程省 Token 与准确性优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 降低桌面端窗口提取 tool-loop 的输入 token、减少 exact replace 失败重试，并阻止内部运行元数据进入正式报告。

**Architecture:** 本计划先做高收益的流程边界优化：读取工具分页化、tool-loop 历史压缩、可恢复错误策略、摘要日志、公开来源生成与写前拦截。所有预算、阈值、保留数量、日志模式都走配置和策略注入，不在 `windowRunService.ts` 中散落魔法数字。计划只规定实施步骤，不预先写死最终数据结构、接口字段或函数签名。

**Tech Stack:** TypeScript、Vitest、Electron main process、workspace packages `@novel-extractor/config`、`@novel-extractor/tools`、`@novel-extractor/extraction`、`@novel-extractor/markdown`。

---

## 范围与约束

- 本计划覆盖当前验收优先级 1-5：分页读取、历史压缩、`maxRounds=6` 与 replacement miss 策略、摘要日志、报告内部元数据拦截。
- 两阶段事实卡、模板 prompt 卡片化、`report-index.json`、overlap 摘要属于第二阶段结构性优化。本轮只避免把第一阶段做成阻碍后续结构优化的硬编码。
- 不在计划中固定最终接口、类型、字段全集。实施时先通过 RED 测试表达行为，再按现有代码风格命名和落地。
- 所有命令在 PowerShell 中运行，保持 UTF-8 设置；涉及中文路径使用 `-LiteralPath`。

## 文件职责

- `packages/config/src/schema.ts`：承载新增可配置策略的类型边界。
- `packages/config/src/defaults.ts`：提供默认预算、轮次、日志、压缩、失败策略。
- `packages/config/src/configInvariants.ts`：校验新增配置合法性。
- `packages/tools/src/toolRegistry.ts`：公开 `read_file` 新参数能力给模型。
- `packages/tools/src/builtinFileTools.ts`：实现分页/限量读取行为。
- `apps/desktop/src/main/windowRunService.ts`：编排 tool-loop、注入策略、调用压缩器和写前 guard。
- `apps/desktop/src/main/taskTextLogger.ts`：默认摘要日志与可选 debug 完整日志。
- `apps/desktop/src/main/*toolLoop*.ts`：新建小模块承载历史压缩、replacement miss 状态和公开来源文本生成；文件名实施时按现有命名风格确定。
- `packages/markdown/src/reportWriter.ts` 或 `packages/tools/src/builtinFileTools.ts`：承载最小结构化 Markdown 写入能力，具体落点按已有 writer/tool 边界选择。
- 对应测试文件：优先修改现有 `.test.ts`，只在需要独立验证新小模块时新增测试文件。

---

### Task 1: 配置策略骨架

**Files:**
- Modify: `packages/config/src/schema.ts`
- Modify: `packages/config/src/defaults.ts`
- Modify: `packages/config/src/configInvariants.ts`
- Test: `packages/config/src/defaults.test.ts`
- Test: `packages/config/src/configInvariants.test.ts`

- [ ] **Step 1: 写 RED 测试覆盖新增配置默认值**
  - 在 `defaults.test.ts` 中断言：
    - `toolLoopDefaults.maxRounds` 默认变为 `6`。
    - 存在 read_file 分页预算、历史压缩保留数量、replacement miss 连续上限、日志摘要/debug 开关这些配置入口。
    - 默认值不是空对象，且调用方拿到的是可变副本，不污染 `DEFAULT_CONFIG`。
  - Run: `pnpm --filter @novel-extractor/config test -- defaults.test.ts`
  - Expected: FAIL，原因是默认配置尚未提供这些入口或 `maxRounds` 仍为 12。

- [ ] **Step 2: 写 RED 测试覆盖配置非法值**
  - 在 `configInvariants.test.ts` 中断言：
    - 分页大小、最大读取预算、历史保留数量、摘要长度、replacement miss 上限必须是正整数或符合对应语义。
    - 日志模式只能使用允许值。
  - Run: `pnpm --filter @novel-extractor/config test -- configInvariants.test.ts`
  - Expected: FAIL，原因是校验尚未覆盖新增配置。

- [ ] **Step 3: 实现最小配置扩展**
  - 修改 `schema.ts`、`defaults.ts`、`configInvariants.ts`。
  - 不把具体策略写到桌面流程里；只让默认配置成为唯一默认值来源。
  - 保持字段命名贴合现有 `toolLoopDefaults` 风格，避免为了这次需求创建过度抽象。

- [ ] **Step 4: 验证配置测试**
  - Run: `pnpm --filter @novel-extractor/config test -- defaults.test.ts configInvariants.test.ts`
  - Expected: PASS。

---

### Task 2: read_file 分页与限量读取

**Files:**
- Modify: `packages/tools/src/toolRegistry.ts`
- Modify: `packages/tools/src/builtinFileTools.ts`
- Test: `packages/tools/src/toolRegistry.test.ts`
- Test: `packages/tools/src/builtinFileTools.test.ts`

- [ ] **Step 1: 写 RED 测试覆盖工具 schema**
  - 在 `toolRegistry.test.ts` 中断言 `read_file` schema 暴露分页/限量/完整读取相关参数。
  - 保持未知字段拒绝能力。
  - Run: `pnpm --filter @novel-extractor/tools test -- toolRegistry.test.ts`
  - Expected: FAIL，原因是 schema 仍只有 `path`。

- [ ] **Step 2: 写 RED 测试覆盖默认片段读取**
  - 在 `builtinFileTools.test.ts` 中构造长文本。
  - 调用 `read_file` 只传 `path`，断言返回片段和分页元信息，不返回全文。
  - Run: `pnpm --filter @novel-extractor/tools test -- builtinFileTools.test.ts`
  - Expected: FAIL，原因是当前返回全文。

- [ ] **Step 3: 写 RED 测试覆盖 offset、limit、head、tail、maxChars、full**
  - 断言中文和 CRLF 文本不会被截坏。
  - 断言 `full` 必须显式声明，且受预算限制。
  - 断言超过预算时返回可恢复的参数错误，不悄悄读取全文。
  - Run: `pnpm --filter @novel-extractor/tools test -- builtinFileTools.test.ts`
  - Expected: FAIL。

- [ ] **Step 4: 实现最小读取行为**
  - 修改 `toolRegistry.ts` 和 `builtinFileTools.ts`。
  - 保留工具层通用性：工具层只理解读取预算和参数，不理解小说窗口、报告来源或桌面流程。
  - 默认片段长度来自执行 context；没有 context 时使用工具层保守默认。

- [ ] **Step 5: 验证工具包测试**
  - Run: `pnpm --filter @novel-extractor/tools test -- toolRegistry.test.ts builtinFileTools.test.ts`
  - Expected: PASS。

---

### Task 3: 桌面 tool-loop 注入读取预算并压缩历史

**Files:**
- Modify: `apps/desktop/src/main/windowRunService.ts`
- Create: `apps/desktop/src/main/<tool-loop-history-module>.ts`
- Test: `apps/desktop/src/main/p0Handlers.test.ts`
- Test: 新模块对应测试文件，必要时新增

- [ ] **Step 1: 写 RED 测试证明 read_file 默认不把长报告全文回灌给模型**
  - 在 `p0Handlers.test.ts` 中让模型读取一个长报告或长窗口。
  - 捕获下一轮请求体。
  - 断言请求体不包含旧工具结果的大段正文，只包含摘要、hash、路径和片段信息。
  - Run: `pnpm --filter @novel-extractor/desktop test -- p0Handlers.test.ts`
  - Expected: FAIL，原因是当前完整 tool result 会进入下一轮 messages。

- [ ] **Step 2: 写 RED 测试证明最近 1-2 组完整工具结果仍保留**
  - 构造连续多个工具调用。
  - 断言最新工具调用组保持完整，旧组被摘要替换。
  - 同时断言 tool-call 协议没有断裂：assistant tool call 与 tool result 仍成组出现。
  - Run: `pnpm --filter @novel-extractor/desktop test -- p0Handlers.test.ts`
  - Expected: FAIL。

- [ ] **Step 3: 提取历史压缩小模块**
  - 在桌面 main 下新增专用模块。
  - `windowRunService.ts` 只负责喂事件、取压缩后的 messages，不直接散写压缩规则。
  - 摘要内容必须包含定位所需信息：工具名、路径、hash、行数或匹配数、片段摘要、错误码。
  - 保留数量、摘要长度从配置读取。

- [ ] **Step 4: 在 tool-loop 中接入压缩器**
  - 发送模型请求前使用压缩后的 messages。
  - 工具执行仍使用真实结果，日志按 Task 5 的摘要规则记录。
  - `executeBuiltinFileTool` 调用时传入 read_file 预算。

- [ ] **Step 5: 验证桌面历史压缩测试**
  - Run: `pnpm --filter @novel-extractor/desktop test -- p0Handlers.test.ts`
  - Expected: 相关用例 PASS；其他旧用例若因为日志或请求体预期改变，按新行为更新断言。

---

### Task 4: Replacement miss 连续失败策略与结构化 Markdown 写入入口

**Files:**
- Modify: `apps/desktop/src/main/windowRunService.ts`
- Create/Modify: `apps/desktop/src/main/<tool-loop-error-policy-module>.ts`
- Modify: `packages/tools/src/toolPolicy.ts`
- Modify: `packages/tools/src/toolRegistry.ts`
- Modify: `packages/tools/src/builtinFileTools.ts`
- Modify: `packages/markdown/src/reportWriter.ts` if selected as Markdown boundary
- Test: `apps/desktop/src/main/p0Handlers.test.ts`
- Test: `packages/tools/src/toolRegistry.test.ts`
- Test: `packages/tools/src/builtinFileTools.test.ts`
- Test: `packages/markdown/src/reportWriter.test.ts` if selected

- [ ] **Step 1: 写 RED 测试覆盖连续 replacement miss**
  - 复用现有 replacement miss 场景。
  - 构造同一窗口、同一报告、同类 exact replace 连续失败。
  - 断言连续失败不超过 1 轮；第二次后必须要求先 grep/read 定位或走结构化写入，不继续猜 oldText。
  - Run: `pnpm --filter @novel-extractor/desktop test -- p0Handlers.test.ts`
  - Expected: FAIL，原因是当前会继续多轮重复错误。

- [ ] **Step 2: 写 RED 测试覆盖结构化 Markdown 写入工具最小行为**
  - 先实现一个最小、通用的 Markdown upsert 能力，优先覆盖“按标题更新或插入段落”。
  - 测试只表达行为：存在标题则更新对应段落，不存在标题则按规则插入；不要求模型手写 exact oldText。
  - Run: `pnpm --filter @novel-extractor/tools test -- toolRegistry.test.ts builtinFileTools.test.ts`
  - Expected: FAIL。

- [ ] **Step 3: 实现 replacement miss 状态跟踪**
  - 新增小模块记录窗口内失败 streak。
  - 第一轮失败返回短提示。
  - 第二轮命中策略阈值后，返回强制定位/结构化写入的可恢复结果，或在无法恢复时给出明确失败原因。
  - 阈值从配置读取。

- [ ] **Step 4: 实现最小结构化 Markdown 写入**
  - 落点优先复用现有 report writer，工具层只暴露必要命令。
  - 不把某个报告模板的标题、章节名、字段写死到工具里。
  - 写入仍受 reports root 安全边界约束。

- [ ] **Step 5: 验证 replacement 与结构化写入测试**
  - Run: `pnpm --filter @novel-extractor/tools test -- toolRegistry.test.ts builtinFileTools.test.ts`
  - Run: `pnpm --filter @novel-extractor/desktop test -- p0Handlers.test.ts`
  - Expected: PASS。

---

### Task 5: TaskTextLogger 摘要日志与 debug 完整日志

**Files:**
- Modify: `apps/desktop/src/main/taskTextLogger.ts`
- Modify: `apps/desktop/src/main/windowRunService.ts`
- Modify: `apps/desktop/src/main/p0Handlers.ts`
- Test: `apps/desktop/src/main/taskTextLogger.test.ts`
- Test: `apps/desktop/src/main/p0Handlers.test.ts`

- [ ] **Step 1: 写 RED 测试覆盖默认摘要日志**
  - 在 `taskTextLogger.test.ts` 中断言普通日志只包含摘要字段、短 preview、hash、token、工具名、错误码。
  - 断言普通日志不包含完整 prompt、完整 messages、完整 tool result 大正文。
  - Run: `pnpm --filter @novel-extractor/desktop test -- taskTextLogger.test.ts`
  - Expected: FAIL。

- [ ] **Step 2: 写 RED 测试覆盖 debug 完整日志**
  - 通过显式开关启用 debug。
  - 断言 debug 产物存在、结构稳定、仍脱敏。
  - 断言默认不开启时不生成 debug 完整日志。
  - Run: `pnpm --filter @novel-extractor/desktop test -- taskTextLogger.test.ts`
  - Expected: FAIL。

- [ ] **Step 3: 实现日志摘要渲染**
  - `TaskTextLogger` 默认对大对象做摘要，而不是递归展开全部内容。
  - 对模型请求、模型返回、工具调用、工具返回分别输出可排查但不爆 token/磁盘的摘要。
  - 保留现有 secret redaction。

- [ ] **Step 4: 接入 debug 完整日志**
  - 完整 prompt/messages/tools/tool result 只在 debug 开关开启时写入结构化文件。
  - 使用新路径和新开关，不复活旧 `tool-loop-traces` 行为。

- [ ] **Step 5: 验证日志相关测试**
  - Run: `pnpm --filter @novel-extractor/desktop test -- taskTextLogger.test.ts p0Handlers.test.ts`
  - Expected: PASS。

---

### Task 6: 公开资料来源生成与写前规范化/拦截

**Files:**
- Modify: `apps/desktop/src/main/windowRunService.ts`
- Create: `apps/desktop/src/main/<report-content-policy-module>.ts`
- Test: `apps/desktop/src/main/p0Handlers.test.ts`

- [ ] **Step 1: 写 RED 测试覆盖公开来源文本**
  - 在桌面 job mock 中捕获 prompt。
  - 断言 prompt 提供公开来源写法，例如窗口编号、章节范围、章节标题。
  - 断言 prompt 不要求模型把 `runs/job`、`window-0001.txt` 写进正式报告来源字段。
  - Run: `pnpm --filter @novel-extractor/desktop test -- p0Handlers.test.ts`
  - Expected: FAIL 或现有断言冲突，原因是 prompt 仍强调内部窗口路径。

- [ ] **Step 2: 写 RED 测试覆盖报告内容禁止内部元数据**
  - 扩展已有内部元数据测试。
  - 断言正式报告不得包含 `runs/job`、`assets/books`、`window-0001`、`AppData`、`后续窗口`。
  - 断言可证明的资料来源行可以被规范化，无法证明或正文位置出现内部元数据则返回 recoverable error。
  - Run: `pnpm --filter @novel-extractor/desktop test -- p0Handlers.test.ts`
  - Expected: FAIL 或部分 FAIL。

- [ ] **Step 3: 实现公开来源生成模块**
  - 从 manifest window 派生公开来源文本。
  - `windowRunService.ts` 只调用该模块，不散写格式拼接。
  - 格式不要依赖内部文件名或本机路径。

- [ ] **Step 4: 接入写前内容策略**
  - 将现有内部元数据正则和新增规范化能力集中到报告内容策略模块。
  - 写工具执行前统一检查。
  - 保持工具层不理解小说 manifest。

- [ ] **Step 5: 验证报告元数据测试**
  - Run: `pnpm --filter @novel-extractor/desktop test -- p0Handlers.test.ts`
  - Expected: PASS。

---

### Task 7: 四窗口 token 回放与验收指标

**Files:**
- Modify: `apps/desktop/src/main/p0Handlers.test.ts`
- Optional Create: `apps/desktop/src/main/<token-replay-fixture>.test.ts`

- [ ] **Step 1: 写 RED 验收回放测试**
  - 用 job-2 前 4 个窗口或等价 fixture。
  - mock provider 记录每次请求体，使用稳定估算函数计算 input token。
  - baseline 使用指定日志统计：平均 `16508.87`、峰值 `41658`。
  - 断言新平均 `<=11556`，新峰值 `<=24994`。
  - Run: `pnpm --filter @novel-extractor/desktop test -- p0Handlers.test.ts`
  - Expected: FAIL，直到分页、压缩、日志和 replacement 策略接入完成。

- [ ] **Step 2: 写 RED 验收报告污染测试**
  - 同一回放中读取最终报告。
  - 断言报告不包含 `runs/job`、`assets/books`、`window-0001`、`AppData`、`后续窗口`。
  - Run: `pnpm --filter @novel-extractor/desktop test -- p0Handlers.test.ts`
  - Expected: FAIL 或现有行为不稳定。

- [ ] **Step 3: 修正回放 fixture**
  - 保持 fixture 小而稳定，不依赖真实 LLM。
  - mock usage 不直接写死成验收结果；由请求体和 baseline 阈值推导。

- [ ] **Step 4: 验证回放指标**
  - Run: `pnpm --filter @novel-extractor/desktop test -- p0Handlers.test.ts`
  - Expected: PASS，且输出可从测试失败信息中定位平均/峰值。

---

### Task 8: 全量回归与计划验收

**Files:**
- No production file ownership.
- Test: workspace tests and typecheck.

- [ ] **Step 1: 运行目标测试**
  - Run: `pnpm vitest run apps/desktop/src/main/p0Handlers.test.ts apps/desktop/src/main/taskTextLogger.test.ts packages/tools/src/builtinFileTools.test.ts packages/tools/src/toolRegistry.test.ts packages/config/src/defaults.test.ts packages/config/src/configInvariants.test.ts packages/extraction/src/runtimeWindows.test.ts --passWithNoTests`
  - Expected: PASS。

- [ ] **Step 2: 运行现有测试**
  - Run: `pnpm test:ts`
  - Expected: PASS。

- [ ] **Step 3: 运行类型检查**
  - Run: `pnpm typecheck`
  - Expected: PASS。

- [ ] **Step 4: 检查 diff**
  - Run: `git -c core.quotePath=false diff --name-only`
  - Expected: 只包含本计划相关文件。
  - Run: `git -c core.quotePath=false diff --check`
  - Expected: 没有真实 whitespace error；换行转换提示只记录为环境噪声。

- [ ] **Step 5: 汇报验收结果**
  - 汇报平均 input token、峰值 input token、replacement 连续失败最大值、报告污染词检查、测试命令结果。
  - 如遇环境/编码/依赖导致流程变慢，按项目规则主动说明并询问是否沉淀为规则。

---

## 自查

- **Spec coverage:** 当前优先级 1-5 均有任务覆盖；结构性二阶段优化已明确不在本轮落地。
- **通用架构:** 工具能力、桌面编排、报告内容策略、日志策略拆边界，不把领域规则塞进通用工具层。
- **设计模式适配:** 用策略注入和 transcript/compactor 思路组织实现，避免在 `windowRunService.ts` 中堆条件分支。
- **配置化覆盖范围:** 读取预算、完整读取预算、历史保留数量、摘要长度、replacement miss 连续上限、日志模式和 debug 开关都由配置提供。
- **硬编码检查:** 计划没有规定最终接口字段全集、具体类型名或函数签名；实施阶段必须由 RED 测试驱动最小形状。
