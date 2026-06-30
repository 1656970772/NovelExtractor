import { execSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceDir = process.cwd();

function getCurrentBranch() {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: workspaceDir,
      encoding: "utf8",
    }).trim();

    return branch && branch !== "HEAD" ? branch : "main";
  } catch {
    return "main";
  }
}

function normalizeBranch(branch) {
  return branch
    .replace(/[\\/:*?<>|"]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "main";
}

function main() {
  const branch = normalizeBranch(getCurrentBranch());
  const outputDir = branch === "main" ? "release" : `release-${branch}`;
  const outputPath = path.join(workspaceDir, outputDir);

  const configPath = path.join(workspaceDir, "electron-builder.yml");
  const builderBinary = path.join(
    workspaceDir,
    "node_modules",
    ".bin",
    os.platform() === "win32" ? "electron-builder.cmd" : "electron-builder",
  );
  const result = spawnSync(
    builderBinary,
    ["--config", configPath, `--config.directories.output=${outputPath}`],
    { stdio: "inherit", shell: os.platform() === "win32" },
  );

  if (result.error) {
    console.error("Electron Builder 执行失败：", result.error.message);
    process.exit(1);
  }

  process.exit(result.status ?? 0);
}

main();
