# OpenCode 支持

需要 OpenCode **v2**（本机按 2.2.0 验证；v1 的插件 API 不同，暂不适配）。OpenCode 是第三个接入的 CLI / 服务端（Claude Code、Codex 之外）。它和前两个不一样的地方在于**不需要 hook 进程，也不需要读终端画面**：OpenCode 的 server 里本来就有每个会话的完整消息、工具调用和权限请求，AmeTyping 用一个插件（[`opencode-plugin/`](../opencode-plugin)）直接接上它。

| 功能 | OpenCode |
| --- | --- |
| 桌宠表情、进度、完成和等待审批 | 支持（开始处理、工具、出错、中断、完成） |
| 完整对话、本地面板、远程存档、断线续传 | 支持：插件把会话镜像到 `~/.ametyping/opencode/sessions/<id>.jsonl`，与 Claude/Codex 相同的精简记录格式 |
| 工具命令、文件改动、计划、上下文用量 | 工具与文件改动支持；上下文用量暂不显示 |
| Windows 终端回复、多行回复、按键、画面 | **回复不走终端**：直接调用 OpenCode 会话 API（多行原样送达）；没有终端按键和终端画面（对话直接在看板里看） |
| Linux tmux 回复、按键、画面 | 同上，不需要 tmux |
| 已关闭会话后台续聊 | `opencode run --auto -s <id> --format json "<text>"` |
| 远程新建、在电脑上继续历史会话 | 支持：`opencode --prompt "<text>"` / `opencode -s <id>` |
| 审批卡片 | 允许、总是允许、拒绝（OpenCode 自己的终端提示同时还在） |
| 服务重启后接回运行中的会话 | 插件在每个事件上重写会话登记；服务重启后下一次事件就会重新出现 |
| 子代理状态 | 子代理的工具调用会显示为进度，但没有单独的子代理列表 |
| 命令、技能提示 | 暂不支持 |
| 权限模式按钮 | 不适用（OpenCode 的模式在 TUI 里切换） |
| API 别名 | 不适用（OpenCode 用自己的 `opencode.json` 配置模型） |

## 安装

```sh
node install-opencode-plugin.js              # 写进全局配置（原文件先备份）
node install-opencode-plugin.js --remove     # 移除
node install-opencode-plugin.js --config <path/to/opencode.json(c)>
```

它会：

1. 找到 `~/.config/opencode/opencode.json(c)`（或 `$XDG_CONFIG_HOME/opencode/`），
2. 在 `plugins` 数组里加入本仓库 `opencode-plugin/` 的绝对路径（不复制文件，`git pull` 就更新），
3. 原文件备份为 `opencode.json.ame-backup-<时间戳>`。

配置可以是 JSONC：注释和格式都保留。OpenCode 监视配置文件，保存后会自动重载插件；没生效就 `/reload` 或重开 OpenCode。

一键安装脚本（`install/install-windows.ps1`、`install/install-linux.sh`）检测到 `opencode` 时会自动执行这一步。

## 它是怎么工作的

插件是 OpenCode 的 server 插件，加载在每个 location 各一份，做四件事：

1. **事件**：订阅 `ctx.event`，只处理本 location 的事件，映射成 Ame 的 `/event/<类型>`：
   `session.execution.started → thinking`、`session.tool.called → thinking`（工具一行）、
   `session.execution.succeeded → done`、`session.execution.failed → error`、
   `session.execution.interrupted → paused`、压缩开始/结束 → thinking、`session.renamed → meta`（只改标题）、
   `session.deleted → quit`。
2. **对话镜像**：在事件后（去抖 220 ms）读取 `ctx.session.context()`，把**已完成**的消息追加进
   `~/.ametyping/opencode/sessions/<id>.jsonl`：你说的话和回复全文、每个工具调用一行、工具输出和 reasoning 不写。
   第一行是 `{"type":"meta","id","cwd","title"}`。存档、面板、搜索都读这个文件，不碰 OpenCode 的内部数据库。
3. **控制端点**：在 `127.0.0.1` 随机端口监听，令牌写进
   `~/.ametyping/opencode/sessions/<id>.json`（0600）。Ame 用它把回复送进会话（`ctx.session.prompt`）、
   中断（`ctx.session.interrupt`）、读会话文本（控制端点的 `/screen`）、改名。
4. **权限卡片**：`permission.asked` 时把工具、资源、说明 POST 到 Ame 的 `/permission`（长轮询，最长一小时）；
   卡片选的允许 / 总是允许 / 拒绝，通过 `ctx.permission.reply({decision:'once'|'always'|'reject'})` 回答 OpenCode。
   OpenCode 自己的提示同时在终端里，任意一边回答都行；终端先答时 `permission.replied` 会让插件断开长轮询，卡片随之收起。

多个 location（同一台机器上不同项目）各自有一个插件实例和随机端口，会话 id 全局唯一，互不干扰。
权限、令牌和镜像都在 `~/.ametyping/opencode/` 下（目录 0700，文件 0600），只监听回环地址。

## 本地服务与看板

- 会话 id 是 `opencode:<OpenCode 会话 id>`（`ses_...`），与 Claude 的 UUID、Codex 的 `codex:<uuid>` 区分开。
- 会话的 `pid` 是 OpenCode server 的进程：它就是「会话还活着」的判据；回复经插件，不需要终端。
- 面板和看板用 OpenCode 官方的方块标志（单色，跟随文字颜色）；「在电脑上继续」用 `opencode -s <id>`，在会话原来的目录打开 TUI。
- 已关闭的会话从后台续聊时用 `opencode run --auto`：`--auto` 让未被明确拒绝的操作自动允许，
  否则非交互运行会把权限请求直接拒绝掉。
- 首次安装时插件会登记最近 10 个、7 天内有动静的会话，并在镜像落后于会话时补一次历史（只补一次，按文件时间判断）。

## 已知限制

- 只有插件加载之后（或它补到的最近会话）才有镜像；更早的历史不会出现在看板存档里。
- 子代理会以父会话里的一行工具调用出现，不单独列出；子代理自己发起的权限提示仍留在 OpenCode 终端里。
- 回复文字作为 `opencode run` 的参数传给后台续聊（本机命令行可见）；实时回复走 API，不经过命令行。
- 不支持终端按键、`/` 命令提示、权限模式按钮和 API 别名（OpenCode 自己的配置负责模型与权限）。
- 上下文用量（`ctx` 记录）暂未上报。

## 验证

```sh
# 纯逻辑：事件映射、镜像记录、面板文本；插件在假 OpenCode server 里的完整回路
node --test opencode-plugin/protocol.test.mjs opencode-plugin/plugin.test.mjs

# 桥接、会话登记、安装器（JSONC 保留注释、幂等、--remove）
node --test app/opencode.test.js

# 端到端：镜像 → agent → 看板存档、恢复命令、权限 provider、在电脑上继续
cd remote && node test/e2e-opencode.js
```

真实 OpenCode（v2.2.0）已在本机验证：`opencode run --standalone` 的事件到达无头服务、面板显示
`opencode:ses_...`、会话镜像写入完整用户/助手/工具记录、通过 `/control/send` 回复后镜像继续增长；
另用本地假模型验证了非交互运行下 `session.execution.failed` 的错误路径和 `permission.asked → /permission`
卡片通路。交互式 TUI 里的权限卡片允许/拒绝由插件单元测试覆盖（假 server 回答后断言 `ctx.permission.reply`）。
