# Antigravity (`agy`) 支持说明

Antigravity（命令行命令 `agy`）是 AmeTyping 继 Claude Code、Codex、OpenCode 之后接入的第四个 AI 编码助手。本文档详细说明 Antigravity 在生命周期 Hook、桌宠、无头服务、Windose 远程看板、Knowledge Vault 完整存档以及三层记忆同步中的完整集成架构。

---

## 1. 特性对照总览

| 功能 | Antigravity (`agy`) | 说明 |
| --- | --- | --- |
| **桌宠表情与实时进度** | 支持 | 空闲（`/event/idle`）、收到指令（`/event/message`）、思考中（`/event/thinking`）、读取文件/搜索（`/event/reading`）、完成（`/event/done`）、出错（`/event/error`）、打断（`/event/paused`）、会话结束（`/event/quit`） |
| **完整对话与本地面板** | 支持 | 读取 `<root>/brain/<id>/.system_generated/logs/transcript.jsonl`，提取用户输入、工具执行详情、助手回复及 Token 上下文用量（`ctx`） |
| **远程看板与历史归档** | 支持 | 实时流式传输至 NAS SQLite 存储；会话退出后保留历史并生成标准恢复命令：`agy --conversation <id>` |
| **工具与文件改动标注** | 支持 | 自动提取 `x.op = 'cmd' \| 'write' \| 'edit' \| 'read'`、目标路径数组 `x.p` 与命令字符串 `x.cmd`，供看板卡片与文件定位系统使用 |
| **交互式提问（Ask Question）** | 支持 | `ask_question` / `AskUserQuestion` 映射为桌面与远程看板的审批/回答卡片，支持用户多选题或单选回答，答复以 `permissionDecision: 'deny'` 及明确理由回填给模型 |
| **工具权限审批与 Always 规则** | 支持 | 支持 `run_command`、`write_file`、`edit_file` 的实时审批；「总是允许」自动生成 `command(...)` 授权规则（`updatedPermissions` / `permissionOverrides`） |
| **子代理追踪（Subagents）** | 支持 | 自动扫描 `brain/<parentId>/.system_generated/subagents/*.json` 与子会话记录；在 `$TMPDIR/ame-agy-root-<subId>` 动态建立父子映射，将工具事件归属回主会话，并单独呈现子代理进度 |
| **终端回复与后台续聊** | 支持 | 前台 Windows 终端使用 `WriteConsoleInput` 无焦点注入；已关闭会话使用 `agy --conversation <id> -p --dangerously-skip-permissions` 后台续聊 |
| **专属技能与斜杠命令隔离** | 支持 | 独立扫描 `$AGY_CONFIG_DIR/skills`、`~/.gemini/config/skills`、`~/.agents/skills` 与内置技能库；`/api/commands?provider=agy` 与其它工具完全隔离 |
| **产物提取与文件定位** | 支持 | `artifacts.pathsOf('agy:<id>')` 提取会话写出或编辑的文件；`locate` 智能兼容 Windows 双重转义路径（如 `D:\\\\path\\\\file`） |
| **Knowledge Vault 原生字节存档** | 支持 | 采集 `brain/<id>/` 完整目录，含 `transcript.jsonl`、`transcript_full.jsonl`、子代理元数据以及 `implementation_plan.md`、`walkthrough.md` 等产物 |
| **三层统一记忆同步** | 支持 | 全局导出至 `~/.gemini/GEMINI.md`，项目级导出至项目根目录 `AGENTS.md`，并接入项目 `.agents/rules/*.md` |

---

## 2. 生命周期 Hook 架构 (`agy-hook.js` & `install-agy-hooks.js`)

Antigravity 采用配置文件 `hooks.json` 声明生命周期钩子，通过 stdin/stdout 与外界脚本交换 JSON 数据。

### 2.1 支持的 9 大生命周期事件

AmeTyping 在 `hooks.json` 的顶层 `"ametyping"` 分组中注册了全部 9 个生命周期事件：

```json
{
  "ametyping": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node C:/path/to/agy-hook.js SessionStart", "timeout": 3 }] }],
    "PreInvocation": [{ "hooks": [{ "type": "command", "command": "node C:/path/to/agy-hook.js PreInvocation", "timeout": 3 }] }],
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node C:/path/to/agy-hook.js PreToolUse", "timeout": 120 }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node C:/path/to/agy-hook.js PostToolUse", "timeout": 3 }] }],
    "PostInvocation": [{ "hooks": [{ "type": "command", "command": "node C:/path/to/agy-hook.js PostInvocation", "timeout": 3 }] }],
    "SubagentStart": [{ "hooks": [{ "type": "command", "command": "node C:/path/to/agy-hook.js SubagentStart", "timeout": 3 }] }],
    "SubagentStop": [{ "hooks": [{ "type": "command", "command": "node C:/path/to/agy-hook.js SubagentStop", "timeout": 3 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node C:/path/to/agy-hook.js Stop", "timeout": 3 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node C:/path/to/agy-hook.js SessionEnd", "timeout": 3 }] }]
  }
}
```

### 2.2 事件映射与端点转发

`agy-hook.js` 将 Antigravity 的事件转换为 AmeTyping 本地桌宠端点（默认 `127.0.0.1:3940`）：

1. **`SessionStart`**：映射到 `/event/idle`。带上 `provider: 'agy'`、`session`、`project`、`cwd`、`transcript`、`model` 和 `ai`（由 `ai-providers.js` 解析厂商图标）。
2. **`PreInvocation`**：提取 `<USER_REQUEST>` 纯文本指令；若包含用户提示词，映射到 `/event/message`（附带 `prompt` 与摘要），否则映射到 `/event/thinking`。
3. **`PreToolUse`**：
   - 读操作工具（`read_file`、`search_web`、`view_file`、`grep_search` 等）映射到 `/event/reading`。
   - 写操作与执行工具（`run_command`、`write_file`、`edit_file`、`invoke_subagent` 等）映射到 `/event/thinking`。
   - JSON 字符串工具入参（如 `tool_input: "{\"CommandLine\":\"...\"}"`）自动反转义解包。
4. **`ask_question` 问答卡片**：
   - 当检测到工具调用为 `ask_question` 时，规范化提取题目、选项与单选/多选标志，向 `/permission` 发起长轮询请求。
   - 当用户在糖糖桌宠面板或 Windose 远程看板回答后，返回：
     ```json
     {
       "decision": "deny",
       "permissionDecision": "deny",
       "reason": "已由用户在糖糖看板回答：\n- 题目: 选项答案",
       "permissionDecisionReason": "已由用户在糖糖看板回答：\n- 题目: 选项答案"
     }
     ```
     模型收到该 deny 原因后，直接将其视作来自用户的交互回答继续执行，无需终端二次确认。
5. **`PermissionRequest` 拦截**：
   - 支持 `run_command` 生成 `command(cmd)` 规则；
   - 支持 `allow`、`allow` + `updatedPermissions`（总是允许）、`deny` + `message`（拒绝并提供理由）、`{}`（交回终端处理）。
6. **`SubagentStart` / `SubagentStop` 与父子会话关联**：
   - `SubagentStart` 触发时，在 `$TMPDIR/ame-agy-root-<subId>` 写入其父会话 ID；
   - 子会话后续的所有工具事件在进入 Hook 时，自动读取该映射，转发主会话 ID，并将自身 ID 作为 `agentId` 转发，端点归纳为 `/event/thinking`，避免打断主会话。
   - `SubagentStop` 触发时清理临时映射文件。
7. **`Stop`**：映射为 `/event/done`，附带 `last_assistant_message`。打断情况映射为 `/event/paused`，异常映射为 `/event/error`。
8. **`SessionEnd`**：映射为 `/event/quit`。

### 2.3 安装与卸载管理器 (`install-agy-hooks.js`)

- **安装**：`node install-agy-hooks.js`
  - 自动识别全局配置目录（`$AGY_CONFIG_DIR` 或 `~/.gemini/config/hooks.json`）；
  - 保留并合并已存在的其它 Hook 分组；
  - 修改前自动生成 `.ame-backup-<时间戳>` 备份；
  - 遇到畸形 JSON 时抛出语法异常，严禁覆盖损坏文件。
- **卸载**：`node install-agy-hooks.js --remove`
  - 仅移除 `"ametyping"` 分组，其它配置完整保留。

---

## 3. 桌宠终端桥接与控制 (`app/agy-cli.js`)

在 Windows 桌宠中，糖糖直接与运行中的 Antigravity 交互：

1. **进程发现 (`findAgy`)**：
   - 遍历父子进程树，识别 `agy.exe`；
   - 自动跳过 `cmd.exe` / `node.exe` 等 npm/cmd launcher shim，准确锁定外部终端（如 `WindowsTerminal.exe` 或 `OpenConsole.exe`）。
2. **免切焦点打字与回复 (`send`)**：
   - 使用 Windows API `WriteConsoleInput` 向目标终端控制台缓冲区注入按键；
   - 多行输入采用精确逐行输入与换行处理，末尾发送回车提交。
3. **安全提示自动信任 (`greet`)**：
   - 启动新目录时，若检测到控制台出现 `Do you trust the contents of this project?` 或 `Yes, I trust this folder`，自动响应确认，无需人工切回终端按回车。
4. **后台会话续聊 (`resume`)**：
   - 当会话已在终端中退出时，看板发来的新回复通过后台免交互进程恢复：
     ```sh
     agy --conversation <conversation_id> -p --dangerously-skip-permissions
     ```
     提示词直接通过 stdin 管道送入。

---

## 4. 远程桌面与会话流式传输 (`remote/`)

在 Windose 远程网页看板中，Antigravity 体验与原生体验一致：

1. **会话发现与元数据解析 (`app/agy-records.js`)**：
   - 支持多层根目录扫描：`$AGY_HOME`、`~/.gemini/antigravity-cli`、`~/.gemini/antigravity`、`~/.gemini/antigravity-ide`；
   - 从 `history.jsonl` 或 `transcript.jsonl` 首行智能解析会话标题（`<USER_REQUEST>` 提取）；
   - 从 `Model Selection` / `Model:` 正则提取模型名称（如 `gemini-2.5-pro`、`claude-3-7-sonnet` 等），并通过 `app/ai-providers.js` 映射厂商徽标。
2. **精简记录流 (`recordsOf`)**：
   - 过滤 `<EPHEMERAL_MESSAGE>` 与 `<TASK_NOTIFICATION>` 等临时框架噪声；
   - 提取 `PLANNER_RESPONSE` 中的工具调用并格式化为短摘要；
   - 为每条记录补充 `uuid` 与 `timestamp`，通过 `records.createReader` 增量推送给看板。
3. **产物管理 (`remote/agent/artifacts.js`)**：
   - 从会话历史中提取写出的文件路径；
   - 看板「每日报告」自动收集会话修改产物并建立哈希副本。
4. **文件定位器 (`remote/agent/locate.js`)**：
   - 针对 Windows 环境下常见的双重转义反斜杠路径（如 `D:\\\\project\\\\file.py`），提供稳健正则解析与跨分支模糊查找。
5. **快捷恢复命令 (`resumeCmd`)**：
   - 看板在会话离线时生成复制命令：`agy --conversation <conversation_id>`。

---

## 5. Knowledge Vault 完整原生存档与三层记忆同步

### 5.1 完整原生字节存档

不同于看板上展示的精简增量记录，Knowledge Vault 将 Antigravity 的原始上下文以原生字节存入 NAS SQLite（`data/knowledge.sqlite`）：

- **扫描路径**：`<root>/brain/<id>/` 下的完整会话目录；
- **采集内容**：
  - `.system_generated/logs/transcript.jsonl`
  - `.system_generated/logs/transcript_full.jsonl`
  - `.system_generated/subagents/*.json`
  - 产物 Markdown：`implementation_plan.md`、`walkthrough.md`、`task.md` 等。
- **传输保障**：512 KiB 分块传输、每块 SHA-256 校验、数据库事务提交才确认，支持断线续传。

### 5.2 三层统一记忆同步

Antigravity 的指示体系与 AmeTyping 三层记忆无缝结合：

1. **共享全局记忆**：导出写入至用户主目录 `~/.gemini/GEMINI.md`；
2. **机器专属记忆**：在机器全局入口合并下发；
3. **项目级记忆**：写入各项目根目录下的 `AGENTS.md`（与 Codex / OpenCode 共享项目指令入口），并采集项目 `.agents/rules/*.md` 作为记忆来源；
4. **防覆盖保护**：只更新 `<!-- ametyping-memory:start -->` 到 `<!-- ametyping-memory:end -->` 托管区块，本地原有设定与注释全部保留，写入前自动在 `~/.ametyping/memory/backups/` 备份。

---

## 6. 自动化测试与验证

本项目针对 Antigravity 的集成提供了完整的测试矩阵：

```powershell
# 1. 验证 Hook 事件映射、审批决策协议、安装器幂等性与子进程交互
node --test agy-hook.test.js

# 2. 验证会话记录解析、CLI 进程发现、后台续聊参数与子代理扫描器
node --test app/agy-support.test.js

# 3. 验证端到端 Agent <-> Server 完整通信流水线（看板发现、问答决策、产物定位与恢复）
node remote/test/e2e-agy.js
```

所有测试均在本地隔离环境（临时目录与虚拟本地服务）中运行，无需连接真实外部网络或产生模型费用。
