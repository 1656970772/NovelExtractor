# 项目规则

## 桌面端打包输出规则

- 桌面端安装包默认主干(`main`)分支输出到 `apps/desktop/release`，使用项目既有打包命令生成；非主干分支默认输出到 `apps/desktop/release-<分支名>`（按当前 Git 分支名生成，`/` 等非法字符自动替换为 `-`）。
- 打包时如果检测到要输出的目录为 `release-*`，视为分支打包产物，仍属于可接受临时目录，但建议与对应分支开发目的保持一致。
- 当用户明确要求“直接打包”“重新打包”等时，也按当前分支输出规则执行：主干分支使用 `apps/desktop/release`，非主干分支使用 `apps/desktop/release-<分支名>`。
- 如果 `apps/desktop/release` 被正在运行的 `NovelExtractor.exe` 锁住，先停止打包并提示用户关闭对应程序；不要为了绕过文件锁改用新的输出目录。
- 打包完成后只核对 `apps/desktop/release/NovelExtractor Setup 0.0.0.exe`（主干）或对应分支目录中的该安装包文件生成时间、大小和退出码，再向用户汇报。
- 临时生成的其他 release 目录应在确认未被进程占用后清理，避免桌面端目录里堆积多份安装产物。
