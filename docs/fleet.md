# 设备更新与一键配置

控制面板 › **设备更新**：查看各电脑 agent 的版本；部署后服务器自动把新版本推给各电脑，不需要 SSH；也可以一键把 Claude Code / Codex / OpenCode 接到 Magpie 网关，每台电脑用一把自己的网关密钥。

## 工作方式

```text
deploy.js ──ssh──► NAS：remote/server/data/fleet/bundle/{manifest.json, files/}
                       │ 看板服务器每分钟检查；版本变了，或落后的电脑连上来时
                       ▼
            每台电脑的 agent（经它自己和服务器的 wss 连接）
              文件方式（Linux，systemd）：比对 → 只传变了的文件 → 备份 → 写入 → 重启守护
              git 方式（Windows git 安装）：git pull --ff-only → 重启守护
                       │
            update-guard.js（独立进程：Linux 用 systemd-run，Windows 经 WMI 启动）
              重启 agent → 120 秒内新 agent 连回服务器 → 保留
                                       连不回来 → 用备份恢复 / git reset --keep → 再重启
```

| 情况 | 处理 |
|---|---|
| 开发目录：多个工作树、本身是链接工作树、不在 main、有没提交的改动 | **永不自动更新**，手动点「更新」也不会更新 |
| `agent.json` 里 `"autoUpdate": false` | 同上 |
| 没开远程控制（`"control": true`） | 只上报版本，不接受更新和配置 |
| 文件在那台电脑上被直接改过（git 历史里没有这个版本） | 停下，标「没更新」；面板里可以选「强制更新」，旧文件留有备份 |
| 同一台电脑、同一个版本 | 只自动试一次；失败后等你在面板里点「更新」 |
| 无头服务（ame-headless）的代码有改动 | 只有单元里写了 `KillMode=process` 才重启它，不会连带杀掉 tmux 里的会话 |

本机（开发主目录 `D:\ametyping`）有多个工作树，会被识别成开发目录，所以不会被更新；deploy 只在工作目录正好是部署的那个提交时重启本机 agent，这一点和以前一样。

## 第一次启用

1. **合并并部署**：`node remote/deploy/deploy.js`。之后每次部署都会把更新包放到 NAS 上。
2. **旧 agent 先用 SSH 更新一次**：现在各电脑上跑的 agent 还不认识自动更新。`node remote/deploy/deploy.js --ssh-agents` 按 `deploy.local.json` 走一遍以前的 SSH 更新，以后就交给看板了。没写进 `deploy.local.json` 的电脑，用它原来的方式更新一次。
3. **Magpie 自动发密钥（可选）**：
   - NAS 上的 Magpie 要先升级到有管理接口的版本（2026-11-23 检查时，NAS 上的版本访问 `/v1/magpie/admin/` 返回 404，说明还没有）。可以在「网络与设备」里点升级。
   - 在 NAS 上建一把能管理 Magpie 的密钥：
     ```sh
     sudo docker exec magpie magpie gateway-key add "Windose 管理"     # 打印出 id 和密钥（只显示这一次）
     sudo docker exec magpie magpie gateway-key admin <id> local
     ```
   - 把密钥存进文件（`chmod 600`），然后在看板的 `config.json` 里加 `"magpie": { "baseURL": "http://127.0.0.1:3425/v1", "adminKeyFile": "<文件路径>" }`，再重启看板服务器。
4. 在面板里填**网关地址**（各电脑访问 Magpie 用的地址，例如 `https://magapi…`）和模型名（不填的不改），然后对每台电脑点「配置 agent」。

## 一键配置写什么

| agent | 文件 | 改动 |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | `env.ANTHROPIC_BASE_URL`、`env.ANTHROPIC_AUTH_TOKEN`、填了的 `ANTHROPIC_DEFAULT_*_MODEL`；去掉 `ANTHROPIC_API_KEY`（它的优先级更高，会盖过 token） |
| Codex | `$CODEX_HOME/config.toml` | 顶层 `model_provider = "magpie"`（填了模型时还有 `model`），整段替换 `[model_providers.magpie]`（`experimental_bearer_token`、`wire_api = "responses"`） |
| OpenCode | `~/.config/opencode/` | 密钥写进 `.secrets/magpie-nas.key`；`opencode.json` 里只改 `providers.magpie.settings` 的 `baseURL` 和 `apiKey`；没有 `opencode.json` 时用面板模板生成一份 |

- 其余配置原样保留。每个文件改之前都备份到那台电脑的 `~/.ametyping/config-backups/`。
- 密钥在 Magpie 上的名字是 `windose-<电脑名>`，用 Magpie 管理接口创建。密钥原文只发给那台电脑的 agent 一次，存在 `~/.ametyping/magpie-key.json`（0600）。看板只记密钥 id，页面上也不显示原文。
- 同一台电脑再配置时沿用它已有的密钥。勾选「重新发一把」会轮换密钥，旧的随即失效。
- 改完之后，已经开着的 Claude Code / Codex / OpenCode 要重开才会用上新配置。

## 验证

| 测试 | 内容 |
|---|---|
| `node --test remote/test/fleet.test.js` | agent 版本判定、暂存校验、写入与回滚、三种配置文件、Magpie 管理接口（模拟）、服务器编排（14 项） |
| `node remote/test/e2e-fleet.js` | 真实服务器加真实 agent：开发目录不更新，一键配置走完整链路，密钥不留在服务器上（17 项） |
| dell97 实机（2026-11-23，临时目录 + 临时 user 单元） | 守护进程用 systemd-run 启动，在 agent 单元重启后仍然存活；好版本被保留，坏版本 120 秒后回滚并恢复运行（9 项） |

Windows 的 git 方式自动更新（WMI 启动守护、计划任务重启）还没有在实机上验证过。
