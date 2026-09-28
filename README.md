# AmeTyping · 糖糖敲键盘桌宠

A Bongo-Cat–style desktop pet for Windows: Ame (糖糖 / 超てんちゃん) from *NEEDY GIRL OVERDOSE* sits behind a 75% keyboard and types along with you — the key you press is the key she hits. Optional Claude Code integration shows what your Claude sessions are doing in a Windose-style panel under her.

Windows 桌宠：Q 版糖糖坐在一把 75% 键盘后面，你按哪个键她就敲哪个键。可选接入 Claude Code，在她下面用 Windose 风格的对话框实时显示每个会话的进度。

## 下载 / Download

到 [Releases](../../releases) 下载 `AmeTyping-portable.exe`，双击即可运行（单文件便携版，首次启动要解压，会慢几秒）。

Grab `AmeTyping-portable.exe` from [Releases](../../releases) and run it. It is a single-file portable build; the first launch takes a few seconds to unpack.

## 功能

- **跟着你打字**：全局键盘钩子，按键映射到 GravaStar 75% 配列上的对应键；双手按指法分区、不交叉，组合键（Ctrl+Z 等）会一只手按住修饰键。
- **表情与小动作**：打字速度、退格、回车、空闲都会改变表情；空闲时眼睛跟着鼠标看，偶尔打哈欠、捧杯子喝茶，久了会睡着。点她一下会脸红。
- **键盘**：手绘质感的 75% 键盘，按键有淡粉色涟漪光扩散，底部 RGB 背光；托盘可切换 NGO 主题键帽。
- **Claude Code 面板**（可选）：左边是会话列表（标题、状态、未读红点），右边是选中会话的进度日志；可拖动、可拉伸，和糖糖左右/上下贴边联动。
- **窗口**：透明区域逐像素鼠标穿透；拖动她本体移动，拖右下角缩放；托盘菜单有大小、朝向、键帽主题、鼠标穿透、开机自启等。

## 隐私

- 键盘钩子（[uiohook-napi](https://github.com/SnosMe/uiohook-napi)）**只读取键码**（哪个物理键），不记录、不保存、不上传你输入的文字。
- 程序不联网。Claude Code 面板只监听本机 `127.0.0.1:3940`，数据只来自你自己配置的 hook。

## 接入 Claude Code（可选）

1. 装好 [Node.js](https://nodejs.org/)。
2. 把本仓库的 `hook-relay.js` 和 `permission-hook.js` 放到任意位置。
3. 参考 [`claude-hooks.example.json`](claude-hooks.example.json)，把其中的 `hooks` 合并进 `~/.claude/settings.json`，并把两个脚本的路径改成实际路径。
4. 开着糖糖用 Claude Code，面板会在有会话活动时自动出现；托盘菜单「打开 Claude 面板」也能手动叫出来。

### 面板模式

权限确认卡片在两种模式下都会弹出，显示工具名、工作目录、命令／文件路径和完整参数，提供「允许」「拒绝」。终端仍可回答；请求断开或收到后续工具／结束事件时，面板撤掉对应卡片，过期按钮不能再次决定。糖糖没开时 hook 静默退出，继续原来的终端确认流程。

`PermissionRequest` 必须是同步 command hook（不要设置 `async: true`），示例超时为 120 秒。面板最多等待 105 秒，脚本自身等待 110 秒；超时不自动允许或拒绝，交回 Claude 原有权限流程。请同时更新 `hook-relay.js`，后续事件才能及时清理卡片。协议见 [Claude Code hooks 文档](https://code.claude.com/docs/en/hooks#permissionrequest)。

托盘菜单「面板模式」可以切换：

- **弹出进度**（默认）：有动静时弹出一行行进度，停下后自动收起。
- **常驻对话**：面板一直在。右边是这个会话的完整对话（从 transcript 读取），底下可以直接回复：
  - 会话开在终端里：回复会直接打进那个终端（`WriteConsoleInput`，不抢焦点、不模拟全局按键），和你在终端里敲的一样；Claude 正忙时会进入排队。
  - 会话已经关了：用 `claude -p --resume <id>` 在后台续上，结果照样出现在面板里（需要确认权限的操作会被跳过）。
  - IDE 插件 / 桌面 App 里的会话没有终端可打字，只能看。
  - 会话正在等你确认（权限卡片未处理，或终端里有提问 / 选择框）时，回复会被拦下，免得文字被打进确认框里；先在卡片或终端里处理掉再发。

`hook-relay.js` 读取 hook 事件，生成一行中文进度（在读 / 在改 / 在跑 / 要你确认 / 完成了……），会话标题取自该会话 transcript 里的自定义标题，然后 POST 到本机 3940 端口。它 0.7 秒内必定退出，不会拖慢 Claude。

## 接入 Codex（可选）

支持 Codex 的 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PermissionRequest`、`Stop`、`Interrupt` 和 `SessionEnd`。Claude / Codex 会话共用面板，但有各自的来源标识和权限请求。

在仓库根目录执行 `node install-codex-hooks.js`，会将 `codex-hook.js` 的绝对路径合并进 `$CODEX_HOME/hooks.json`（默认 `~/.codex/hooks.json`）。已有配置先备份，其他 hook 与 `config.toml` 中的 `notify` 保留；重复安装不会重复添加相同命令。也可参考 [`codex-hooks.example.json`](codex-hooks.example.json) 手动配置。移动仓库后需更新 hook 路径并移除旧路径的条目。

安装后在 Codex CLI 输入 `/hooks`，审查并信任 AmeTyping 的 hook 定义；新会话加载后生效。未信任的 hook 会被 Codex 跳过。详见 [Codex 官方 hooks 文档](https://learn.chatgpt.com/docs/hooks)。

- **进度**：弹出模式和常驻模式都显示本次接入后的实时事件摘要，包括运行命令、修改文件、完成和中断。Codex 对话仍在 Codex 原窗口继续；这里不读取其非稳定格式的历史 transcript，也不使用 Claude 的终端／续聊接口。
- **权限**：卡片显示命令或 `apply_patch` 补丁，提供「允许」「拒绝」「在 Codex 中处理」。Codex 先运行同步权限 hook，未作决定才进入原生审批，因此不承诺两个确认框同时出现。第三个按钮立即交回原生审批；超时、糖糖未运行或连接断开也不自动允许。
- **超时**：权限 hook 配置为 120 秒，脚本最多等待 110 秒，面板最多等待 105 秒；其他 hook 快速返回空 JSON，不添加对话上下文。不要将权限 hook 设成 `async`。
- **验证**：`node --test codex-hook.test.js app/permissions.test.js`。`AME_PORT` 可为 Codex hook 指定本机测试端口（默认 3940）。

## 远程看板（可选）

`remote/` 是一个自托管网页：在手机或别的电脑上查看各台机器的 Claude Code 会话，并可以远程回复、处理权限确认。

```
公网 443 ── Caddy（HTTPS） ── 127.0.0.1:8787  网页 + 登录
                                    │
VPN（如 Tailscale）── <VPN 地址>:8788  agent 入口 ←── 各台机器的 agent ── 本机糖糖（127.0.0.1:3940）
```

### 部署（VPS，公网域名）

1. 装 Node.js、[Caddy](https://caddyserver.com/)、VPN（如 Tailscale）。防火墙只开 22 和 443，SSH 只用密钥登录。
2. 按 [`remote/deploy/ame-remote.service.example`](remote/deploy/ame-remote.service.example) 顶部的步骤建用户、拉代码、`npm ci`，再：
   - `node server/setup.js init`：设置用户名、密码（建议 20 位以上随机串），用验证器 App 扫码绑定 TOTP；
   - `node server/setup.js production your.domain <服务器的 VPN 地址>`：切到 HTTPS 模式，agent 入口只监听 VPN 地址；
   - `node server/setup.js add-agent <机器名>`：每台机器一个令牌（只显示一次）。
3. 把 [`remote/deploy/Caddyfile.example`](remote/deploy/Caddyfile.example) 改好域名放进 `/etc/caddy/Caddyfile`，装好 systemd 服务并启动。
4. 每台机器：复制 `remote/agent/agent.example.json` 为 `agent.json`，`server` 填 `ws://<服务器的 VPN 地址>:8788/agent`，填入令牌，`npm run agent`。

手机丢了：SSH 上服务器运行 `node server/setup.js totp` 重新绑定；忘记密码：`node server/setup.js password`。

### 远程控制

**默认关闭**，需在该机器的 `agent.json` 里设 `"control": true`，且糖糖正在运行。开启后网页可以：

- **回复**：和本机常驻对话面板相同的规则——终端会话直接打进终端；已关闭的会话用 `claude -p --resume` 在后台续上；IDE / 桌面 App 会话只能看；有待确认时回复会被拦下。
- **权限确认**：显示与本机面板相同的卡片（允许 / 拒绝，Codex 另有「在 Codex 中处理」）。

服务器 `config.json` 里设 `"control": false` 可以整体改回只读。

### 安全措施

- **登录前什么都不暴露**：登录页是一个通用的登录框，没有名字、图片；静态素材也要登录后才能拿；带 `noindex`。
- **一步登录**：用户名、密码、验证码一起提交；错在哪里都只回「登录失败」，密码无法单独猜。密码 scrypt 加盐存储，验证码一次一用。
- **防爆破**：同一 IP 15 分钟错 5 次锁 15 分钟；全局 1 小时错 20 次锁 30 分钟。IP 取 Caddy 追加在 `X-Forwarded-For` 最右边的值，伪造这个头绕不过去。想把爆破挡在门外，可在 Caddyfile 里打开 IP 白名单。
- **操作前再验一次**：只看不需要；发回复、批准权限前，需要 10 分钟内输过验证码（登录那次也算）。被偷的 cookie 只能看，不能动。
- **会话**：空闲 8 小时或登录满 24 小时失效；登出后已打开的页面立即断开。HTTPS 下 cookie 为 `__Host-sid`（HttpOnly、Secure、SameSite=Strict），并启用 HSTS。
- **跨站**：所有写请求和 WebSocket 都校验来源；CSP 只允许本站脚本。
- **agent**：只在 VPN 地址上监听，公网入口上没有 `/agent`；机器用 256 位随机令牌认证，服务器只存哈希。
- **本机**：糖糖的控制接口只听 127.0.0.1，要求 `~/.ametyping/control-token-<端口>` 里的随机令牌（每次启动重新生成），并拒绝带 `Origin` 的请求，本机网页无法调用。
- **审计**：登录、验证、每次操作都记入 `audit.log`（机器、会话、字数，不记内容）；每分钟最多 30 次操作。

## 从源码运行 / 打包

```bash
cd app
npm install
npm start                 # 开发运行
npm run dist              # 打包到 ../dist/AmeTyping-win32-x64
npx electron-builder --win portable --prepackaged ../dist/AmeTyping-win32-x64   # 单文件便携版 -> ../release
```

打包前先关掉正在运行的 AmeTyping，否则 `dist` 会覆盖失败。

技术栈：Electron 33（透明无边框窗口）、Canvas 2D 分层绑定（头 / 双马尾 / 躯干 / 表情补丁 / 视线补丁 / 悬浮手），`uiohook-napi` 全局键鼠钩子。

## 授权与声明

- **代码**：MIT License，见 [LICENSE](LICENSE)。
- **角色与素材**：糖糖（超てんちゃん）及《NEEDY GIRL OVERDOSE》相关角色、世界观、Windose 界面风格版权归 WSS playground / xemono（にゃるら）所有。本项目是非官方、非商业的同人作品；`app/assets/` 下的立绘、手、键帽等为 AI 辅助绘制的二次创作，对话框底图与音效来自或参照原作。**素材仅限非商业用途**，不适用 MIT 授权。
- **字体**：PixelMplus12（M+ FONT LICENSE）。
