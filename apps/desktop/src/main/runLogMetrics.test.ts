import { describe, expect, it } from "vitest";
import { parseRunLogMetrics } from "./runLogMetrics";

describe("run log metrics", () => {
  it("counts stable labels from full and simple task logs", () => {
    const modelRequests = Array.from(
      { length: 43 },
      (_, index) => `[2026-07-03 10:00:${String(index % 60).padStart(2, "0")}][大模型请求][Prompt]
窗口: 1/4
轮次: ${index + 1}
messages:
  - role: user
    content: [窗口原文见 window-0001.txt]${index === 0 ? `
tools:
  - name: read_file
    description: 旧版完整工具说明
    parameters:
      type: object` : ""}`
    ).join("\n");
    const recoverableToolResults = Array.from(
      { length: 15 },
      (_, index) => `[2026-07-03 10:01:${String(index % 60).padStart(2, "0")}][工具返回][read_file]
classification: recoverable_by_model
是否可恢复错误: true`
    ).join("\n");
    const unsafePathFailures = Array.from({ length: 12 }, () => "code: UNSAFE_PATH").join("\n");
    const sampleLogText = [
      modelRequests,
      "[2026-07-03 10:02:00][工具调用][read_file]",
      "输入参数:",
      "  path: reports/丹药分析.md",
      "[2026-07-03 10:02:01][工具调用][read_report_excerpt]",
      "输入参数:",
      "  fileName: 丹药分析.md",
      "[2026-07-03 10:02:02][工具调用][write_file]",
      "输入参数:",
      "  path: 丹药分析.md",
      recoverableToolResults,
      unsafePathFailures,
      "code: INVALID_ARGUMENTS",
      "Tool is not enabled: pwd",
      "窗口 8/10 多轮原因：报告查找方式被拒绝 4 次，报告锚点未命中 1 次"
    ].join("\n");

    const metrics = parseRunLogMetrics(sampleLogText);

    expect(metrics.modelRequestCount).toBe(43);
    expect(metrics.toolCallCountByName).toMatchObject({
      read_file: 1,
      read_report_excerpt: 1,
      write_file: 1
    });
    expect(metrics.recoverableRetryCount).toBe(15);
    expect(metrics.unsafePathCount).toBe(12);
    expect(metrics.invalidArgumentsCount).toBe(1);
    expect(metrics.unknownToolFailures).toContain("pwd");
    expect(metrics.roundReasonCounts).toMatchObject({
      报告查找方式被拒绝: 4,
      报告锚点未命中: 1
    });
    expect(metrics.fullReportReadCount).toBe(1);
    expect(metrics.windowTextReferenceCount).toBe(43);
    expect(metrics.expandedToolSchemaCount).toBe(1);
    expect(metrics.fullLogBytes).toBe(Buffer.byteLength(sampleLogText, "utf8"));
  });

  it("does not count compact parameter schema descriptions as expanded tool schemas", () => {
    const currentCompactLogText = `[2026-07-03 10:00:00][大模型请求][Prompt]
tools:
  -
    name: read_file
    parameters:
      type: object
      properties:
        path:
          type: string
          description: File path`;

    const metrics = parseRunLogMetrics(currentCompactLogText);

    expect(metrics.expandedToolSchemaCount).toBe(0);
  });

  it("does not count prompt message content descriptions as expanded tool schemas", () => {
    const metrics = parseRunLogMetrics(`[2026-07-03 10:00:00][大模型请求][Prompt]
messages:
  - role: user
    content: |
      模板字段：
      description: 这只是模板正文字段，不是工具说明
      正文结束`);

    expect(metrics.expandedToolSchemaCount).toBe(0);
  });

  it("counts legacy tool descriptions without counting parameter property descriptions", () => {
    const metrics = parseRunLogMetrics(`[2026-07-03 10:00:00][大模型请求][Prompt]
tools:
  - name: read_file
    description: Read a file from workspace
    parameters:
      type: object
      properties:
        path:
          type: string
          description: File path`);

    expect(metrics.expandedToolSchemaCount).toBe(1);
  });

  it("counts provider-native tool descriptions without counting nested schema descriptions", () => {
    const metrics = parseRunLogMetrics(`[2026-07-03 10:00:00][大模型请求][ProviderBody]
providerBody:
  tools:
    -
      type: function
      function:
        name: read_report_excerpt
        description: 读取本批允许报告中的卡片字段块。
        parameters:
          type: object
          properties:
            queries:
              type: array
              description: schema 字段描述不应计数
              items:
                type: object
                properties:
                  fields:
                    type: array
                    description: nested schema 字段描述不应计数
                    items:
                      type: string`);

    expect(metrics.expandedToolSchemaCount).toBe(1);
  });

  it("counts Anthropic provider-native input_schema tool descriptions", () => {
    const metrics = parseRunLogMetrics(`[2026-07-03 10:00:00][大模型请求][ProviderBody]
providerBody:
  tools:
    -
      name: read_report_excerpt
      description: 读取本批允许报告中的卡片字段块。
      input_schema:
        type: object
        properties:
          queries:
            type: array
            description: schema 字段描述不应计数`);

    expect(metrics.expandedToolSchemaCount).toBe(1);
  });

  it("counts OpenAI Responses provider-native tool descriptions", () => {
    const metrics = parseRunLogMetrics(`[2026-07-03 10:00:00][大模型请求][ProviderBody]
providerBody:
  tools:
    -
      type: function
      name: upsert_report_section
      description: 更新报告字段块。
      parameters:
        type: object
        properties:
          updates:
            type: array
            description: schema 字段描述不应计数`);

    expect(metrics.expandedToolSchemaCount).toBe(1);
  });

  it("counts Gemini provider-native function declaration descriptions", () => {
    const metrics = parseRunLogMetrics(`[2026-07-03 10:00:00][大模型请求][ProviderBody]
providerBody:
  tools:
    -
      functionDeclarations:
        -
          name: wait
          description: 等待后台任务完成。
          parameters:
            type: object
            properties:
              job_ids:
                type: array
                description: schema 字段描述不应计数`);

    expect(metrics.expandedToolSchemaCount).toBe(1);
  });

  it("counts Bedrock provider-native toolSpec descriptions", () => {
    const metrics = parseRunLogMetrics(`[2026-07-03 10:00:00][大模型请求][ProviderBody]
providerBody:
  toolConfig:
    tools:
      -
        toolSpec:
          name: multi_edit
          description: 批量更新报告。
          inputSchema:
            json:
              type: object
              properties:
                edits:
                  type: array
                  description: schema 字段描述不应计数`);

    expect(metrics.expandedToolSchemaCount).toBe(1);
  });

  it("does not count ProviderBody message or metadata descriptions as tool schemas", () => {
    const messageDescriptionOnly = parseRunLogMetrics(`[2026-07-03 10:00:00][大模型请求][ProviderBody]
providerBody:
  model: novel-analysis
  messages:
    -
      role: user
      content: |
        模板字段：
        description: 这只是消息正文，不是工具说明`);
    const metadataPlusTool = parseRunLogMetrics(`[2026-07-03 10:00:00][大模型请求][ProviderBody]
providerBody:
  metadata:
    description: 这是请求元数据说明，不是工具说明
  tools:
    -
      type: function
      name: read_report_excerpt
      description: 读取本批允许报告中的卡片字段块。
      parameters:
        type: object
        properties:
          queries:
            type: array
            description: schema 字段描述不应计数`);

    expect(messageDescriptionOnly.expandedToolSchemaCount).toBe(0);
    expect(metadataPlusTool.expandedToolSchemaCount).toBe(1);
  });

  it("prefers provider-native schema metrics when prompt and provider body logs coexist", () => {
    const metrics = parseRunLogMetrics(`[2026-07-03 10:00:00][大模型请求][Prompt]
tools:
  - name: legacy_tool
    description: 旧版拍扁工具说明
    parameters:
      type: object
[2026-07-03 10:00:00][大模型请求][ProviderBody]
providerBody:
  tools:
    -
      type: function
      name: native_tool
      description: 真实 provider body 工具说明。
      parameters:
        type: object`);

    expect(metrics.expandedToolSchemaCount).toBe(1);
  });

  it("does not count nested markdown outside report paths as full report reads", () => {
    const metrics = parseRunLogMetrics(
      [
        "[2026-07-03 10:02:00][工具调用][read_file]",
        "输入参数:",
        "  path: docs/foo.md",
        "[2026-07-03 10:02:01][工具调用][read_file]",
        "输入参数:",
        "  path: runs/job/notes.md",
        "[2026-07-03 10:02:02][工具调用][read_file]",
        "输入参数:",
        "  path: 丹药分析.md",
        "[2026-07-03 10:02:03][工具调用][read_file]",
        "输入参数:",
        "  path: reports/材料分析.md"
      ].join("\n")
    );

    expect(metrics.fullReportReadCount).toBe(2);
  });

  it("counts full report reads from simple read_file labels", () => {
    const metrics = parseRunLogMetrics("12:00:00 读取文件：丹药分析.md");

    expect(metrics.fullReportReadCount).toBe(1);
  });

  it("does not count bounded report read_file blocks as full report reads", () => {
    const metrics = parseRunLogMetrics(
      [
        "[2026-07-03 12:00:00][工具调用][read_file]",
        "实际执行输入:",
        "  path: 材料分析.md",
        "  offset: 20",
        "  limit: 30"
      ].join("\n")
    );

    expect(metrics.toolCallCountByName.read_file).toBe(1);
    expect(metrics.fullReportReadCount).toBe(0);
  });

  it("still counts unbounded report read_file blocks as full report reads", () => {
    const metrics = parseRunLogMetrics(
      [
        "[2026-07-03 12:00:00][工具调用][read_file]",
        "实际执行输入:",
        "  path: 材料分析.md"
      ].join("\n")
    );

    expect(metrics.toolCallCountByName.read_file).toBe(1);
    expect(metrics.fullReportReadCount).toBe(1);
  });

  it("counts background tool calls from simple task log labels", () => {
    const metrics = parseRunLogMetrics(
      [
        "12:00:00 读取后台命令输出：bash-1",
        "12:00:01 等待后台任务完成",
        "12:00:02 终止后台任务：bash-1"
      ].join("\n")
    );

    expect(metrics.toolCallCountByName).toMatchObject({
      bash_output: 1,
      wait: 1,
      kill_shell: 1
    });
  });

  it("prefers full read_file blocks over simple read_file labels", () => {
    const metrics = parseRunLogMetrics(
      [
        "[2026-07-03 10:02:00][工具调用][read_file]",
        "输入参数:",
        "  path: reports/丹药分析.md",
        "12:00:00 读取文件：丹药分析.md"
      ].join("\n")
    );

    expect(metrics.fullReportReadCount).toBe(1);
  });

  it("prefers full model and tool labels over simple summaries when logs are concatenated", () => {
    // 同一运行的 full/simple 日志拼接输入时，full 标签是权威来源，simple 是摘要，避免双计数。
    const metrics = parseRunLogMetrics(
      [
        "[2026-07-03 10:00:00][大模型请求][Prompt]",
        "[2026-07-03 10:00:01][工具调用][grep]",
        "10:00:00 请求模型：窗口 1/1，第 1 轮",
        "10:00:01 搜索文件：window-0001.txt"
      ].join("\n")
    );

    expect(metrics.modelRequestCount).toBe(1);
    expect(metrics.toolCallCountByName).toEqual({ grep: 1 });
  });

  it("does not count simple read_report_excerpt tool calls as full report reads", () => {
    const metrics = parseRunLogMetrics("12:00:00 调用工具：read_report_excerpt");

    expect(metrics.toolCallCountByName).toMatchObject({
      read_report_excerpt: 1
    });
    expect(metrics.fullReportReadCount).toBe(0);
  });

  it("counts simple field report tool labels without exposing internal names", () => {
    const metrics = parseRunLogMetrics("12:00:00 读取报告字段：NPC性格与代表事件.md\n12:00:01 更新报告字段：NPC性格与代表事件.md");

    expect(metrics.toolCallCountByName).toMatchObject({
      read_report_excerpt: 1,
      upsert_report_section: 1
    });
  });
});
