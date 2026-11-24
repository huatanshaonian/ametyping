# 设备更新、Harness 与一键配置

控制面板 › **Skill 与协同 › 设备与 Harness**（旧的「设备更新」链接会跳到这里）：

- 查看各电脑 agent 的版本；部署后服务器自动把新版本推给各电脑，不需要 SSH。
- 查看、安装、更新各电脑上的编程 agent（harness）：Claude Code、Codex、OpenCode、Antigravity（agy）。可以单个装，可以一台电脑全部更新，也可以所有电脑一起更新。
- 一键配置：Claude Code 和 OpenCode 接到 Magpie 网关，每台电脑用一把自己的网关密钥；Codex 保持自己的 ChatGPT 登录，只配上这台电脑的代理。

![Skill 与协同 › 设备与 Harness](../remote/test/out/shots/81-control-fleet.png)

（截图由 `remote/test/ui-control.js` 生成，测试环境里没有电脑在线，所以没有 harness 一栏。）

## agent 自动更新

```text
deploy.js ──ssh──► NAS：remote/server/data/fleet/bundle/{manifest.json, files/}
                       │ 看板服务器每分钟检查；版本变了，或落后的电脑连上来时
                       ▼
            每台电脑的 agent（经它自己和服务器的 wss 连接）
              文件方式（Linux，systemd）：比对 → 只传变了的文件 → 备份 → 写入 → 重启守护
              git 方式（Windows / Linux git 克隆）：git pull --ff-only → 重启守护
                       │
            update-guard.js（独立进程：Linux 用 systemd-run，Windows 经 WMI 启动）
              重启 agent → 120 秒内新 agent 连回服务器 → 保留
                                       连不回来 → 用备份恢复 / git reset --keep → 再重启
```

| 情况 | 处理 |
|---|---|
| 开发目录：多个工作树、本身是链接工作树、不在 main、有没提交的改动 | **永不自动更新**，手动点「更新」也不会更新 |
| `agent.json` 里 `"autoUpdate": false` | 同上 |
| 没开远程控制（`"control": true`） | 只上报版本，不接受更新、安装和配置 |
| 文件在那台电脑上被直接改过（git 历史里没有这个版本） | 停下，标「没更新」；面板里可以选「强制更新」，旧文件留有备份 |
| 同一台电脑、同一个版本 | 只自动试一次；失败后等你在面板里点「更新」 |
| 无头服务（ame-headless）的代码有改动 | 只有单元里写了 `KillMode=process` 才重启它，不会连带杀掉 tmux 里的会话 |

服务器上的轻量探针（aws1、gcp1、cc-ubuntu、openwrt 上的 `ame-probe.sh`）不在这个范围里，它们另有更新方式。

## Harness：安装与更新

agent 只执行代码里写死的命令（`remote/agent/harness.js`），不接受服务器发来的任意命令：

| harness | 安装 | 更新 | 装完后补的 AmeTyping 部分 |
|---|---|---|---|
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash`（Windows：`irm https://claude.ai/install.ps1 \| iex`） | `claude update` | MCP 登记 |
| Codex | `npm install -g @openai/codex@latest` | 同左 | hooks、MCP 登记 |
| OpenCode | `npm install -g @opencode/cli@latest` | `opencode upgrade` | 插件、MCP 登记 |
| Antigravity | `curl -fsSL https://antigravity.google/cli/install.sh \| bash`（Windows：`irm …/install.ps1 \| iex`） | `agy update` | hooks、MCP 登记 |

- 下载走这台电脑的代理（见下节）。
- 判断装没装看的是程序本身（PATH、npm 全局目录、各安装器的默认目录），不看配置目录：配置目录可能先于程序存在，比如 MCP 登记或记忆同步会先建它。
- 装完第一次使用时，Codex 要 `codex login --device-auth` 并在 `/hooks` 里信任 AmeTyping 的 hooks；Claude Code 和 Antigravity 可能要登录或确认一次。
- Kiro 不装，只经反向代理使用。
- 盘点在 agent 启动 20 秒后才做：Windows 上，agent 刚连上、第一次请求桌宠时同时启动子进程，那次请求会挂住（e2e 测试里复现过）。

## 一键配置写什么

| harness | 文件 | 改动 |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | `env.ANTHROPIC_BASE_URL`、`env.ANTHROPIC_AUTH_TOKEN`、填了的 `ANTHROPIC_DEFAULT_*_MODEL`；去掉 `ANTHROPIC_API_KEY`（它的优先级更高）。**不加代理**：网关在局域网 / Tailscale 上；如果文件里本来有代理变量，就把网关域名加进 `NO_PROXY`，让它直连 |
| OpenCode | `~/.config/opencode/` | 密钥写进 `.secrets/magpie-nas.key`；`opencode.json` 里只改 `providers.magpie.settings` 的 `baseURL` 和 `apiKey`；没有 `opencode.json` 时用面板模板生成一份 |
| Codex | `~/.ametyping/harness-net.json` | **不改 `config.toml`**，保持 ChatGPT 登录。记下这台电脑的代理：看板启动的 Codex 会话会带上它（`headless/launch.js`），安装、更新也用它。自己在终端里开的 Codex 用终端自己的代理设置 |

- 代理按电脑设，在「配置 agent」里填；没填的电脑用面板上的「默认代理」。
- 其余配置原样保留。每个文件改之前都备份到那台电脑的 `~/.ametyping/config-backups/`。
- Magpie 密钥在 Magpie 上的名字是 `windose-<电脑名>`，用 Magpie 管理接口创建，只在配置 Claude Code 或 OpenCode 时需要。密钥原文只发给那台电脑的 agent 一次，存在 `~/.ametyping/magpie-key.json`（0600）；看板只记密钥 id。
- 同一台电脑再配置时沿用它已有的密钥。勾选「重新发一把」会轮换密钥，旧的随即失效。
- 配置可以在装软件之前写：安装不会改这些文件（见下面 panasonic 实测）。
- 改完之后，已经开着的 Claude Code / Codex / OpenCode 要重开才会用上新配置。

## 第一次启用

1. 合并并部署：`node remote/deploy/deploy.js`。之后每次部署都会把更新包放到 NAS 上。
2. 旧 agent 先更新一次：还不认识自动更新的 agent，`deploy.js --ssh-agents`（`deploy.local.json` 里的电脑），或按它原来的方式（git 克隆就 `git pull --ff-only` 再重启 agent）。
3. Magpie 自动发密钥：NAS 上的 Magpie 要有管理接口（v0.1.4722 起有，2026-11-23 已升级），再建一把 `admin local` 的密钥，写进 `config.json` 的 `magpie.adminKeyFile`（脚本：NAS 上 `/volume2/docker/ame-remote/setup-magpie-admin.sh`，已执行）。
4. 在面板里填网关地址、默认代理和模型名（不填的不改），然后对每台电脑点「配置 agent」。

## 验证

| 测试 | 内容 |
|---|---|
| `node --test remote/test/fleet.test.js` | agent 版本判定、暂存校验、写入与回滚；Claude Code / OpenCode / Codex 配置；harness 盘点、安装、更新（模拟命令）；Magpie 管理接口（模拟）；服务器编排，含 harness 单个、全部、所有电脑（19 项） |
| `node remote/test/e2e-fleet.js` | 真实服务器加真实 agent：开发目录不更新；agent 上报 4 个 harness；一键配置走完整链路，Codex 的 config.toml 不动、代理记下，密钥不留在服务器上（21 项） |
| dell97 实机（2026-11-23，临时目录 + 临时 user 单元） | 守护进程用 systemd-run 启动，在 agent 单元重启后仍然存活；好版本被保留，坏版本 120 秒后回滚并恢复运行（9 项） |
| panasonic 实机（2026-11-24） | 见下表 |

panasonic（Fedora）实测：

| 项目 | 结果 |
|---|---|
| 临时 HOME 里先写配置，再从零安装 Claude Code | 29 秒，装到临时 HOME 的 `~/.local/bin`，2.1.331 |
| 同上，Antigravity | 14 秒，1.5.16 |
| 安装前写好的 4 个配置文件（Claude settings、agy settings / hooks、Codex config.toml） | 哈希全部不变 |
| 真实环境更新全部 harness | Claude Code 2.1.330 → 2.1.331，Codex 0.171.0 → 0.172.0，OpenCode 1.19.6（已是最新），Antigravity 1.5.14 → 1.5.16 |
| 更新前后 7 个配置文件（Claude、Codex、OpenCode、agy） | 哈希全部不变 |
| 更早一次（同日）：`npm i -g @openai/codex` 安装和首次运行 | `config.toml`、`AGENTS.md` 不变；首次运行只新增 Codex 自己的状态文件（sqlite、installation_id 等） |

还没在实机上验证的：Windows 上 git 方式的 agent 自动更新（WMI 守护）；Windows 上 harness 的安装脚本；看板在 Windows 上启动 Codex 会话时带代理（`headless/launch.js` 只管 Linux 的 tmux 启动）。
