# Kiro CLI 支持说明

Kiro CLI（命令 `kiro-cli`）是 AmeTyping 接入的第五个 AI 编码助手，与 Claude Code、Codex、OpenCode、Antigravity 并列。本文档说明 Kiro 在生命周期 Hook、桌宠、无头服务、Windose 远程看板与完整字节存档中的集成，并**诚实记录它与其它 provider 在协议上的差异**。

---

## 1. 特性对照总览

| 功能 | Kiro CLI | 说明 |
| --- | --- | --- |
| 桌宠表情与实时进度 | 支持 | `agentSpawn`→空闲、`userPromptSubmit`→收到指令、`preToolUse`→读取（read/grep/glob/introspect/web_*）或思考（shell/write/code…）、`postToolUse` 失败→出错、`stop`→完成 |
| 完整对话与本地面板 | 支持 | 读取 `~/.kiro/sessions/cli/{id}.jsonl`，解析用户提问、助手回复、工具调用（一行摘要）；思考（thinking）与工具输出不展示 |
| 远程看板与历史归档 | 支持 | 实时精简记录流式传输至看板；会话退出后保留为「历史」，并给出恢复命令 `kiro-cli chat --resume-id <id>`（带正确目录） |
| 工具与文件改动标注 | 支持 | `read`→`operations[].path`、`write`→`path`、`shell`→`command`、`todo_list`→任务清单；供看板卡片与「我的电脑」文件定位使用 |
| 模型厂商徽标 | 支持 | 从 `{id}.json` 末轮 `model` 提取（如 `claude-sonnet-4.5`→Anthropic 标）；动态 `auto` 模型只显示 Kiro 标，不猜厂商 |
| Windows 终端回复、多行回复、按键、画面 | 支持 | `WriteConsoleInput` 无焦点注入；多行用 Ctrl+J 逐行、末尾回车提交 |
| Linux tmux 回复、按键、画面 | 支持 | 无头服务在 tmux 里回复/按键/读画面 |
| 已关闭会话后台续聊 | 支持 | `kiro-cli chat --resume-id <id> --no-interactive --trust-all-tools "<prompt>"`（提示词作参数，非 stdin） |
| 远程新建、在电脑上继续历史会话 | 支持 | 看板里在指定文件夹启动 `kiro-cli chat`，或 `--resume-id` 续上；新文件夹的信任提示自动确认 |
| 服务重启后接回运行中的会话 | 支持 | 记录会话↔进程关联（`~/.ametyping/kiro-sessions/`），核对进程身份后接回 |
| 专属技能提示 | 支持 | 扫描 `~/.kiro/skills` 与 `~/.agents/skills` 的 SKILL.md；`/api/commands?provider=kiro` 与其它工具隔离 |
| 完整字节存档 | 支持 | Knowledge Vault 采集 `{id}.jsonl` 与 `{id}.json` 原始字节；子会话按父子关系归档 |
| **审批卡片（允许/拒绝）** | **不支持双向卡片** | 见下方「协议差异」：Kiro 没有 PermissionRequest hook |
| **子代理层级追踪** | **部分** | 没有 Subagent hook；子会话靠 `.json` 的 `session_created_reason="subagent"` 识别并跳过，不作为独立 root 列出 |

---

## 2. 生命周期 Hook (`kiro-hook.js` & `install-kiro-hooks.js`)

### 2.1 配置位置与两种格式

与 Codex（独立 `hooks.json`）不同，Kiro 的 hook 写在 **agent 配置文件内**（`~/.kiro/agents/<name>.json`，可被 `KIRO_HOME` 重定位）。支持两种等价格式，安装器按文件原有格式写回：

**object 格式**（trigger → hook 数组）：
```json
{
  "name": "default",
  "hooks": {
    "agentSpawn":       [ { "command": "node /path/to/kiro-hook.js" } ],
    "userPromptSubmit": [ { "command": "node /path/to/kiro-hook.js" } ],
    "preToolUse":       [ { "matcher": "*", "command": "node /path/to/kiro-hook.js" } ],
    "postToolUse":      [ { "matcher": "*", "command": "node /path/to/kiro-hook.js" } ],
    "stop":             [ { "command": "node /path/to/kiro-hook.js" } ]
  }
}
```

**array 格式**（扁平列表，带显式 trigger）：
```json
{
  "name": "default",
  "hooks": [
    { "name": "ametyping-agentSpawn", "trigger": "agentSpawn", "action": { "type": "command", "command": "node /path/to/kiro-hook.js" } }
  ]
}
```

### 2.2 事件映射

`kiro-hook.js` 从 stdin 读取 hook 事件 JSON，把 Kiro 的五个触发器映射到桌宠端点（默认 `127.0.0.1:3940`）：

| 触发器 | 端点 | 文案 |
| --- | --- | --- |
| `agentSpawn`（别名 `SessionStart`） | `/event/idle` | — |
| `userPromptSubmit` | `/event/message` | `收到：<prompt>` |
| `preToolUse`（读类工具） | `/event/reading` | `在看 / 在找 / 在查 …` |
| `preToolUse`（写/执行工具） | `/event/thinking` | `在跑 / 在改 …` |
| `postToolUse`（`status:"error"` 或 `success:false`） | `/event/error` | `出错了：<tool>` |
| `postToolUse`（成功） | `/event/thinking` | — |
| `stop` | `/event/done` | `完成了：<assistant_response>` |

会话 id 来自 **`KIRO_SESSION_ID`** 环境变量（Kiro 为所有子进程注入；hook 事件 JSON 本身不含它）。transcript 路径由 session id 推导为 `$KIRO_HOME/sessions/cli/<id>.jsonl`。

`agentSpawn` / `userPromptSubmit` 的 stdout 会被 Kiro 加入对话上下文，所以 `kiro-hook.js` 的 stdout **始终为空**，进度只经 loopback HTTP 上报。

### 2.3 安装与卸载

```sh
# 装进默认 agent（$KIRO_HOME/agents/default.json）
node install-kiro-hooks.js

# 装进某个命名 agent（~/.kiro/agents/my-agent.json）
node install-kiro-hooks.js my-agent

# 或直接给出配置文件路径
node install-kiro-hooks.js /abs/path/to/agent.json

# 卸载（只移除 AmeTyping 的 hook，其它保留）
node install-kiro-hooks.js --remove [target]
```

安装会保留文件原有格式与其它 hook，修改前自动备份为 `*.ame-backup-<时间戳>`，重复安装是幂等的；遇到畸形 JSON 会报错并拒绝覆盖。装好后用 Kiro 的 `/hooks` 查看，或重开会话让 `agentSpawn` 生效。

---

## 3. 会话记录与续聊 (`app/kiro-records.js`, `app/kiro-cli.js`, `app/kiro-sessions.js`)

- **存储**：`~/.kiro/sessions/cli/` 下每个会话有 `{id}.json`（元数据：cwd、标题、`session_created_reason`、每轮 model 与 context 用量）、`{id}.jsonl`（对话日志，每行 `{version, kind, data}`）、`{id}.lock`（会话活动时存在）。
- **记录解析**：`recordsOf` 把 `Prompt`/`AssistantMessage`/`ToolResults` 转成与其它 provider 一致的精简记录；`thinking` 折叠、工具输出丢弃，与 Claude/Codex 的处理一致。
- **续聊**：`kiro-cli chat --resume-id <id> --no-interactive --trust-all-tools "<prompt>"`。Kiro 的无头模式要求把提示词作为**参数**传入（不是 stdin），并需 `--trust-all-tools` 以免在工具审批处挂起。
- **接回**：`~/.ametyping/kiro-sessions/<id>.json` 记录会话↔PID↔进程身份，服务重启后核对身份再接回仍在运行的 CLI。

---

## 4. 协议差异（诚实记录）

Kiro CLI 的 hook 体系比 Claude Code / Codex 精简，以下能力**无法达到完全对等**，本项目用降级方案处理并在此如实说明：

1. **没有 PermissionRequest hook。** Kiro 的 `preToolUse` 只能放行（exit 0）或阻止（exit 2，stderr 返回给模型），**无法像 Codex/Antigravity 那样携带审批决定双向回传**。因此：
   - 桌宠/看板**不弹出「允许 / 拒绝」卡片**给 Kiro 会话；
   - 工具审批仍由 Kiro 终端自己的提示处理，远程端通过看板的「终端画面 + 按键」操作；
   - 若要无人值守，用 `--trust-all-tools` 启动或在 agent 配置里设 `allowedTools` / `toolsSettings`。
2. **没有 SessionEnd 触发器。** 会话关闭靠 `{id}.lock` 文件消失来推断，而不是一个显式退出事件。
3. **没有 Subagent hook。** 子会话（`session_created_reason="subagent"`）靠读 `.json` 识别并**跳过**，不作为独立根会话列出；它们的工具事件不单独呈现层级。
4. **没有 Interrupt / Compact 触发器。** 中断与上下文压缩不会产生专门的进度事件（Codex 有）。
5. **Shift+Tab 保持 Kiro 自身行为**，不套用 Claude 的权限模式轮转解析。

除上述几点外，Kiro 在实时进度、完整对话、远程回复、后台续聊、远程新建/恢复、模型厂商徽标、技能提示、完整字节存档上与其它 provider 对等。

---

## 5. 测试与验证

```sh
# 1. Hook 事件映射、安装器（object/array 格式、幂等、--remove、备份、拒绝畸形 JSON）、真实子进程 HTTP relay
node --test kiro-hook.test.js

# 2. 会话记录解析、metaOf/fileOf、模型厂商徽标、CLI 续聊参数与进程发现、会话-PID 注册表
node --test app/kiro-support.test.js

# 3. 端到端 agent <-> server 流水线（会话发现、标题、resume 命令、provider 命令隔离、对话流）
node remote/test/e2e-kiro.js
```

所有测试在临时目录与本地测试服务里运行，使用临时 `KIRO_HOME`，不连外网、不产生模型费用、不改动真实 Kiro 配置。
