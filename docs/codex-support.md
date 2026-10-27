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
```

测试使用临时目录、模拟 CLI/进程和本地测试服务器，不调用付费模型，也不修改真实 Codex 或 Claude 配置。Windows 控制台和 Linux tmux 的真实交互仍需分别在对应系统验收。
