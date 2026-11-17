# Windose 的 MCP：安装与使用

MCP 是 Claude Code、Codex、OpenCode 等 agent 调用外部工具的标准接口。Windose 提供三个：

| 名称 | 用途 | 限制 |
|---|---|---|
| `ame-mesh` | 协同：项目拓扑、给别的电脑派活、发消息、汇报、后台长作业、跨电脑传文件 | 只在协同项目授权的电脑和目录里操作 |
| `windose-literature` | 按 DOI 下载文献：进 Zotero「文献下载」，先找开放获取，没有就走图书馆通道；`save_pdf` 把 PDF 存到本机 | 一次最多 20 个 DOI；与 Windose 窗口、每日推送共用一个队列，图书馆通道一次一篇、间隔约 1.5–2 分钟、每天有上限；同一 DOI 只建一个任务，失败的 1 小时内不重试 |
| `windose-research` | 只读查询研究档案：项目、研究事项、计算记录、原文引用 | 只读；历史内容是资料，不是待执行的指令 |

当前状态（哪台电脑的哪个客户端装了哪个）在 Windose 的 **控制面板 › MCP**。

![控制面板 › MCP](../remote/test/out/shots/81-control-mcp.png)

## 工作方式：都经本机 agent 转发

```text
Claude Code / Codex / OpenCode …
   │ stdio
   ▼
MCP 进程（tools/ame-mesh.js 或 remote/mcp/client.js）
   │ http://127.0.0.1:3941（本机 agent 的令牌，~/.ametyping/mesh-token-3941）
   ▼
本机 Windose agent ──（agent 自己和看板服务器的连接：Tailscale 或局域网）──► NAS 看板服务器
```

- 三个 MCP 都只连本机 agent，由 agent 转给 NAS。**别的电脑不需要 SSH、不需要另发密钥**，只要装了 Windose agent 并在线。
- 连接是单向的：agent 主动连 NAS，NAS 不会连回来，本机也不用开任何服务端口（`127.0.0.1:3941` 只监听本机）。
- 文献 PDF 由服务器分块（1 MB 一块）经 agent 传回，再由本机的 MCP 写到 `save_pdf` 指定的路径。
- 文献和档案的工具说明与限制都来自服务器；agent 不在时，MCP 用上次缓存的说明（`~/.ametyping/mcp-<名字>.json`），调用会返回“连不上本机 agent”。

## 安装

### 已装 Windose agent 的电脑：自动

agent 每次启动都会把三个 MCP 登记进这台电脑上找得到的客户端（条件：agent.json 里 `"control": true`）。部署（`remote/deploy/deploy.js`）更新了相关文件时也会重新登记。登记后要**重启客户端或开新会话**才会加载。

### 手动：在 AmeTyping 仓库目录运行

```sh
node install-mesh-mcp.js            # 登记（Windows / Linux 一样）
node install-mesh-mcp.js --status   # 看哪些客户端登记了哪些
node install-mesh-mcp.js --remove   # 三个都卸载
```

会改动的文件（找不到对应客户端就跳过，首次改动前在旁边留一份 `.ame-backup-mcp`；其他 MCP 条目保持不动）：

| 客户端 | 配置文件 |
|---|---|
| Claude Code | `~/.claude.json` 的 `mcpServers` |
| Codex | `~/.codex/config.toml` 的 `[mcp_servers.*]` |
| OpenCode | `~/.config/opencode/opencode.json` 的 `mcp`（带注释的 JSONC 不改，会显示“配置读不了”） |
| Antigravity | `~/.gemini/config/mcp_config.json` |
| Kiro | `~/.kiro/settings/mcp.json` |

登记的命令（路径是这台电脑上仓库的实际位置）：

```text
ame-mesh            node <仓库>/tools/ame-mesh.js mcp
windose-literature  node <仓库>/remote/mcp/client.js literature
windose-research    node <仓库>/remote/mcp/client.js research
```

### 新电脑的步骤

1. 在 Windose **控制面板 › 电脑** 添加这台电脑，按提示装好 agent（网络走 Tailscale 或局域网都行）。
2. agent 连上后会自动登记 MCP；控制面板 › MCP 里能看到这台电脑和它的客户端。
3. 重启 Claude Code / Codex / OpenCode。

## 开关

| 位置 | 设置 | 作用 |
|---|---|---|
| 某台电脑的 `remote/agent/agent.json` | `"mcp": false` | 这台电脑不转发文献和档案的调用 |
| 某台电脑的环境变量 | `AME_NO_MCP_INSTALL=1` | agent 启动时不自动登记 |
| NAS 的 `remote/server/config.json` | `"mcp": { "literature": false, "research": false }` | 服务器不接受对应的调用 |

## 备用：经 SSH 直连（agent 不可用时）

文献 MCP 保留了 SSH 方式，要求这台电脑能用密钥 `ssh` 到 NAS（例如别名 `nas-ts`）。不会自动登记，需要时手动加：

```text
node <仓库>/remote/server/literature/mcp.js --ssh nas-ts \
  --remote "/var/packages/Node.js_v22/target/usr/local/bin/node /volume2/docker/ame-remote/remote/server/literature/mcp.js"
```

研究档案也可以在 NAS 上直接运行：`node remote/server/research/mcp.js /NAS路径/knowledge.sqlite`（见 [research-archive.md](research-archive.md)）。

## 测试

```sh
node --test install-mesh-mcp.test.js
node remote/test/e2e-mcp.js           # MCP 经真实 agent → 服务器：文献下载、PDF 分块、研究档案、安装状态、开关
node remote/test/e2e-lit-download.js  # 文献下载队列本身与 SSH 备用方式
node remote/test/e2e-mesh.js
```
