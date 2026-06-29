# 项目规则

## 桌面端打包输出规则

- 桌面端安装包默认只输出到 `apps/desktop/release`，使用项目既有打包命令生成，不要创建 `release-latest`、`release-*` 或带时间戳的替代输出目录。
- 如果 `apps/desktop/release` 被正在运行的 `NovelExtractor.exe` 锁住，先停止打包并提示用户关闭对应程序；不要为了绕过文件锁改用新的输出目录。
- 打包完成后只核对 `apps/desktop/release/NovelExtractor Setup 0.0.0.exe` 的生成时间、大小和退出码，再向用户汇报。
- 临时生成的其他 release 目录应在确认未被进程占用后清理，避免桌面端目录里堆积多份安装产物。
