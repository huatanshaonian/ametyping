# AmeTyping · 糖糖敲键盘桌宠 + Windose 远程桌面

A Bongo-Cat–style desktop pet for Windows — Ame (糖糖 / 超てんちゃん) from *NEEDY GIRL OVERDOSE* types along with you — plus an optional self-hosted, Win98-styled web desktop to watch and drive your Claude Code / Codex sessions on every machine you own.

这个仓库有两部分，可以只用第一部分：

1. **糖糖桌宠（Windows）**：Q 版糖糖坐在 75% 键盘后面，你按哪个键她就敲哪个键；可选接入 Claude Code / Codex，在她下面的 Windose 风格面板里看各会话的进度、处理权限确认、直接回复。
2. **Windose 远程桌面（自托管网页）**：在手机或别的电脑上打开一个 Win98 风格的桌面，看每台机器上的会话、完整对话（长期存档）、浏览文件（Markdown 连同里面的图片）、远程回复 / 审批 / 在指定文件夹启动 Claude。Linux 机器用无头服务代替糖糖。

## 糖糖桌宠

到 [Releases](../../releases) 下载 `AmeTyping-portable.exe` 双击运行（单文件便携版，首次启动要解压，会慢几秒）。

- **跟着你打字**：全局键盘钩子，按键映射到 GravaStar 75% 配列上的对应键；双手按指法分区，组合键会一只手按住修饰键。
- **表情与小动作**：打字速度、退格、回车、空闲都会改变表情；空闲时眼睛跟着鼠标，偶尔打哈欠、喝茶，久了会睡着。点她一下会脸红，**双击打开 Windose 网页**。
- **v0.2 新增（来自上游）**：完整跪坐身体（键盘放在腿上）、前发单独摆动、摸头（鼠标在头顶来回划）、深夜犯困 / 久别招手 / 连续工作 90 分钟劝休息（托盘可关）、敲 `kangel` 变身超天酱（托盘可常驻）、面板可折叠成 P 酱（点 P 酱展开）。托盘「调试信息」会显示当前表情和触发原因。
- **窗口**：透明区域逐像素鼠标穿透；拖动本体移动，拖右下角缩放；托盘菜单：大小、朝向、键帽主题、面板模式、提示音、允许远程控制、休息提醒、天使模式、鼠标穿透、开机自启。
- **隐私**：键盘钩子只读取键码（哪个物理键），不记录、不上传输入的文字；面板只监听本机 `127.0.0.1:3940`。

### Claude Code / Codex 面板

Claude Code 与 Codex 的 hook 把会话事件发给糖糖，她下面的面板显示会话列表与进度：

- **面板模式**（托盘）：弹出进度（有动静时弹出、停下后收起）／常驻对话（完整对话 + 回复框）／关闭（只在 Windose 网页里看）。
- **权限确认卡片**：显示工具、目录、命令或文件与完整参数，「允许」「拒绝」（Codex 另有「在 Codex 中处理」）。Claude Code 在等待卡片的同时终端里也会问，任意一边回答即可；卡片最多等约 60 分钟，超时交回终端。
- **回复**：会话在终端里就直接打进终端（`WriteConsoleInput`，不抢焦点）；会话已关闭则用 `claude -p --resume` 后台续上；IDE / 桌面 App 里的会话只能看；有待确认时回复会被拦下。

安装 hook：`node headless/install-hooks.js`（合并进 `~/.claude/settings.json`，原文件先备份，`--remove` 可移除）；Codex：`node install-codex-hooks.js`，再在 Codex 里用 `/hooks` 信任。一键部署脚本（见下）会自动做这些。

## Windose 远程桌面

```
手机 / 电脑浏览器 ──(Tailscale)──> 群晖 DSM 反向代理 443 ──> Node 看板 127.0.0.1:8787（网页、登录、对话存档）
                                                             127.0.0.1:8788 agent 入口 <──(Tailscale)── 各台机器的 agent
每台机器：agent ── 127.0.0.1:3940 ── 糖糖（Windows）或无头服务（Linux）── Claude Code / Codex hooks
```

看板只在 Tailscale 网络内可达，公网上没有入口。群晖上的 Tailscale 是用户态模式：tailnet 里访问 `100.x:端口` 会被转到群晖本机的 `127.0.0.1:端口`，所以服务只监听本机就够了。

### 能做什么

- **桌面**：左边是当前电脑的桌面（壁纸、图标），右边「网上邻居」列出每台电脑的在线状态、会话数、待确认；底部任务栏、开始菜单、托盘音量。窗口可拖动、四边缩放、最大化；手机上窗口自动全屏。
- **糖糖看板**（窗口应用）：所有电脑的会话，按最后活动时间倒序；Claude Code 退出后会话仍保留为「历史」，并给出继续命令（`claude --resume` / `codex resume`，带正确的目录）。
- **对话存档**：agent 按字节偏移把新增内容以精简格式（你说的话和回复全文、工具调用一行描述，不含工具输出）发到服务器，按 `日期/机器/会话.jsonl` 写盘；重启、断线都不会丢或重复。Codex 会话同样存档。
- **远程回复与审批**：回复打进那台机器的终端；回复框为空时方向键 / 回车 / Esc / Tab 直接发给终端，用来操作 `/model`、`/resume` 这类菜单（触屏上显示按键条）。
- **我的电脑**：只读浏览允许的目录（Windows 默认除 C 盘外所有盘），图片、文本（UTF-8 / GB18030）、Markdown（相对路径图片从同一文件夹取回显示）；单文件上限 100 MB，分块传输，服务器只转发不保存。
- **在这里启动 Claude**：在文件夹里新开 Claude Code 会话——Linux 在 tmux 里（可 `tmux attach` 接手），Windows 弹出一个命令行窗口；新文件夹的「是否信任」提示自动确认。
- **添加电脑**：网页里输入名字即生成令牌（只显示一次），并给出新设备上直接粘贴运行的安装命令；也可移除（令牌作废并断开）。
- **显示属性 / 声音**：内置壁纸、本地图片（只存在浏览器）、从网址下载（由服务器下载保存，所有设备可选）；填充 / 适应 / 拉伸 / 居中 / 平铺；Win98 系统音效（启动、注销、待确认、完成、失败），可逐个关闭。

### 部署服务器（群晖 NAS）

程序放在 `/volume2/docker/ame-remote`（`remote/` 与 `app/assets` 的一部分），用群晖套件中心的 Node.js 22：

1. `node remote/server/setup.js init`：设置用户名、密码，用验证器 App 扫码绑定 TOTP（在你自己的终端里运行）。
2. `node remote/server/setup.js production <域名> 127.0.0.1`：切到 HTTPS 模式（cookie 安全属性、信任反向代理），agent 入口只听本机。
3. DSM 控制面板 → 登录门户 → 反向代理：`https://<域名>:443` → `http://127.0.0.1:8787`，自定义标头加 WebSocket。
4. 证书：[`remote/deploy/nas/renew-cert.sh`](remote/deploy/nas/renew-cert.sh)（acme.sh + Cloudflare DNS 验证，推送进 DSM）；首次用 root 运行 `renew-cert.sh deploy`，之后在 DSM 任务计划里以 root 每周运行一次。
5. 开机自启：[`remote/deploy/nas/run.sh`](remote/deploy/nas/run.sh) `start|stop|restart|status`；DSM 任务计划加一个「开机」触发的任务运行 `run.sh start`（守护循环，崩溃自动拉起）。
6. 域名解析到群晖的 Tailscale 地址（灰云，仅 DNS）。

忘记密码：`setup.js password`；换手机：`setup.js totp`（之后重启服务）。

### 部署到每台电脑

新设备先加入 Tailscale，然后在 Windose 网页里「添加电脑」得到令牌和安装命令，粘贴运行即可。也可以直接运行脚本，按提示填写：

```powershell
# Windows：糖糖 + agent + hooks + 登录自启（计划任务）
iex (irm https://raw.githubusercontent.com/huatanshaonian/ametyping/main/install/install-windows.ps1).TrimStart([char]0xFEFF)
```

```bash
# Linux：无头服务 + agent + hooks + systemd 用户服务
curl -fsSL https://raw.githubusercontent.com/huatanshaonian/ametyping/main/install/install-linux.sh | bash
```

脚本可重复运行；环境变量 `AME_NAME`、`AME_TOKEN`、`AME_CONTROL`、`AME_FILES` 等可代替提问（见脚本开头）。agent 配置在 `remote/agent/agent.json`（示例 [`agent.example.json`](remote/agent/agent.example.json)）：`control` 是否允许远程控制，`files` 允许浏览的目录。Linux 上 `~/.ametyping/launch.sh` 是从网页启动 Claude 前执行的命令（例如设代理）。

Linux 无头服务（[`headless/`](headless)）提供和糖糖相同的本机接口：权限卡片、tmux 里的会话回复与按键、`claude -p --resume` 后台续聊、在文件夹启动 Claude。要从网页回复，claude 需要跑在 tmux 里。

### 安全

- **只在 Tailscale 内**：看板和 agent 入口都只监听群晖本机，经 Tailscale 转发；公网没有入口。
- **登录**：用户名 + 密码 + 验证码一次提交，错在哪里都只回「登录失败」；密码 scrypt 加盐，验证码一次一用；连错会锁定。
- **操作前再验一次**：只看不需要；回复、审批、按键、启动 Claude、添加 / 移除电脑前需要 1 小时内输过验证码。被偷的 cookie 只能看。
- **远程控制可逐台关闭**：`agent.json` 的 `control`，以及糖糖托盘的「允许远程控制」；服务器 `config.json` 设 `"control": false` 可整体只读。
- **文件浏览**：只读，路径先解析为真实路径再判断是否在允许的目录内（`..`、符号链接绕不出去）；密钥类文件（`.ssh`、`.env*`、`*.pem`、`agent.json` 等）不列出也不能读。
- **页面**：CSP 只允许本站；Markdown 经 DOMPurify 过滤，外链图片不加载；壁纸下载由服务器做且拒绝内网地址。
- **本机接口**：糖糖 / 无头服务只听 `127.0.0.1`，要求 `~/.ametyping/control-token-<端口>` 里每次启动重新生成的令牌，并拒绝带 `Origin` 的请求。
- **审计**：登录、验证、每次操作、文件读取、令牌增删都记入 `audit.log`（不记内容）。

## 从源码运行 / 打包

```bash
cd app && npm install && npm start            # 糖糖开发运行
npm run dist                                  # 打包到 ../dist/AmeTyping-win32-x64
cd remote && npm ci && npm run agent          # agent（需要 agent.json）
node --test codex-hook.test.js app/permissions.test.js   # 单元测试
```

国内网络装 Electron 时设 `ELECTRON_GET_USE_PROXY=1`（让它的下载走 `HTTPS_PROXY`）。端到端测试脚本不入库（`remote/test/`）。

技术栈：Electron 33、Canvas 2D 分层绑定、`uiohook-napi`；看板为 Node（`ws`）+ 原生 ES modules，Markdown 渲染用本地的 marked 与 DOMPurify。

## 授权与声明

- **代码**：MIT License，见 [LICENSE](LICENSE)。
- **角色与素材**：糖糖（超てんちゃん）及《NEEDY GIRL OVERDOSE》相关角色、世界观、Windose 界面风格版权归 WSS playground / xemono（にゃるら）所有。本项目是非官方、非商业的同人作品；`app/assets/` 下的立绘、手、键帽等为 AI 辅助绘制的二次创作，窗框、对话框底图、音效与 P 酱像素猫头来自或参照原作；超天酱形态为参照同人插画重绘的二次创作；壁纸插画为游戏收录的粉丝投稿，以画师 handle 署名。Windows 98 图标与系统音效版权归 Microsoft。**素材仅限非商业用途**，不适用 MIT 授权。
- **字体**：PixelMplus12（M+ FONT LICENSE）。
