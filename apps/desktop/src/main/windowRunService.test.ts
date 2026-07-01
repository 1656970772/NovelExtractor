import { describe, expect, it, vi } from "vitest";
import { cleanupBashSandboxAfterWindow } from "./windowRunService";

describe("window run bash sandbox cleanup", () => {
  it("records teardown and sandbox removal warnings without masking the window result", async () => {
    const append = vi.fn(async () => {});

    await expect(
      cleanupBashSandboxAfterWindow({
        bashJobManager: {
          closeWithGrace: async () => ({
            cause: "timeout",
            hasTimedOut: () => true,
            timedOut: [
              {
                id: "bash-1",
                kind: "bash",
                label: "sleep",
                waitedMs: 1000
              }
            ]
          })
        } as any,
        bashSandbox: {
          env: {},
          parentRoot: "sandbox-parent",
          reportsRoot: "sandbox-parent/reports"
        },
        removeSandbox: async () => {
          throw new Error("sandbox locked");
        },
        syncReportsToReal: async () => {},
        taskLogger: { append } as any
      })
    ).resolves.toBeUndefined();

    expect(append).toHaveBeenCalledWith(
      ["警告", "bash"],
      expect.objectContaining({
        类型: "后台任务关闭超时",
        未完成任务: expect.arrayContaining([expect.objectContaining({ id: "bash-1" })])
      })
    );
    expect(append).toHaveBeenCalledWith(
      ["警告", "bash"],
      expect.objectContaining({
        类型: "sandbox 清理失败",
        错误: "sandbox locked"
      })
    );
  });
});
