# 远程看板 · 进度与交接

更新：2026-09-28 · 分支 `chat-panel`

## 结论

网页 + 服务器 + agent + 本机控制接口已写完并通过本地测试。**还没做**：真实 VPS 部署、在真实运行的糖糖（Electron）里测 `/control/*`。

## 架构

```
浏览器 ──HTTPS──> Caddy(443) ──> 127.0.0.1:8787  server.js（网页 + 登录 + /ws）
                                         │  send / decide（带 rid，结果只回发起的浏览器）
                         VPN 地址:8788 /agent（单独监听，公网没有这个入口）
                                         │
                      agent.js（每台机器，主动连出）── HTTP + 令牌 ──> 本机糖糖 127.0.0.1:3940 /control/*
                                                                     └ chatSend / permissions.decide（和本机面板同一套逻辑）
```

远程控制需三处都开：服务器 `config.json` 的 `control`（默认开）· 该机器 `agent.json` 的 `"control": true`（默认关）· 糖糖正在运行。

## 文件

| 文件 | 内容 |
|---|---|
| `app/main.js` | 新增 `/control/state`、`/control/send`、`/control/decide`；启动时生成随机令牌写到 `~/.ametyping/control-token-<端口>`；拒绝带 `Origin` 的请求 |
| `remote/agent/agent.js` | 扫描 transcript + 轮询糖糖；只执行 `send` / `decide` 两种指令；`control` 默认关 |
| `remote/agent/agent.example.json` | agent 配置示例 |
| `remote/server/server.js` | 一步登录、再次验证（step-up）、来源校验、agent 单独监听、限频、审计 |
| `remote/server/auth.js` | scrypt 密码、TOTP（一次一用）、IP/全局锁定、会话（空闲 8h / 最长 24h / 10 分钟内验证过才可操作） |
| `remote/server/setup.js` | `init` / `password` / `totp` / `add-agent` / `remove-agent` / `production <域名> [VPN地址]` / `list` |
| `remote/public/login.*` | 粉色 Win98 风格登录框，不出现任何名字或图片 |
| `remote/public/index.html`, `app.js` | 会话列表、对话、权限卡片、回复框、「再次验证」弹框 |
| `remote/deploy/Caddyfile.example` | HTTPS、屏蔽 `/agent`、可选 IP 白名单 |
| `remote/deploy/ame-remote.service.example` | systemd 服务（普通用户 + 权限收紧），顶部有部署步骤 |
| `remote/package.json` | 依赖 `ws`、`qrcode` |

## 安全措施

- 登录前：通用登录框、素材需登录、`noindex` + `robots.txt`。
- 登录：用户名 + 密码 + 验证码一次提交，任何错误都返回同一句 `{"error":"failed"}`；验证码只在密码正确时才校验。
- 防爆破：同 IP 15 分钟错 5 次锁 15 分钟；全局 1 小时错 20 次锁 30 分钟；IP 取 `X-Forwarded-For` **最右**一项。
- 操作前再验证：发回复 / 批准权限需 10 分钟内输过验证码（登录也算）；否则返回 `need:'totp'`，页面弹框 → `POST /api/stepup`。
- 会话：cookie 在 HTTPS 下为 `__Host-sid`；HSTS；登出立即断开已打开的 WebSocket；每分钟复查一次过期。
- 跨站：所有 `POST /api/*` 和 `/ws` 校验 Origin；CSP 只允许本站。
- 审计：`server/audit.log` 记录登录、验证、每次操作（机器、会话、字数，不记内容）。

## 本地运行与测试

```bash
cd remote && npm install
node --test ../codex-hook.test.js ../app/permissions.test.js   # 原有单测（9 项）
```

- 端到端测试脚本当前在会话临时目录（`scratchpad/e2e2.js`），**未入库**。覆盖 20 项：登录页无名字、三种登录错误回复一致、跨站拒绝、XFF 伪造无效、step-up、agent 单独端口、登出断开、审计。要长期保留可以搬进 `remote/test/`。
- 本地演示：自己跑 `setup.js init`（设 `AME_REMOTE_CONFIG` 指向临时目录）+ `server.js` + agent，agent 的 `USERPROFILE` 指向含假 transcript 的目录。

## 部署到 t3.micro（Ubuntu 24.04）

1. 实例：CPU 积分改 **standard**；绑弹性 IP；加 1 GB swap。
2. 安全组：443、80 开放；22 只允许自己 IP（或用 SSM）；**不开 8788**。
3. 装 Node 20、Caddy、Tailscale（`tailscale up`，记下服务器 100.x 地址）。
4. 按 `deploy/ame-remote.service.example` 顶部步骤：建 `ame` 用户 → clone → `npm ci --omit=dev` →
   `setup.js init` → `setup.js production 你的域名 <服务器VPN地址>` → `setup.js add-agent <机器名>`。
5. `Caddyfile.example` 改域名放到 `/etc/caddy/Caddyfile`，`systemctl reload caddy`；启用 `ame-remote` 服务。
6. 每台机器：装 Tailscale，`agent.json` 的 `server` 填 `ws://<服务器VPN地址>:8788/agent`，填令牌，需要控制就 `"control": true`，`npm run agent`。

恢复：手机丢了 `setup.js totp`；忘记密码 `setup.js password`（都在服务器上执行）。

## 待办 / 已知问题

- [ ] 在真实运行的糖糖（Electron）里测 `/control/*`（回复打进终端、权限卡片、后台 resume）。
- [ ] 真实 VPS 部署走一遍（证书、systemd、Tailscale 连通）。
- [ ] 把 e2e 测试搬进仓库（`remote/test/`），加 `npm test`。
- [ ] agent 目前靠手动 `npm run agent` 启动；可考虑随糖糖启动或做成 Windows 计划任务。
- [ ] 验证码一次一用：刚登录后 30 秒内若被要求再验证，需等下一个码（正常不会遇到，登录本身算已验证）。
- [ ] 可选：Passkey（WebAuthn）替代 TOTP。
