# Claude Code / Codex 支持对照

| 功能 | Claude Code | Codex |
| --- | --- | --- |
| 桌宠表情、进度、完成和等待审批 | 支持 | 支持；另有中断、上下文压缩进度 |
| 完整对话、本地面板、远程存档、断线续传 | 支持 | 支持；恢复旧日期目录里的对话也会扫描 |
| 工具命令、文件改动、计划、上下文用量 | 支持 | 支持 |
| Windows 终端回复、多行回复、按键、画面 | 支持 | 支持；多行使用 Codex 的 Ctrl+J |
| Linux tmux 回复、按键、画面 | 支持 | 支持 |
| 已关闭会话后台续聊 | `claude -p --resume` | `codex exec resume` |
| 远程新建、在电脑上继续历史会话 | 支持 | 支持 |
| 审批卡片 | 允许、拒绝、规则建议、问题回答 | 允许、拒绝、交回 Codex |
| 服务重启后接回运行中的会话 | 读取 Claude 自身进程记录 | 读取 Ame 通过 hooks 学到的关联；核对进程创建身份 |
| 子代理状态 | 支持 | 支持旧版 parent_thread_id 和 source.subagent.spawn 格式 |
| 命令、技能提示 | Claude 命令、插件、技能 | Codex 命令；`$` 技能，读取 ~/.agents/skills 和 CODEX_HOME/skills |
| 权限模式按钮 | Shift+Tab 轮转 | 打开 `/permissions`；Shift+Tab 保持 Codex 自身行为 |
| 安装、重复安装、迁移路径、备份和卸载 | 支持 | 支持 |

## 使用

```sh
node install-codex-hooks.js
# 在 Codex 的 /hooks 中审核并信任，然后重新打开会话。
node install-codex-hooks.js --remove
```

可在命令最后传入指定的 hooks.json 路径。默认使用 `$CODEX_HOME/hooks.json`，未设置时使用 `~/.codex/hooks.json`；agent/桌宠/无头服务需与 Codex 使用相同的 `CODEX_HOME`。Windows 安装会同时写入 PowerShell 专用命令，支持 Node 或项目路径带空格。安装或卸载会保留其他 hooks 和设置，并备份发生变化的原文件。

接回记录位于 `~/.ametyping/codex-sessions/`，只含会话 ID、进程身份、目录、对话路径及标题。首次升级前未被 hooks 识别的会话，需在下一次事件发生后才能记录；程序退出后再启动时会核对进程身份，避免 PID 复用。Linux 使用 boot_id 和进程启动时刻，Windows 使用进程创建时刻。

## 协议差异

Codex 的 [PermissionRequest hooks](https://learn.chatgpt.com/docs/hooks) 在原生审批提示之前运行，所以卡片等待约 105 秒后交回 Codex；Claude 的卡片可以和终端提示同时等待约 60 分钟。Codex 当前的权限 hook 只支持 allow/deny，不能通过它写入“总是允许”规则或回答 `request_user_input`。这些操作在看板的“画面”中通过终端菜单和按键处理。IDE/桌面客户端没有可操作的 CLI 终端时，只显示进度、记录及可用的 hooks 审批。

Claude 专用的 `/btw` 浮层、后台守护会话和 Ctrl+B / Ctrl+X Ctrl+S / Ctrl+S 按钮不套用到 Codex。Codex 的原生命令、计划模式和后台终端可从它自己的命令提示或终端画面操作。

对话与子代理解析依赖 CLI 写出的 rollout 格式；官方说明该格式不是稳定 hooks 接口。升级 Codex 后如发现格式变化，可先运行以下回归检查。Codex hook 中的 transcript_path 优先用于本地面板，扫描用于发现与存档。

## 验证

```sh
node --test codex-hook.test.js app/codex-cli.test.js app/codex-support.test.js app/permissions.test.js
node remote/test/e2e-codex.js
node remote/test/e2e-session-terminal.js
# Linux：真实 /proc、tmux、hook 进程、服务重启、后台续聊及远程恢复（离线 CLI 替身）
node remote/test/linux-codex-e2e.js
# 另外验证原生 Codex：独立 HOME、回环 HTTP 测试端点、占位密钥
AME_REAL_CODEX="$(command -v codex)" node remote/test/linux-codex-e2e.js
# Windows：隐藏控制台、真实输入桥和独立服务（PowerShell）
node remote/test/win-codex-e2e.js
# 同时验证原生 Windows CLI；填入 codex.exe 的实际路径
$env:AME_REAL_CODEX = 'C:\path\to\codex.exe'
node remote/test/win-codex-e2e.js
```

测试使用临时目录、模拟 CLI/进程和本地测试服务器，不调用付费模型，也不修改真实 Codex 或 Claude 配置。

2026-10-28 已通过 SSH 别名 `dell97` 在 Linux 实机验收：Node 24.14.1、tmux 3.6、Codex CLI 0.162.1，24 项单元测试和 33 项集成检查通过。集成检查使用真实 `/proc`、私有 tmux socket、独立服务端口及临时 HOME，覆盖精确多行中文粘贴、三种审批结果、token 轮换、服务重启接回、后台恢复和远程恢复。原生 Codex 以 `--no-daemon` 运行，仅连接回环测试端点，验证实际 hooks、终端输入、画面和重启接回；首次新会话可等到第一条消息才产生 hooks。测试前后生产服务 PID 和原有 Claude tmux 会话保持不变。

同日完成 Windows 实机验收：Node 22.18.0、原生 Codex CLI 0.164.0，33 项 Codex 集成检查、23 项 Claude 共用链路回归、24 项单元测试通过。覆盖真实 `WriteConsoleInput`、Ctrl+J 多行中文与空行、导航键、审批、npm cmd shim、后台恢复、远程新建/恢复、进程创建身份、重启接回和 token 轮换。原生 CLI 使用独立配置、`--no-daemon` 与回环测试端点，所有测试控制台保持隐藏。

Windows 验收发现并修复了祖先进程遍历越界：查找会话时若跨过服务或终端边界，会把上层宿主 Codex 选成目标；桥接器新开的交互控制台也不能被归类为后台续聊。修复后限制查找边界，并增加对应回归用例。实机测试在输入前强制校验目标 PID 等于其自行创建的替身或原生子进程，否则终止测试，防止输入误投到用户会话。
