# upsert_report_section 新增卡片与字段块 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `upsert_report_section` 支持直接新增卡片、直接新增字段块，并在报告文件不存在时自动创建报告，避免模型为了铺底退回 `write_file` / `read_file` / `multi_edit`。

**Architecture:** 把“新增 / 已存在返回现有内容 / 替换既有字段”的判断沉到 `packages/tools/src/reportFieldBlocks.ts` 纯函数层，工具运行时只负责参数校验、安全路径、读写文件和结构化返回。桌面端提示和 guard 同步改成：新增走 `upsert_report_section`，替换既有字段仍需要先读取同一字段；`add_*` 命中既有内容时不写文件，也不能被运行时当作“报告已写入”。

**Tech Stack:** TypeScript、Vitest、pnpm workspace、Electron desktop main process、Reasonix tool schema。

---

## 已确认的问题

最新日志 `C:\Users\Administrator\AppData\Roaming\@novel-extractor\desktop\projects\project-1w0t5sx\runs\job-1\logs\20260706-082058.simple.txt` 显示同一窗口里反复出现：

- `报告字段更新返回可恢复错误` 后，模型退回 `读取文件`、`批量更新报告`。
- `20260706-082058.txt` 的 prompt 仍写着：`待创建报告不要先调用 read_file 或 read_report_excerpt；有可写入信息时直接用 write_file 创建并写入完整报告正文。`

当前代码也印证这个问题：

- `packages/tools/src/reportFieldBlocks.ts` 的 `replaceReportFieldBlocks` 遇到缺卡片或缺字段会返回 `CARD_NOT_FOUND` / `FIELD_NOT_FOUND`。
- `packages/tools/src/reasonix/workspace.ts` 的工具描述写明 `不隐式创建新卡片或新字段`。
- `apps/desktop/src/main/windowRunService.ts` 的待创建报告提示仍引导模型用 `write_file` 创建完整报告。

## 协议设计

`upsert_report_section` 保留现有 `updates` 数组，但每个 update 增加可选 `operation` 字段：

```json
{
  "outputFileName": "NPC性格与代表事件.md",
  "updates": [
    {
      "operation": "add_card",
      "cardName": "舞岩",
      "content": "### 舞岩\n\n- 角色定位：七玄门相关少年。\n- 核心性格：原文未说明。"
    },
    {
      "operation": "add_field",
      "cardName": "韩立",
      "fieldName": "变化与后果",
      "content": "- 变化与后果：本窗口新增了入门前的处境变化。"
    },
    {
      "operation": "replace_field",
      "cardName": "韩立",
      "fieldName": "核心性格",
      "content": "- 核心性格：谨慎、隐忍。\n  - 证据：当前窗口原文..."
    }
  ]
}
```

语义如下：

- `operation` 缺省值为 `replace_field`，保证现有调用保持替换语义。
- `add_card`：卡片不存在则追加卡片；报告不存在则创建 `# 报告名` + 卡片。卡片已存在时不写文件，返回该卡片完整内容和“卡片已存在，请基于已有内容按修改/替换逻辑继续”的消息。
- `add_field`：字段不存在则在目标卡片末尾追加字段；卡片不存在则创建卡片后追加字段；报告不存在则创建报告、卡片、字段。字段已存在时不写文件，返回该字段块内容和“字段块已存在，请基于已有内容修改”的消息。
- `replace_field`：保持现有替换行为，替换前必须通过 `read_report_excerpt` 读取同一报告、同一卡片、同一字段。缺卡片或缺字段仍返回可恢复错误，不自动猜测替换位置。
- 同一次调用按 `updates` 顺序预扫描 `add_card` / `add_field` 的既有目标；遇到第一个已存在目标时立即返回该目标的 `existingContent`，`operations` 只包含这个命中结果，整次调用不写文件，其后的 update 不再执行，避免半批次写入后还要求模型重新决策。
- 桌面端内容安全 guard 仍先检查所有新增/替换请求的 `updates[].content`；即使 `add_card` / `add_field` 会命中已存在目标，只要传入 content 包含内部元数据或 secret 等违规内容，也必须先拒绝，不读取报告、不返回 `existingContent`。

`upsert_report_section` 返回 JSON 字符串，便于桌面端判断是否真的写入：

```json
{
  "outputFileName": "NPC性格与代表事件.md",
  "changed": false,
  "operations": [
    {
      "operation": "add_field",
      "status": "field_already_exists",
      "cardName": "韩立",
      "fieldName": "核心性格",
      "existingContent": "- 核心性格：谨慎。",
      "message": "字段块已存在，请基于 existingContent 修改后使用 replace_field 替换。"
    }
  ],
  "message": "没有写入文件；请基于返回的既有内容继续修改。"
}
```

---

## 文件结构

- Modify: `packages/tools/src/reportFieldBlocks.ts`：新增字段写入 operation 类型、卡片读取、报告创建、卡片追加、字段追加和结构化写入结果。
- Modify: `packages/tools/src/reportFieldBlocks.test.ts`：补新增卡片、字段、报告创建、已存在返回内容、替换兼容性测试。
- Modify: `packages/tools/src/builtinFileTools.ts`：解析 `operation`，调用新的字段写入函数，根据 `changed` 决定是否落盘，返回 JSON，并把 `INVALID_CARD_CONTENT` 纳入 `ToolExecutionError` code union。
- Modify: `packages/tools/src/builtinFileTools.test.ts`：补工具层文件创建、安全路径、既有内容返回、不落盘测试。
- Modify: `packages/tools/src/reasonix/workspace.ts`：更新 `upsert_report_section` 描述和 schema。
- Modify: `packages/tools/src/toolRegistry.test.ts`、`packages/llm/src/toolDefinition.test.ts`、`packages/llm/src/protocols/*.test.ts`：同步工具 schema/描述断言。
- Modify: `packages/config/src/defaults.ts`、`packages/config/src/defaults.test.ts`：把默认提示改为待创建报告可直接用 `upsert_report_section add_card/add_field`。
- Modify: `apps/desktop/src/main/windowRunService.ts`：新增操作不要求先读；替换操作继续要求先读；`changed:false` 的 upsert 结果不能登记为成功写入或完成模板结果；纠偏消息优先引导 `upsert_report_section add_card/add_field/replace_field`。
- Modify: `apps/desktop/src/main/windowRunService.test.ts`、`apps/desktop/src/main/p0Handlers.test.ts`：补桌面端回归。
- Modify: `apps/desktop/src/main/toolErrorClassification.ts`、`apps/desktop/src/main/toolErrorClassification.test.ts`：补齐 `INVALID_CARD_CONTENT` 字段报告错误码分类；调整不再把 `CARD_NOT_FOUND` / `FIELD_NOT_FOUND` 当作新增失败主路径，只保留 `replace_field` 可恢复错误。
- Modify: `docs/提取流程大白话梳理.md`：更新默认提取链路说明，避免文档继续建议待创建报告先走 `write_file`。

---

### Task 1: 纯字段块模块 RED 测试

**Files:**
- Modify: `packages/tools/src/reportFieldBlocks.test.ts`

- [ ] **Step 1: 写 RED 测试覆盖新增卡片、字段和报告创建**

在 `packages/tools/src/reportFieldBlocks.test.ts` 追加：

```ts
import { applyReportFieldUpdates } from "./reportFieldBlocks";

describe("report field update operations", () => {
  it("creates a missing report with a title and a new card", () => {
    const result = applyReportFieldUpdates({
      outputFileName: "NPC性格与代表事件.md",
      content: "",
      updates: [
        {
          operation: "add_card",
          cardName: "舞岩",
          content: "### 舞岩\n\n- 角色定位：七玄门相关少年。\n- 核心性格：原文未说明。"
        }
      ]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.content).toBe(
      "# NPC性格与代表事件\n\n### 舞岩\n\n- 角色定位：七玄门相关少年。\n- 核心性格：原文未说明。\n"
    );
    expect(result.operations[0]).toMatchObject({
      operation: "add_card",
      status: "created_report_and_card",
      cardName: "舞岩"
    });
  });

  it("creates a missing report with a title, card, and field when add_field starts from empty content", () => {
    const result = applyReportFieldUpdates({
      outputFileName: "NPC性格与代表事件.md",
      content: "",
      updates: [
        {
          operation: "add_field",
          cardName: "韩立",
          fieldName: "变化与后果",
          content: "- 变化与后果：本窗口新增了入门机会。"
        }
      ]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.content).toBe(
      "# NPC性格与代表事件\n\n### 韩立\n\n- 变化与后果：本窗口新增了入门机会。\n"
    );
    expect(result.operations[0]).toMatchObject({
      operation: "add_field",
      status: "created_report_card_and_field",
      cardName: "韩立",
      fieldName: "变化与后果"
    });
  });

  it("returns the existing card content when add_card targets an existing card", () => {
    const result = applyReportFieldUpdates({
      outputFileName: "NPC性格与代表事件.md",
      content: "### 韩立\n- 核心性格：谨慎\n- 代表行为：旧行为\n\n### 舞岩\n- 核心性格：傲慢\n",
      updates: [
        {
          operation: "add_card",
          cardName: "韩立",
          content: "### 韩立\n- 核心性格：新内容"
        }
      ]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
    expect(result.content).toBe("### 韩立\n- 核心性格：谨慎\n- 代表行为：旧行为\n\n### 舞岩\n- 核心性格：傲慢\n");
    expect(result.operations[0]).toMatchObject({
      operation: "add_card",
      status: "card_already_exists",
      existingContent: "### 韩立\n- 核心性格：谨慎\n- 代表行为：旧行为"
    });
    expect(result.operations[0].message).toContain("卡片已存在");
  });

  it("adds a missing field to an existing card", () => {
    const result = applyReportFieldUpdates({
      outputFileName: "NPC性格与代表事件.md",
      content: "### 韩立\n- 核心性格：谨慎\n",
      updates: [
        {
          operation: "add_field",
          cardName: "韩立",
          fieldName: "变化与后果",
          content: "- 变化与后果：被选入七玄门。"
        }
      ]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.content).toBe("### 韩立\n- 核心性格：谨慎\n- 变化与后果：被选入七玄门。\n");
    expect(result.operations[0]).toMatchObject({
      operation: "add_field",
      status: "created_field",
      cardName: "韩立",
      fieldName: "变化与后果"
    });
  });

  it("creates a missing card when add_field targets a new card", () => {
    const result = applyReportFieldUpdates({
      outputFileName: "NPC性格与代表事件.md",
      content: "# NPC性格与代表事件\n",
      updates: [
        {
          operation: "add_field",
          cardName: "厉飞雨",
          fieldName: "核心性格",
          content: "- 核心性格：原文未说明。"
        }
      ]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.content).toBe("# NPC性格与代表事件\n\n### 厉飞雨\n\n- 核心性格：原文未说明。\n");
    expect(result.operations[0]).toMatchObject({
      operation: "add_field",
      status: "created_card_and_field"
    });
  });

  it("returns the existing field block when add_field targets an existing field", () => {
    const original = "### 韩立\n- 核心性格：谨慎\n  - 证据：先观察\n- 代表行为：旧行为\n";
    const result = applyReportFieldUpdates({
      outputFileName: "NPC性格与代表事件.md",
      content: original,
      updates: [
        {
          operation: "add_field",
          cardName: "韩立",
          fieldName: "核心性格",
          content: "- 核心性格：新内容"
        }
      ]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
    expect(result.content).toBe(original);
    expect(result.operations[0]).toMatchObject({
      operation: "add_field",
      status: "field_already_exists",
      existingContent: "- 核心性格：谨慎\n  - 证据：先观察"
    });
    expect(result.operations[0].message).toContain("字段块已存在");
  });

  it("pre-scans the full batch before writing when a later add_field target already exists", () => {
    const original = "### 韩立\n- 核心性格：谨慎\n";
    const result = applyReportFieldUpdates({
      outputFileName: "NPC性格与代表事件.md",
      content: original,
      updates: [
        {
          operation: "add_card",
          cardName: "舞岩",
          content: "### 舞岩\n\n- 核心性格：原文未说明。"
        },
        {
          operation: "add_field",
          cardName: "韩立",
          fieldName: "核心性格",
          content: "- 核心性格：新内容"
        }
      ]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
    expect(result.content).toBe(original);
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toMatchObject({
      operation: "add_field",
      status: "field_already_exists",
      cardName: "韩立",
      fieldName: "核心性格",
      existingContent: "- 核心性格：谨慎"
    });
  });

  it("pre-scans the full batch before writing when a later add_card target already exists", () => {
    const original = "### 韩立\n- 核心性格：谨慎\n";
    const result = applyReportFieldUpdates({
      outputFileName: "NPC性格与代表事件.md",
      content: original,
      updates: [
        {
          operation: "add_field",
          cardName: "舞岩",
          fieldName: "核心性格",
          content: "- 核心性格：原文未说明。"
        },
        {
          operation: "add_card",
          cardName: "韩立",
          content: "### 韩立\n- 核心性格：新内容"
        }
      ]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
    expect(result.content).toBe(original);
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toMatchObject({
      operation: "add_card",
      status: "card_already_exists",
      cardName: "韩立",
      existingContent: original.trimEnd()
    });
  });

  it("adds a missing card heading and preserves CRLF when add_card content has no heading", () => {
    const result = applyReportFieldUpdates({
      outputFileName: "NPC性格与代表事件.md",
      content: "# NPC性格与代表事件\r\n",
      updates: [
        {
          operation: "add_card",
          cardName: "舞岩",
          content: "- 核心性格：原文未说明。"
        }
      ]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.content).toBe("# NPC性格与代表事件\r\n\r\n### 舞岩\r\n\r\n- 核心性格：原文未说明。\r\n");
  });

  it("keeps replace_field compatible with the existing replacement behavior", () => {
    const result = applyReportFieldUpdates({
      outputFileName: "NPC性格与代表事件.md",
      content: "### 韩立\n- 核心性格：旧\n- 代表行为：旧行为\n",
      updates: [
        {
          operation: "replace_field",
          cardName: "韩立",
          fieldName: "核心性格",
          content: "- 核心性格：新"
        }
      ]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.content).toBe("### 韩立\n- 核心性格：新\n- 代表行为：旧行为\n");
  });
});
```

- [ ] **Step 2: 运行 RED 测试**

Run:

```powershell
pnpm --filter @novel-extractor/tools test -- reportFieldBlocks
```

Expected: FAIL，错误包含 `applyReportFieldUpdates` 未导出或新增 operation 行为未实现。

---

### Task 2: 实现字段块新增与结构化写入结果

**Files:**
- Modify: `packages/tools/src/reportFieldBlocks.ts`

- [ ] **Step 1: 新增写入 operation 类型和结果类型**

在 `ReportFieldUpdate` 附近替换为：

```ts
export type ReportFieldReplaceUpdate = {
  operation?: "replace_field";
  cardName: string;
  fieldName: string;
  content: string;
};

export type ReportFieldAddFieldUpdate = {
  operation: "add_field";
  cardName: string;
  fieldName: string;
  content: string;
};

export type ReportFieldAddCardUpdate = {
  operation: "add_card";
  cardName: string;
  content: string;
};

export type ReportFieldUpdate = ReportFieldReplaceUpdate | ReportFieldAddFieldUpdate | ReportFieldAddCardUpdate;

export type NormalizedReportFieldUpdate =
  | (Omit<ReportFieldReplaceUpdate, "operation"> & { operation: "replace_field" })
  | ReportFieldAddFieldUpdate
  | ReportFieldAddCardUpdate;

export type ReportFieldWriteOperationResult =
  | {
      operation: "add_card";
      status: "created_report_and_card" | "created_card" | "card_already_exists";
      cardName: string;
      existingContent?: string;
      message?: string;
    }
  | {
      operation: "add_field";
      status: "created_report_card_and_field" | "created_card_and_field" | "created_field" | "field_already_exists";
      cardName: string;
      fieldName: string;
      existingContent?: string;
      message?: string;
    }
  | {
      operation: "replace_field";
      status: "replaced_field";
      cardName: string;
      fieldName: string;
    };

export type ReportFieldWriteResult =
  | {
      ok: true;
      outputFileName: string;
      changed: boolean;
      content: string;
      operations: ReportFieldWriteOperationResult[];
      message: string;
    }
  | {
      ok: false;
      code: "CARD_NOT_FOUND" | "FIELD_NOT_FOUND" | "FIELD_AMBIGUOUS" | "INVALID_FIELD_CONTENT" | "INVALID_CARD_CONTENT";
      message: string;
};
```

同时把现有 `replaceReportFieldBlocks` 的入参签名改为：

```ts
export function replaceReportFieldBlocks(input: {
  content: string;
  updates: readonly ReportFieldReplaceUpdate[];
}): ReportFieldBlockUpdateResult
```

函数体保持现有替换逻辑，只调整类型边界。

- [ ] **Step 2: 新增 `applyReportFieldUpdates`，先检测已存在新增目标**

实现要点：

```ts
export function applyReportFieldUpdates(input: {
  outputFileName: string;
  content: string;
  updates: readonly ReportFieldUpdate[];
}): ReportFieldWriteResult {
  const lineEnding = detectDominantLineEnding(input.content);
  const normalizedUpdates: NormalizedReportFieldUpdate[] = input.updates.map(normalizeWriteOperation);
  const existingResult = findExistingAddTarget(input.content, normalizedUpdates);
  if (existingResult !== undefined) {
    return {
      ok: true,
      outputFileName: input.outputFileName,
      changed: false,
      content: input.content,
      operations: [existingResult],
      message: "没有写入文件；请基于返回的既有内容继续修改。"
    };
  }

  let content = input.content;
  const operations: ReportFieldWriteOperationResult[] = [];

  for (const update of normalizedUpdates) {
    if (update.operation === "add_card") {
      const result = addCardBlock({ outputFileName: input.outputFileName, content, update, lineEnding });
      content = result.content;
      operations.push(result.operation);
      continue;
    }

    if (update.operation === "add_field") {
      const result = addFieldBlock({ outputFileName: input.outputFileName, content, update, lineEnding });
      content = result.content;
      operations.push(result.operation);
      continue;
    }

    if (update.operation === "replace_field") {
      const replaceUpdate: ReportFieldReplaceUpdate = update;
      const replaced = replaceReportFieldBlocks({ content, updates: [replaceUpdate] });
      if (!replaced.ok) {
        return replaced;
      }
      content = replaced.content;
      operations.push({ operation: "replace_field", status: "replaced_field", cardName: update.cardName, fieldName: update.fieldName });
      continue;
    }
  }

  return {
    ok: true,
    outputFileName: input.outputFileName,
    changed: content !== input.content,
    content,
    operations,
    message: content !== input.content ? "报告字段写入完成。" : "没有写入文件。"
  };
}
```

`findExistingAddTarget` 必须使用现有 `parseCards` / `parseFieldsInCard`，不能用字符串包含判断。它按 `updates` 顺序返回第一个已存在的新增目标，`add_card` 返回卡片完整范围，`add_field` 返回字段块范围；命中后不继续扫描或执行后续 update。

类型闭合要求：

- `replaceReportFieldBlocks` 只能接受 `readonly ReportFieldReplaceUpdate[]`，不能接受完整 `ReportFieldUpdate[]` 或 `NormalizedReportFieldUpdate[]`。
- `normalizeWriteOperation` 返回 `NormalizedReportFieldUpdate`，把缺省 `operation` 明确补成 `"replace_field"`。
- 调用 `replaceReportFieldBlocks` 前必须经过 `update.operation === "replace_field"` 收窄，并把收窄后的值赋给 `ReportFieldReplaceUpdate` 变量；不能把完整 union 直接传入，否则 `add_card` 分支没有 `fieldName` 会在 TypeScript 中不闭合。

- [ ] **Step 3: 新增卡片和字段拼接 helper**

实现 helper 时遵守这些规则：

- 空报告创建 `# ${path.basename(outputFileName, path.extname(outputFileName))}`。
- `add_card.content` 若已经以 `### 卡片名` 开头，保留该标题；若没有标题，工具自动补 `### 卡片名`。
- `add_card.content` 若以其他 `### xxx` 开头，返回 `INVALID_CARD_CONTENT`。
- `add_field.content` 继续复用现有 `parseFieldLine` 校验，必须以 `- 字段名：` 或 `- 字段名:` 开头。
- 追加字段时插入到该卡片正文末尾、下一个卡片标题之前。
- 保持原文件主导换行风格；空报告默认 `\n`。

- [ ] **Step 4: 运行字段模块测试**

Run:

```powershell
pnpm --filter @novel-extractor/tools test -- reportFieldBlocks
```

Expected: PASS。

---

### Task 3: 接入 builtin 工具运行时

**Files:**
- Modify: `packages/tools/src/builtinFileTools.ts`
- Modify: `packages/tools/src/builtinFileTools.test.ts`

- [ ] **Step 1: 写 RED 工具层测试**

在 `packages/tools/src/builtinFileTools.test.ts` 的 `upsert_report_section` 用例附近追加：

```ts
it("upsert_report_section add_card creates a missing selected report without write_file", async () => {
  const context = makeContext();
  const reportPath = path.join(context.reportsRoot, "NPC性格与代表事件.md");

  const resultText = await executeBuiltinFileTool(
    "upsert_report_section",
    {
      outputFileName: "NPC性格与代表事件.md",
      updates: [
        {
          operation: "add_card",
          cardName: "舞岩",
          content: "### 舞岩\n\n- 角色定位：七玄门少年。"
        }
      ]
    },
    { ...context, allowedReportFileNames: ["NPC性格与代表事件.md"] }
  );

  const result = JSON.parse(resultText);
  expect(result).toMatchObject({
    outputFileName: "NPC性格与代表事件.md",
    changed: true,
    operations: [{ operation: "add_card", status: "created_report_and_card", cardName: "舞岩" }]
  });
  expect(fs.readFileSync(reportPath, "utf8")).toBe("# NPC性格与代表事件\n\n### 舞岩\n\n- 角色定位：七玄门少年。\n");
});

it("upsert_report_section add_field creates a missing selected report without write_file", async () => {
  const context = makeContext();
  const reportPath = path.join(context.reportsRoot, "NPC性格与代表事件.md");
  expect(fs.existsSync(reportPath)).toBe(false);

  const resultText = await executeBuiltinFileTool(
    "upsert_report_section",
    {
      outputFileName: "NPC性格与代表事件.md",
      updates: [
        {
          operation: "add_field",
          cardName: "韩立",
          fieldName: "变化与后果",
          content: "- 变化与后果：本窗口新增了入门机会。"
        }
      ]
    },
    { ...context, allowedReportFileNames: ["NPC性格与代表事件.md"] }
  );

  const result = JSON.parse(resultText);
  expect(result).toMatchObject({
    outputFileName: "NPC性格与代表事件.md",
    changed: true,
    operations: [
      {
        operation: "add_field",
        status: "created_report_card_and_field",
        cardName: "韩立",
        fieldName: "变化与后果"
      }
    ]
  });
  expect(fs.existsSync(reportPath)).toBe(true);
  expect(fs.readFileSync(reportPath, "utf8")).toBe(
    "# NPC性格与代表事件\n\n### 韩立\n\n- 变化与后果：本窗口新增了入门机会。\n"
  );
});

it("upsert_report_section add_card returns existing card content without rewriting", async () => {
  const context = makeContext();
  const reportPath = path.join(context.reportsRoot, "NPC性格与代表事件.md");
  const original = "### 韩立\n- 核心性格：谨慎\n";
  fs.writeFileSync(reportPath, original, "utf8");

  const resultText = await executeBuiltinFileTool(
    "upsert_report_section",
    {
      outputFileName: "NPC性格与代表事件.md",
      updates: [
        {
          operation: "add_card",
          cardName: "韩立",
          content: "### 韩立\n- 核心性格：新"
        }
      ]
    },
    { ...context, allowedReportFileNames: ["NPC性格与代表事件.md"] }
  );

  const result = JSON.parse(resultText);
  expect(result).toMatchObject({
    changed: false,
    operations: [{ operation: "add_card", status: "card_already_exists", existingContent: original.trimEnd() }]
  });
  expect(fs.readFileSync(reportPath, "utf8")).toBe(original);
});

it("upsert_report_section add_card rejects mismatched card heading with INVALID_CARD_CONTENT", async () => {
  const context = makeContext();

  await expect(executeBuiltinFileTool(
    "upsert_report_section",
    {
      outputFileName: "NPC性格与代表事件.md",
      updates: [
        {
          operation: "add_card",
          cardName: "韩立",
          content: "### 舞岩\n\n- 核心性格：标题不匹配。"
        }
      ]
    },
    { ...context, allowedReportFileNames: ["NPC性格与代表事件.md"] }
  )).rejects.toMatchObject({
    code: "INVALID_CARD_CONTENT"
  });
});

it("upsert_report_section add_field creates missing card and returns JSON", async () => {
  const context = makeContext();
  const reportPath = path.join(context.reportsRoot, "NPC性格与代表事件.md");
  fs.writeFileSync(reportPath, "# NPC性格与代表事件\n", "utf8");

  const resultText = await executeBuiltinFileTool(
    "upsert_report_section",
    {
      outputFileName: "NPC性格与代表事件.md",
      updates: [
        {
          operation: "add_field",
          cardName: "厉飞雨",
          fieldName: "核心性格",
          content: "- 核心性格：原文未说明。"
        }
      ]
    },
    { ...context, allowedReportFileNames: ["NPC性格与代表事件.md"] }
  );

  const result = JSON.parse(resultText);
  expect(result).toMatchObject({
    changed: true,
    operations: [{ operation: "add_field", status: "created_card_and_field", cardName: "厉飞雨", fieldName: "核心性格" }]
  });
  expect(fs.readFileSync(reportPath, "utf8")).toContain("### 厉飞雨\n\n- 核心性格：原文未说明。");
});

it("upsert_report_section add_field returns existing field content without throwing", async () => {
  const context = makeContext();
  const reportPath = path.join(context.reportsRoot, "NPC性格与代表事件.md");
  fs.writeFileSync(reportPath, "### 韩立\n- 核心性格：谨慎\n- 代表行为：旧\n", "utf8");

  const resultText = await executeBuiltinFileTool(
    "upsert_report_section",
    {
      outputFileName: "NPC性格与代表事件.md",
      updates: [
        {
          operation: "add_field",
          cardName: "韩立",
          fieldName: "核心性格",
          content: "- 核心性格：新"
        }
      ]
    },
    { ...context, allowedReportFileNames: ["NPC性格与代表事件.md"] }
  );

  const result = JSON.parse(resultText);
  expect(result).toMatchObject({
    changed: false,
    operations: [{ operation: "add_field", status: "field_already_exists", existingContent: "- 核心性格：谨慎" }]
  });
  expect(fs.readFileSync(reportPath, "utf8")).toBe("### 韩立\n- 核心性格：谨慎\n- 代表行为：旧\n");
});

it("upsert_report_section pre-scans a batch and does not write earlier add_card when a later add_field exists", async () => {
  const context = makeContext();
  const reportPath = path.join(context.reportsRoot, "NPC性格与代表事件.md");
  const original = "### 韩立\n- 核心性格：谨慎\n";
  fs.writeFileSync(reportPath, original, "utf8");

  const resultText = await executeBuiltinFileTool(
    "upsert_report_section",
    {
      outputFileName: "NPC性格与代表事件.md",
      updates: [
        {
          operation: "add_card",
          cardName: "舞岩",
          content: "### 舞岩\n\n- 核心性格：原文未说明。"
        },
        {
          operation: "add_field",
          cardName: "韩立",
          fieldName: "核心性格",
          content: "- 核心性格：新"
        }
      ]
    },
    { ...context, allowedReportFileNames: ["NPC性格与代表事件.md"] }
  );

  const result = JSON.parse(resultText);
  expect(result).toMatchObject({
    changed: false,
    operations: [{ operation: "add_field", status: "field_already_exists", cardName: "韩立", fieldName: "核心性格" }]
  });
  expect(result.operations).toHaveLength(1);
  expect(fs.readFileSync(reportPath, "utf8")).toBe(original);
});

it("upsert_report_section pre-scans a batch and does not write earlier add_field when a later add_card exists", async () => {
  const context = makeContext();
  const reportPath = path.join(context.reportsRoot, "NPC性格与代表事件.md");
  const original = "### 韩立\n- 核心性格：谨慎\n";
  fs.writeFileSync(reportPath, original, "utf8");

  const resultText = await executeBuiltinFileTool(
    "upsert_report_section",
    {
      outputFileName: "NPC性格与代表事件.md",
      updates: [
        {
          operation: "add_field",
          cardName: "舞岩",
          fieldName: "核心性格",
          content: "- 核心性格：原文未说明。"
        },
        {
          operation: "add_card",
          cardName: "韩立",
          content: "### 韩立\n- 核心性格：新"
        }
      ]
    },
    { ...context, allowedReportFileNames: ["NPC性格与代表事件.md"] }
  );

  const result = JSON.parse(resultText);
  expect(result).toMatchObject({
    changed: false,
    operations: [{ operation: "add_card", status: "card_already_exists", cardName: "韩立", existingContent: original.trimEnd() }]
  });
  expect(result.operations).toHaveLength(1);
  expect(fs.readFileSync(reportPath, "utf8")).toBe(original);
});

it.each([
  {
    name: "invalid operation",
    update: { operation: "append_field", cardName: "韩立", fieldName: "核心性格", content: "- 核心性格：谨慎" }
  },
  {
    name: "add_field without fieldName",
    update: { operation: "add_field", cardName: "韩立", content: "- 核心性格：谨慎" }
  },
  {
    name: "replace_field without fieldName",
    update: { operation: "replace_field", cardName: "韩立", content: "- 核心性格：谨慎" }
  },
  {
    name: "default replace_field without fieldName",
    update: { cardName: "韩立", content: "- 核心性格：谨慎" }
  }
])("upsert_report_section rejects invalid update arguments: $name", async ({ update }) => {
  const context = makeContext();

  await expect(executeBuiltinFileTool(
    "upsert_report_section",
    {
      outputFileName: "NPC性格与代表事件.md",
      updates: [update]
    },
    { ...context, allowedReportFileNames: ["NPC性格与代表事件.md"] }
  )).rejects.toMatchObject({
    code: "INVALID_ARGUMENTS"
  });
});
```

- [ ] **Step 2: 运行 RED 工具层测试**

Run:

```powershell
pnpm --filter @novel-extractor/tools test -- builtinFileTools
```

Expected: FAIL，当前 `operation` 不被接受或仍返回 `CARD_NOT_FOUND`。

- [ ] **Step 3: 修改 `executeUpsertReportSection`**

实现点：

- `normalizeReportFieldUpdates` 支持 `operation`，只允许 `add_card`、`add_field`、`replace_field` 或缺省。
- `assertAllowedUpsertReportSectionArguments` 仍只允许顶层 `outputFileName`、`updates`。
- `add_card` 不要求 `fieldName`。
- `replace_field` / `add_field` 要求 `fieldName`。
- 非法 `operation`、`add_field` 缺少 `fieldName`、`replace_field` 缺少 `fieldName`、缺省 operation 缺少 `fieldName`，都必须在运行时参数归一化阶段稳定抛出 `ToolExecutionError`，`code: "INVALID_ARGUMENTS"`，不要落到字段块实现层。
- 调用 `applyReportFieldUpdates`。
- `ToolExecutionError` 的 `code` union 增加 `"INVALID_CARD_CONTENT"`，确保 `applyReportFieldUpdates` 返回该错误时不会被 TypeScript 拒绝或被降级成通用参数错误。
- 只有 `result.changed === true` 时才 `writeFile`。
- 返回 `JSON.stringify(stripContentFromResult(result))` 时不要返回完整 `content`，只返回 `changed`、`operations`、`message`、`outputFileName`；`existingContent` 必须保留给模型。

核心代码形状：

```ts
const currentContent = await readReportFileIfExists(reportPath);
const result = applyReportFieldUpdates({ outputFileName, content: currentContent, updates });
if (!result.ok) {
  throw new ToolExecutionError(result.message, result.code);
}

if (result.changed) {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, result.content, "utf8");
}

return JSON.stringify({
  outputFileName: result.outputFileName,
  changed: result.changed,
  operations: result.operations,
  message: result.message
});
```

- [ ] **Step 4: 更新旧测试期望**

先全文搜索所有旧返回断言：

```powershell
rtk rg -n "updated report fields|updated report field" packages/tools/src packages/llm/src apps/desktop/src
```

把所有命中的 `upsert_report_section` 旧返回断言从字符串匹配改成 JSON 解析断言，不能只改当前失败用例。现有 `upsert_report_section replaces selected field blocks without old_string` 不再断言字符串 `updated report fields ...`，改成解析 JSON：

```ts
const parsed = JSON.parse(result);
expect(parsed).toMatchObject({
  outputFileName: "NPC性格与代表事件.md",
  changed: true,
  operations: [{ operation: "replace_field", status: "replaced_field", cardName: "韩立", fieldName: "核心性格" }]
});
```

特别更新 `recovers JSON-stringified array fields for report and edit tools`：如果该测试当前断言旧字符串 `updated report fields ...`，改成对对应 tool result 做 `JSON.parse`，断言 `changed: true` 和 `operations` 中的 `replace_field/replaced_field`，同时保留 edit 工具原有恢复断言。示例形状：

```ts
const parsedUpsertResult = JSON.parse(String(upsertToolResult));
expect(parsedUpsertResult).toMatchObject({
  changed: true,
  operations: [{ operation: "replace_field", status: "replaced_field" }]
});
```

- [ ] **Step 5: 运行工具层测试**

Run:

```powershell
pnpm --filter @novel-extractor/tools test -- builtinFileTools reportFieldBlocks
```

Expected: PASS。

---

### Task 4: 更新工具 schema、描述和协议投影测试

**Files:**
- Modify: `packages/tools/src/reasonix/workspace.ts`
- Modify: `packages/tools/src/toolRegistry.test.ts`
- Modify: `packages/llm/src/toolDefinition.test.ts`
- Modify: `packages/llm/src/protocols/anthropicMessages.test.ts`
- Modify: `packages/llm/src/protocols/openaiChat.test.ts`
- Modify: `packages/llm/src/protocols/openaiResponses.test.ts`
- Modify: `packages/llm/src/protocols/toolSchemaProjection.test.ts`

- [ ] **Step 1: 写 schema RED 断言**

在 `packages/tools/src/toolRegistry.test.ts` 更新 `upsert_report_section` 断言：

```ts
const tool = tools.find((candidate) => candidate.name === "upsert_report_section");
expect(tool).toBeDefined();
expect(tool?.parameters).toMatchObject({
  type: "object",
  properties: {
    outputFileName: { type: "string" },
    updates: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["cardName", "content"],
        additionalProperties: false,
        properties: {
          operation: {
            type: "string",
            enum: ["add_card", "add_field", "replace_field"]
          },
          cardName: { type: "string" },
          fieldName: { type: "string" },
          content: { type: "string" }
        }
      }
    }
  },
  required: ["outputFileName", "updates"],
  additionalProperties: false
});
```

实施时不要继续使用 `tools[7]` 这种顺序敏感写法；所有 upsert schema/description 断言都按 `tool.name === "upsert_report_section"` 定位。

更新描述测试：

```ts
expect(tool.description).toContain("add_card");
expect(tool.description).toContain("add_field");
expect(tool.description).toContain("replace_field");
expect(tool.description).toContain("已存在");
expect(tool.description).not.toContain("不隐式创建新卡片或新字段");
```

- [ ] **Step 2: 运行 RED schema 测试**

Run:

```powershell
pnpm --filter @novel-extractor/tools test -- toolRegistry
```

Expected: FAIL，当前 schema 没有 `operation`，描述仍写“不隐式创建”。

- [ ] **Step 3: 更新 `workspace.ts` 工具描述和 schema**

把 `upsert_report_section` 描述改成：

```ts
upsert_report_section: () =>
  "按 cardName + fieldName 新增或替换 Markdown 报告字段块，也可新增整张卡片。updates[].operation 支持 add_card、add_field、replace_field；缺省为 replace_field。add_card/add_field 命中既有卡片或字段时不会覆盖，会返回 existingContent，并提示模型基于已有内容改用 replace_field。报告不存在时 add_card/add_field 会自动创建报告文件。"
```

schema 的 update item 增加 `operation`，并把 required 改成 `["cardName", "content"]`，因为 `add_card` 不需要 `fieldName`。`fieldName` 的条件必填交给运行时校验。

- [ ] **Step 4: 同步 LLM 协议测试**

在 `packages/llm/src/toolDefinition.test.ts` 和 `packages/llm/src/protocols/*.test.ts` 中，把旧的 upsert schema 断言改成包含 `operation`，并保留：

```ts
expect(JSON.stringify(tool.inputSchema)).not.toContain("old_string");
expect(JSON.stringify(tool.inputSchema)).not.toContain("sectionId");
expect(JSON.stringify(tool.inputSchema)).not.toContain("writeMode");
```

- [ ] **Step 5: 运行协议相关测试**

Run:

```powershell
pnpm --filter @novel-extractor/tools test -- toolRegistry
pnpm --filter @novel-extractor/llm test -- toolDefinition protocols
```

Expected: PASS。

---

### Task 5: 更新桌面端提示、guard 和写入结果登记

**Files:**
- Modify: `packages/config/src/defaults.ts`
- Modify: `packages/config/src/defaults.test.ts`
- Modify: `apps/desktop/src/main/windowRunService.ts`
- Modify: `apps/desktop/src/main/windowRunService.test.ts`
- Modify: `apps/desktop/src/main/p0Handlers.test.ts`

- [ ] **Step 1: 写 RED 测试，待创建报告提示不再引导 write_file**

在 `apps/desktop/src/main/windowRunService.test.ts` 更新现有 prompt inventory 测试：

```ts
expect(userPrompt).toContain("待创建报告有可写入卡片或字段时，直接用 upsert_report_section 的 add_card 或 add_field 创建报告内容。");
expect(userPrompt).not.toContain("待创建报告不要先调用 read_file 或 read_report_excerpt；有可写入信息时直接用 write_file 创建并写入完整报告正文。");
```

在 `packages/config/src/defaults.test.ts` 断言默认窗口规则包含：

```ts
expect(windowInstructions).toContain("add_card");
expect(windowInstructions).toContain("add_field");
expect(windowInstructions).toContain("replace_field");
expect(windowInstructions).not.toContain("待创建报告");
```

如果 `defaults.test.ts` 当前没有 `windowInstructions` 变量，就用现有测试里的默认配置读取方式：

```ts
const windowInstructions = getDefaultConfig().toolLoopDefaults.windowInstructionLines.join("\n");
```

- [ ] **Step 2: 写 RED 测试，add_field 不要求预读，replace_field 仍要求预读**

在 `apps/desktop/src/main/windowRunService.test.ts` 增加：

```ts
it("allows add_field on an existing report without pre-reading the same field", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-add-field-"));
  scratchDirs.push(projectRoot);
  const reportsRoot = path.join(projectRoot, "assets", "books", "book-1", "reports");
  const windowTextPath = path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt");
  const outputFileName = "NPC性格与代表事件.md";
  const requestBodies: Record<string, unknown>[] = [];
  const registerReport = vi.fn(async () => {});
  const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
  const apiKeyRef = credentialStore.saveApiKey({ providerConfigId: "provider-1", apiKey: "sk-window-loop" });
  const providerConfig = createProviderConfig(apiKeyRef);
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    if (requestBodies.length === 1) {
      return new Response(
        JSON.stringify(createChatCompletionResponse({
          toolCalls: [
            createToolCall("call-add-field", "upsert_report_section", {
              outputFileName,
              updates: [
                {
                  operation: "add_field",
                  cardName: "韩立",
                  fieldName: "变化与后果",
                  content: "- 变化与后果：本窗口新增了入门机会。"
                }
              ]
            })
          ]
        })),
        { headers: { "Content-Type": "application/json" }, status: 200 }
      );
    }
    return new Response(JSON.stringify(createChatCompletionResponse({ content: "窗口完成。" })), {
      headers: { "Content-Type": "application/json" },
      status: 200
    });
  });

  await fs.mkdir(path.dirname(windowTextPath), { recursive: true });
  await fs.mkdir(reportsRoot, { recursive: true });
  await fs.writeFile(windowTextPath, "第一章\n\n韩立获得入门机会。", "utf8");
  await fs.writeFile(path.join(reportsRoot, outputFileName), "### 韩立\n- 核心性格：谨慎\n", "utf8");

  const service = createWindowRunService({
    clock: { now: () => "2026-07-01T00:00:00.000Z" },
    credentialStore,
    enabledToolNames: legacyDesktopToolNames,
    fetch,
    findExistingReport: () => ({
      id: "report-1",
      bookId: "book-1",
      fileName: outputFileName,
      displayName: "NPC性格与代表事件",
      relativePath: `assets/books/book-1/reports/${outputFileName}`,
      reportKind: "template-output",
      templateId: "template-1",
      byteSize: 100,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z"
    }),
    idGenerator: { createId: (prefix: string) => `${prefix}-1` },
    onRuntimeState: async () => {},
    providerStore: createProviderStore(providerConfig),
    registerReport
  });

  const result = await service.runJobWindows({
    artifacts: createWindowArtifacts({
      projectRoot,
      templates: [createTemplate({ id: "template-1", name: "NPC性格与代表事件", fileName: outputFileName })]
    }),
    job: createWindowRunJob({ templateIds: ["template-1"] })
  });

  expect(result).toMatchObject({ ok: true });
  expect(requestBodies).toHaveLength(2);
  await expect(fs.readFile(path.join(reportsRoot, outputFileName), "utf8")).resolves.toContain("- 变化与后果：本窗口新增了入门机会。");
});
```

保留现有 `requires read_report_excerpt to read the same card field before field upsert on an existing report`，让缺省 `operation` 或显式 `replace_field` 继续被拦截。

同时扩展现有内容 guard 测试：当 `add_card` / `add_field` 的 `updates[].content` 包含内部元数据或已知 secret，即使目标卡片/字段已存在，也必须先返回内容 guard 的可恢复拒绝结果，不读取报告、不返回 `existingContent`。断言工具结果不包含既有卡片/字段正文，日志里仍做 secret redaction。

- [ ] **Step 3: 写 RED 测试，changed:false 不登记为写入完成**

增加确定路径测试：第一轮 `add_field` 命中既有字段，工具返回 `changed:false`；运行时应把结果喂回模型，但不调用 `registerReport`、不 `recordWritten`、不 `outcomeTracker.recordWritten`。第二轮模型必须先对同一 `outputFileName/cardName/fieldName` 调用 `read_report_excerpt`，再在同一轮后续 tool call 中调用 `upsert_report_section operation=replace_field`；此时才登记写入并完成模板结果。

测试 fetch 路径固定为：

- 第 1 次模型响应：调用 `upsert_report_section operation=add_field`，目标字段已存在。
- 第 2 次模型响应：先调用 `read_report_excerpt` 读取同一字段，再调用 `upsert_report_section operation=replace_field` 写入更新内容；在返回该响应前断言 `registerReport` 仍为 `0` 次。
- 第 3 次模型响应：返回普通完成文本。

核心断言：

```ts
expect(firstToolResult).toContain("\"changed\":false");
expect(firstToolResult).toContain("field_already_exists");

// 在第 2 次 fetch 分支返回 read_report_excerpt + replace_field 前：
expect(registerReport).toHaveBeenCalledTimes(0);

// runJobWindows 返回后：
expect(requestBodies).toHaveLength(3);
expect(registerReport).toHaveBeenCalledTimes(1);
expect(result.outcomes).toHaveLength(1);
expect(finalReport).toContain("- 核心性格：更新后的内容");
```

另增纠偏消息 RED 测试：第一轮 `add_field` 返回 `changed:false` 后，第二轮模型如果直接回复“窗口完成。”而没有写入或 `mark_no_update`，运行时生成缺失模板处理结果纠偏消息。第三轮请求中的纠偏消息必须优先提示 `upsert_report_section add_card/add_field/replace_field`，且不再包含旧文案 `write_file/edit_file/multi_edit 写入正式报告`。

核心断言：

```ts
const correctionPrompt = messagesOf(requestBodies[2]).map((message) => String(message.content ?? "")).join("\n");
expect(correctionPrompt).toContain("upsert_report_section");
expect(correctionPrompt).toContain("add_card");
expect(correctionPrompt).toContain("add_field");
expect(correctionPrompt).toContain("replace_field");
expect(correctionPrompt).not.toContain("write_file/edit_file/multi_edit 写入正式报告");
```

- [ ] **Step 4: 修改 prompt 文案**

`packages/config/src/defaults.ts` 中替换相关规则：

```ts
"新增卡片或新增字段块时，直接用 upsert_report_section：operation=add_card 新增整张卡片，operation=add_field 新增某个字段块；报告不存在时工具会自动创建报告，不要先用 write_file 铺底。",
"修改既有字段块前，先用 read_report_excerpt 按“卡片名-字段名/字段名”坐标读取目标字段块；确认后用 upsert_report_section operation=replace_field 替换同一字段块，不要整读旧报告，不要用 old_string。"
```

`apps/desktop/src/main/windowRunService.ts` 的 `renderReportInventoryPromptSection` 替换为：

```ts
"已有报告可按需读取相关字段；新增卡片/字段用 upsert_report_section 的 add_card/add_field，修改既有字段用 read_report_excerpt 后再 replace_field。",
"待创建报告有可写入卡片或字段时，直接用 upsert_report_section 的 add_card 或 add_field 创建报告内容；不要先调用 read_file、read_report_excerpt 或 write_file 铺底。"
```

- [ ] **Step 5: 修改 `createBatchOutcomeCorrectionMessage` 纠偏文案**

在 `apps/desktop/src/main/windowRunService.ts` 约 2254 的 `createBatchOutcomeCorrectionMessage` 中，把旧的：

```ts
"请对每个缺失 outputFileName 调用 write_file/edit_file/multi_edit 写入正式报告，或调用 mark_no_update 标记本窗口无新增信息。"
```

替换为优先提示字段报告工具：

```ts
"请对每个缺失 outputFileName 优先调用 upsert_report_section：新增整张卡片用 operation=add_card，新增字段块用 operation=add_field，修改既有字段块先 read_report_excerpt 再 operation=replace_field；没有当前窗口明确证据时调用 mark_no_update。"
```

保留“只处理缺失 outputFileName”“无证据立即 mark_no_update”“最终 NO_UPDATE”的约束。

- [ ] **Step 6: 修改 upsert guard**

新增 helper：

```ts
function collectReplaceUpsertReportFieldKeys(args: unknown): string[] {
  const outputFileName = getToolOutputFileNameArgument(args);
  if (!outputFileName || !isPlainRecord(args) || !Array.isArray(args.updates)) {
    return [];
  }

  return args.updates.flatMap((update) => {
    if (!isPlainRecord(update) || typeof update.cardName !== "string" || typeof update.fieldName !== "string") {
      return [];
    }

    const operation = typeof update.operation === "string" ? update.operation : "replace_field";
    return operation === "replace_field"
      ? [createReportFieldKey(outputFileName, update.cardName, update.fieldName)]
      : [];
  });
}
```

在 `createExistingReportWriteRecoverableResult` 中把 `collectUpsertReportFieldKeys` 换成 `collectReplaceUpsertReportFieldKeys`。这样 `add_card` / `add_field` 不需要预读，缺省旧调用仍按 `replace_field` 被保护。

内容安全 guard 不改变顺序：`getWritableReportContentFragments` 继续收集 `upsert_report_section updates[].content`，并在 `createExistingReportWriteRecoverableResult` 和工具执行前检查。`add_card` / `add_field` 命中已存在目标时也不能绕过该检查；content 违规时返回 guard 错误，不进入读取既有内容的分支。

- [ ] **Step 7: changed:false 不登记成功写入**

新增 helper：

```ts
function reportWriteToolChanged(toolName: string, toolResult: unknown): boolean {
  if (toolName !== UPSERT_REPORT_SECTION_TOOL_NAME) {
    return true;
  }
  if (typeof toolResult !== "string") {
    return true;
  }
  try {
    const parsed = JSON.parse(toolResult) as unknown;
    return !isPlainRecord(parsed) || parsed.changed !== false;
  } catch {
    return true;
  }
}
```

把写入登记条件改成：

```ts
if (isReportWriteTool(toolCall.name) && !returnedRecoverableToolError && reportWriteToolChanged(toolCall.name, toolResult)) {
  // registerTemplateOutputReport / recordWritten / sync sandbox
}
```

- [ ] **Step 8: 运行桌面和配置测试**

Run:

```powershell
pnpm --filter @novel-extractor/config test -- defaults
pnpm --filter @novel-extractor/desktop test -- windowRunService
pnpm --filter @novel-extractor/desktop test -- p0Handlers
```

Expected: PASS。

---

### Task 6: 日志、错误分类和文档收口

**Files:**
- Modify: `apps/desktop/src/main/toolErrorClassification.ts`
- Modify: `apps/desktop/src/main/toolErrorClassification.test.ts`
- Modify: `docs/提取流程大白话梳理.md`

- [ ] **Step 1: 更新错误分类测试**

先写 RED 断言，覆盖 `INVALID_CARD_CONTENT` 与既有字段报告错误码同样可由模型修正：

```ts
expect(classify("upsert_report_section", new ToolExecutionError("CARD_NOT_FOUND: 未找到卡片 韩立", "CARD_NOT_FOUND"))).toMatchObject({
  category: "recoverable_by_model",
  recoverableByModel: true
});
expect(classify("upsert_report_section", new ToolExecutionError("FIELD_NOT_FOUND: 未找到字段 韩立/核心性格", "FIELD_NOT_FOUND"))).toMatchObject({
  category: "recoverable_by_model",
  recoverableByModel: true
});
expect(classify("upsert_report_section", new ToolExecutionError("FIELD_AMBIGUOUS: 字段重复 韩立/核心性格", "FIELD_AMBIGUOUS"))).toMatchObject({
  category: "recoverable_by_model",
  recoverableByModel: true
});
expect(classify("upsert_report_section", new ToolExecutionError("INVALID_FIELD_CONTENT: content 必须以 - 核心性格： 开头", "INVALID_FIELD_CONTENT"))).toMatchObject({
  category: "recoverable_by_model",
  recoverableByModel: true
});
expect(classify("upsert_report_section", new ToolExecutionError("INVALID_CARD_CONTENT: add_card content 标题必须匹配 cardName 韩立", "INVALID_CARD_CONTENT"))).toMatchObject({
  category: "recoverable_by_model",
  recoverableByModel: true
});
```

实现时在 `apps/desktop/src/main/toolErrorClassification.ts` 的 `FIELD_REPORT_ARGUMENT_ERROR_CODES` 中加入 `"INVALID_CARD_CONTENT"`。如果 `apps/desktop/src/main/windowRunService.ts` 仍有镜像的 `TOOL_EXECUTION_ERROR_CODES` 集合，也同步加入 `"INVALID_CARD_CONTENT"`，避免工具结果回灌时丢失错误码。

新增说明性测试：`add_card` / `add_field` 命中已存在不会抛 `CARD_NOT_FOUND` / `FIELD_NOT_FOUND`，因此桌面日志不应再把新增场景归类为“工具参数或路径无效”。`CARD_NOT_FOUND` / `FIELD_NOT_FOUND` 只作为 `replace_field` 缺卡片/缺字段的可恢复错误保留；新增场景由 Task 3 和 Task 5 的 `changed:false` 测试覆盖。

- [ ] **Step 2: 更新大白话文档**

在 `docs/提取流程大白话梳理.md` 中把旧描述改成：

```md
新增报告内容时，`upsert_report_section` 是首选写入口：

- 新增整张卡片：`operation=add_card`。
- 新增某个字段块：`operation=add_field`。
- 修改既有字段块：先 `read_report_excerpt` 读取同一字段，再 `operation=replace_field` 替换。
- 如果报告文件不存在，`add_card` / `add_field` 会自动创建报告文件。
- 如果新增目标已经存在，工具不会覆盖，会返回已有卡片或字段块内容，模型应基于该内容继续修改。
```

- [ ] **Step 3: 运行文档相关搜索检查**

Run:

```powershell
rtk rg -n "待创建报告.*write_file|不隐式创建新卡片|不隐式创建新字段|upsert_report_section.*默认禁用" docs packages apps
```

Expected: 不再命中当前默认流程文案；历史复盘文档如明确标注“历史机制”可保留。

---

### Task 7: 总体验证

**Files:**
- No code changes beyond previous tasks.

- [ ] **Step 1: 运行目标测试**

Run:

```powershell
pnpm --filter @novel-extractor/tools test -- reportFieldBlocks builtinFileTools toolRegistry
pnpm --filter @novel-extractor/llm test -- toolDefinition protocols
pnpm --filter @novel-extractor/config test -- defaults
pnpm --filter @novel-extractor/desktop test -- windowRunService p0Handlers
```

Expected: 全部 PASS。

- [ ] **Step 2: 运行类型检查**

Run:

```powershell
pnpm typecheck
```

Expected: 全部 package typecheck PASS。

- [ ] **Step 3: 运行全量 TS 测试**

Run:

```powershell
pnpm test:ts
```

Expected: Vitest 全量 PASS。

- [ ] **Step 4: 检查 diff 和工作树**

Run:

```powershell
rtk git diff -- packages/tools/src/reportFieldBlocks.ts packages/tools/src/builtinFileTools.ts packages/tools/src/reasonix/workspace.ts packages/config/src/defaults.ts apps/desktop/src/main/windowRunService.ts
rtk git status --short
```

Expected:

- diff 只包含本计划列出的工具协议、提示、guard、测试和文档改动。
- 没有无关格式化或打包产物。

---

## 成功标准

- 模型可以用 `upsert_report_section operation=add_card` 直接新增卡片。
- 模型可以用 `upsert_report_section operation=add_field` 直接新增字段块。
- 报告文件不存在时，`add_card` / `add_field` 自动创建报告文件。
- `add_card` 命中既有卡片时，工具返回完整卡片内容，不覆盖文件。
- `add_field` 命中既有字段块时，工具返回该字段块内容，不覆盖文件。
- `replace_field` 保持现有安全策略：既有报告的既有字段替换前必须先读取同一字段。
- `changed:false` 的 upsert 结果不会被桌面端登记为“报告已写入”或“模板已完成”。
- prompt 不再把待创建报告引导到 `write_file` 铺底。
