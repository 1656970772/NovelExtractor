import { describe, expect, it } from "vitest";
import { summarizeTaskLogEntry } from "./taskProgressLog";

describe("task progress log summarizer", () => {
  it("summarizes task info as a single user-facing start line", () => {
    expect(
      summarizeTaskLogEntry({
        tags: ["任务信息"],
        timestamp: "2026-07-02T04:36:45.000Z",
        value:
          "任务 job-7，书籍 凡人修仙传.txt，模型 deepseek-v4-flash，模板 4 个，单次章节 3，提取章节 9，重叠章节 1"
      })
    ).toBe("04:36:45 开始任务：凡人修仙传.txt，4 个模板，模型 deepseek-v4-flash");
  });

  it("summarizes context, model request, retry, batch result, and coverage update", () => {
    expect(
      summarizeTaskLogEntry({
        tags: ["上下文", "覆盖索引预检"],
        timestamp: "2026-07-02T04:36:44.000Z",
        value: {
          窗口总数: 10,
          已覆盖窗口数: 6,
          待处理窗口数: 4,
          待处理窗口: ["窗口 7/10", "窗口 8/10", "窗口 9/10", "窗口 10/10"]
        }
      })
    ).toBe("04:36:44 覆盖索引预检：10 个窗口，6 个已覆盖，4 个待处理（窗口 7/10、8/10、9/10、10/10）");

    expect(
      summarizeTaskLogEntry({
        tags: ["上下文", "覆盖索引跳过窗口"],
        timestamp: "2026-07-02T04:36:45.000Z",
        value: {
          窗口: "1/10",
          窗口文件: "window-0001.txt"
        }
      })
    ).toBe("04:36:45 窗口 1/10（window-0001.txt）已经提取过，跳过");

    expect(
      summarizeTaskLogEntry({
        tags: ["上下文", "覆盖索引"],
        timestamp: "2026-07-02T04:36:45.000Z",
        value: {
          跳过已提取: true,
          待处理模板: [{ 模板名称: "NPC性格与代表事件模板" }, { 模板名称: "材料分析模板" }]
        }
      })
    ).toBe("04:36:45 检查覆盖索引：跳过已提取=true，待处理模板 2 个");

    expect(
      summarizeTaskLogEntry({
        tags: ["上下文", "窗口"],
        timestamp: "2026-07-02T04:36:45.000Z",
        value: {
          正在处理: "窗口 1/4",
          章节范围: "1-3",
          模板: [{ 模板名称: "NPC性格与代表事件模板" }, { 模板名称: "材料分析模板" }]
        }
      })
    ).toBe("04:36:45 窗口 1/4：处理第 1-3 章，模板 2 个");

    expect(
      summarizeTaskLogEntry({
        tags: ["大模型请求", "Prompt"],
        timestamp: "2026-07-02T04:36:45.000Z",
        value: { 窗口: "1/4", 轮次: 2, 模型: "deepseek-v4-flash" }
      })
    ).toBe("04:36:45 请求模型：窗口 1/4，第 2 轮");

    expect(
      summarizeTaskLogEntry({
        tags: ["大模型返回"],
        timestamp: "2026-07-02T04:36:49.000Z",
        value: { 工具调用: [{ name: "read_file" }, { name: "glob" }], 正文: "" }
      })
    ).toBe("04:36:49 模型返回：准备读取窗口文本和检查已有报告");

    expect(
      summarizeTaskLogEntry({
        tags: ["大模型返回"],
        timestamp: "2026-07-02T04:36:50.000Z",
        value: { 工具调用: [], 正文: "NO_UPDATE" }
      })
    ).toBe("04:36:50 模型返回：无工具调用");

    expect(
      summarizeTaskLogEntry({
        tags: ["上下文", "重试"],
        timestamp: "2026-07-02T04:37:32.000Z",
        value: "上一轮尚未为本批次所有选中模板提供处理结果，缺少 outputFileName：材料分析.md。"
      })
    ).toBe("04:37:32 继续补齐结果：缺少 材料分析.md");

    expect(
      summarizeTaskLogEntry({
        tags: ["上下文", "批次结果"],
        timestamp: "2026-07-02T04:39:36.000Z",
        value: {
          窗口: "1/4",
          批次: "1/1",
          处理结果: [
            { outputFileName: "NPC性格与代表事件.md", status: "no_update" },
            { outputFileName: "材料分析.md", status: "written" }
          ]
        }
      })
    ).toBe("04:39:36 完成窗口 1/4：写入 1 个报告，标记 1 个无新增");

    expect(
      summarizeTaskLogEntry({
        tags: ["上下文", "覆盖索引更新"],
        timestamp: "2026-07-02T04:39:36.000Z",
        value: { 窗口: "1/4", 写入报告: ["材料分析.md"] }
      })
    ).toBe("04:39:36 更新覆盖索引：窗口 1/4 已记录");
  });

  it("keeps every tool call and every tool result as its own line", () => {
    expect(
      summarizeTaskLogEntry({
        tags: ["工具调用", "read_file"],
        timestamp: "2026-07-02T04:36:49.000Z",
        value: { 实际执行输入: { path: "runs/job-7/windows/window-0001.txt" } }
      })
    ).toBe("04:36:49 读取文件：window-0001.txt");

    expect(
      summarizeTaskLogEntry({
        tags: ["工具返回", "read_file"],
        timestamp: "2026-07-02T04:36:49.000Z",
        value: {
          实际执行输入: { path: "runs/job-7/windows/window-0001.txt" },
          是否可恢复错误: false,
          返回内容: "   1->第一章 山边小村"
        }
      })
    ).toBe("04:36:49 读取完成：window-0001.txt");

    expect(
      summarizeTaskLogEntry({
        tags: ["工具调用", "glob"],
        timestamp: "2026-07-02T04:36:49.000Z",
        value: { 实际执行输入: { pattern: "NPC性格与代表事件.md" } }
      })
    ).toBe("04:36:49 查找报告文件：NPC性格与代表事件.md");

    expect(
      summarizeTaskLogEntry({
        tags: ["工具返回", "glob"],
        timestamp: "2026-07-02T04:36:49.000Z",
        value: {
          实际执行输入: { pattern: "NPC性格与代表事件.md" },
          是否可恢复错误: false,
          返回内容: ""
        }
      })
    ).toBe("04:36:49 查找完成：NPC性格与代表事件.md，未找到");

    expect(
      summarizeTaskLogEntry({
        tags: ["工具返回", "grep"],
        timestamp: "2026-07-02T04:36:50.000Z",
        value: {
          实际执行输入: { path: "材料分析.md", pattern: "筑基丹" },
          是否可恢复错误: false,
          返回内容: "12: 筑基丹"
        }
      })
    ).toBe("04:36:50 搜索完成：材料分析.md，已命中");

    expect(
      summarizeTaskLogEntry({
        tags: ["工具调用", "write_file"],
        timestamp: "2026-07-02T04:38:38.000Z",
        value: { 实际执行输入: { path: "事件因果链（长程因果图）.md" } }
      })
    ).toBe("04:38:38 写入报告：事件因果链（长程因果图）.md");

    expect(
      summarizeTaskLogEntry({
        tags: ["工具返回", "write_file"],
        timestamp: "2026-07-02T04:38:38.000Z",
        value: {
          实际执行输入: { path: "事件因果链（长程因果图）.md" },
          是否可恢复错误: true,
          返回内容: { error: "old_string not found" }
        }
      })
    ).toBe("04:38:38 写入返回可恢复错误：事件因果链（长程因果图）.md，模型将重试");

    expect(
      summarizeTaskLogEntry({
        tags: ["工具返回", "edit_file"],
        timestamp: "2026-07-02T04:40:41.000Z",
        value: { 实际执行输入: { path: "势力设定.md" }, 是否可恢复错误: false, 返回内容: "ok" }
      })
    ).toBe("04:40:41 更新完成：势力设定.md");

    expect(
      summarizeTaskLogEntry({
        tags: ["工具返回", "multi_edit"],
        timestamp: "2026-07-02T04:43:24.000Z",
        value: { 实际执行输入: { path: "材料分析.md" }, 是否可恢复错误: false, 返回内容: "ok" }
      })
    ).toBe("04:43:24 批量更新完成：材料分析.md");

    expect(
      summarizeTaskLogEntry({
        tags: ["工具返回", "mark_no_update"],
        timestamp: "2026-07-02T04:37:32.000Z",
        value: {
          实际执行输入: { path: "NPC性格与代表事件.md" },
          是否可恢复错误: false,
          返回内容: "ok"
        }
      })
    ).toBe("04:37:32 标记完成：NPC性格与代表事件.md");

    expect(
      summarizeTaskLogEntry({
        tags: ["工具调用", "bash_output"],
        timestamp: "2026-07-02T04:37:40.000Z",
        value: { 实际执行输入: { job_id: "bash-1" } }
      })
    ).toBe("04:37:40 读取后台命令输出：bash-1");
  });

  it("summarizes failures, warnings, and unknown tags without exposing raw payloads", () => {
    expect(
      summarizeTaskLogEntry({
        tags: ["错误", "窗口"],
        timestamp: "2026-07-02T04:50:00.000Z",
        value: { 窗口: "2/4", 原因: "模型返回格式无效" }
      })
    ).toBe("04:50:00 窗口失败：窗口 2/4，原因 模型返回格式无效");

    expect(
      summarizeTaskLogEntry({
        tags: ["警告", "bash"],
        timestamp: "2026-07-02T04:50:01.000Z",
        value: "sandbox 清理失败"
      })
    ).toBe("04:50:01 运行警告：sandbox 清理失败");

    expect(
      summarizeTaskLogEntry({
        tags: ["其他", "细节"],
        timestamp: "2026-07-02T04:50:02.000Z",
        value: "raw prompt"
      })
    ).toBe("04:50:02 其他/细节：已记录");
  });

  it("summarizes user-facing parallel batch brief events with concrete chapter ranges", () => {
    expect(
      summarizeTaskLogEntry({
        tags: ["简要流程", "执行中"],
        timestamp: "2026-07-02T04:51:00.000Z",
        value: {
          模板: "人物模板",
          章节范围: "1-10"
        }
      })
    ).toBe("04:51:00 [执行中]：人物模板的[第1章-第10章]开始分析");

    expect(
      summarizeTaskLogEntry({
        tags: ["简要流程", "执行成功"],
        timestamp: "2026-07-02T04:51:08.000Z",
        value: {
          模板: "人物模板",
          章节范围: "1-10"
        }
      })
    ).toBe("04:51:08 [执行成功]：人物模板的[第1章-第10章]执行成功");

    expect(
      summarizeTaskLogEntry({
        tags: ["简要流程", "限流"],
        timestamp: "2026-07-02T04:51:09.000Z",
        value: {
          模板: "人物模板",
          章节范围: "1-10",
          下次重试延迟毫秒: 60000
        }
      })
    ).toBe("04:51:09 [限流]：人物模板的[第1章-第10章]执行限流，1分钟后再次尝试");

    expect(
      summarizeTaskLogEntry({
        tags: ["简要流程", "执行失败"],
        timestamp: "2026-07-02T04:51:10.000Z",
        value: {
          模板: "人物模板",
          章节范围: "1-10",
          原因: "模型返回格式无效"
        }
      })
    ).toBe("04:51:10 [执行失败]：人物模板的[第1章-第10章]执行失败，原因：模型返回格式无效");
  });

  it("summarizes recoverable tool errors with classification without leaking full tool output", () => {
    expect(
      summarizeTaskLogEntry({
        timestamp: "2026-07-02 06:42:46",
        tags: ["工具返回", "edit_file"],
        value: {
          实际执行输入: { path: "事件因果链（长程因果图）.md" },
          是否可恢复错误: true,
          返回内容: {
            classification: "recoverable_by_model",
            reason: "replacement_text_not_unique",
            error: {
              code: "INVALID_ARGUMENTS",
              message: "old_string is not unique in report.md (5 matches); add more surrounding context"
            },
            hint: "old_string 在文件中匹配到多处；请用 read_file/grep 找到目标段落并加入足够上下文。"
          }
        }
      })
    ).toBe("06:42:46 更新返回可恢复错误：事件因果链（长程因果图）.md，模型将重试");
  });

  it("includes tool-loop continuation reasons in retry and recoverable tool summaries", () => {
    expect(
      summarizeTaskLogEntry({
        timestamp: "2026-07-02 06:42:46",
        tags: ["工具返回", "glob"],
        value: {
          实际执行输入: { pattern: "runs/job-1/**/*.md" },
          是否可恢复错误: true,
          继续原因标签: "report_discovery_rejected",
          继续原因: "报告查找方式被拒绝",
          返回内容: {
            reason: "read_tool_scope_denied"
          }
        }
      })
    ).toBe("06:42:46 查找返回可恢复错误：*.md，继续原因：报告查找方式被拒绝");

    expect(
      summarizeTaskLogEntry({
        timestamp: "2026-07-02 06:43:00",
        tags: ["上下文", "重试"],
        value: {
          继续原因标签: "missing_template_outcome",
          继续原因: "缺失模板处理结果",
          原因: "上一轮尚未为本批次所有选中模板提供处理结果，缺少 outputFileName：材料分析.md。"
        }
      })
    ).toBe("06:43:00 继续补齐结果：缺少 材料分析.md，继续原因：缺失模板处理结果");
  });

  it("summarizes per-window tool-loop reason counts by root cause", () => {
    expect(
      summarizeTaskLogEntry({
        timestamp: "2026-07-02 06:44:00",
        tags: ["上下文", "多轮原因汇总"],
        value: {
          窗口: "8/10",
          原因计数: {
            report_discovery_rejected: 4,
            edit_anchor_failed: 1,
            tool_arguments_invalid: 1
          }
        }
      })
    ).toBe("06:44:00 窗口 8/10 多轮原因：报告查找方式被拒绝 4 次，报告锚点未命中 1 次，工具参数或路径无效 1 次");

    expect(
      summarizeTaskLogEntry({
        timestamp: "2026-07-02 06:45:00",
        tags: ["上下文", "多轮原因汇总"],
        value: {
          窗口: "9/10",
          原因计数: {}
        }
      })
    ).toBe("06:45:00 窗口 9/10 多轮原因：无");
  });

  it("summarizes repeated tool failure as a window failure reason", () => {
    expect(
      summarizeTaskLogEntry({
        timestamp: "2026-07-02 06:43:00",
        tags: ["错误", "窗口"],
        value: {
          窗口: "7/10",
          原因: "同一工具错误重复超过 3 次：old_string is not unique in report.md"
        }
      })
    ).toBe("06:43:00 窗口失败：窗口 7/10，原因 同一工具错误重复超过 3 次：old_string is not unique in report.md");
  });

  it("summarizes automatic failed-job retry scheduler entries", () => {
    expect(
      summarizeTaskLogEntry({
        timestamp: "2026-07-02 06:44:00",
        tags: ["自动续跑", "调度"],
        value: { 事件: "触发", 下次间隔: "5 分钟" }
      })
    ).toBe("06:44:00 自动续跑触发：正在重新入队");

    expect(
      summarizeTaskLogEntry({
        timestamp: "2026-07-02 06:44:01",
        tags: ["自动续跑", "调度"],
        value: { 事件: "已接收", 状态: "已进入运行" }
      })
    ).toBe("06:44:01 自动续跑已进入运行或排队，停止本轮定时重试");

    expect(
      summarizeTaskLogEntry({
        timestamp: "2026-07-02 06:44:02",
        tags: ["自动续跑", "调度"],
        value: { 事件: "等待下次", 下次间隔: "5 分钟" }
      })
    ).toBe("06:44:02 自动续跑本次仍未成功，5 分钟后再次尝试");
  });
});
