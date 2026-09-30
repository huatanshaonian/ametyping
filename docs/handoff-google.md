# 交接：Windose 的 Google 衔接（日历 / 云端硬盘）

写给接手这块工作的新对话。先通读本文，再动代码。

## 1. 背景

AmeTyping 仓库有两部分：Windows 桌宠「糖糖」（`app/`，Electron）与自托管的 Win98 风格网页桌面「Windose」（`remote/`）。

- **服务器**：Windose 的服务器跑在用户的群晖 NAS 上，只在 Tailscale 内网可达，域名 `https://win98.huatan.org`（DSM 反向代理 → Node `127.0.0.1:8787`）。
- **agent**：每台电脑上的 agent 把 Claude Code / Codex 的对话存档到群晖。
- **日报**：群晖每天凌晨用 Codex（`gpt-6-luna`）写工作日报。另有周报、重要计划（待办）、记事本、日历、全文搜索与「问一问」。

Google 衔接的目标（用户已确认的需求）：

1. **日报写进 Google 日历**：每天的正式日报写成 Google 日历上当天的全天事件，当作「日记」，手机上翻日历就能看到每天做了什么。
2. **Windose 的日历窗口显示 Google 日历上的日程**。
3. **笔记转存云端硬盘**：记事本的笔记可以「转存到 Google 云端硬盘」。只转存，不做双向同步。Google Keep 个人账号没有官方 API，已放弃。
4. **Google 生态**：用户用 Google 个人账号，手机一直开代理，电脑用 Chrome。

## 2. 现状：代码已完成，但从未连过真的 Google

以下都已实现、提交（`main` 分支），并部署到群晖，但只用「假 Google」测过。用户还没在 Google Cloud 建授权客户端，所以真实账号的流程一次也没跑过。

### 服务器 `remote/server/google/`

- **`http.js`**：经 HTTP 代理访问 Google。
  - 在 HTTP 代理上先建 `CONNECT` 隧道，再做 TLS，请求走这条连接。
  - 用哪个代理由 `server/egress.js` 挑选：按 `config.json` 的 `summary.proxies` 顺序逐个探测，先用户电脑上的 v2rayN，不通再用 AWS 备用线路 `127.0.0.1:1057`。
  - 没配代理就直连。
- **`account.js`**：用户自己的 OAuth 客户端（类型为「Web 应用」）。
  - **存储**：客户端 ID / 密钥、refresh token、账号邮箱存在 `data/google.json`，权限 600；接口不返回密钥和令牌。
  - **权限范围**：只申请 `openid email calendar.events drive.file`。
  - **令牌续期**：access token 到期自动续期；刷新遇到 `invalid_grant` 时清掉令牌，并提示「重新连接」。
  - **断开**：会向 Google 撤销授权。
  - **授权回调**：`authUrl()` 生成一次性的 `state`，只存在服务器内存里，10 分钟有效；`callback()` 用它校验。
- **`calendar.js`**：
  - `diary(report)`：把正式日报写成全天事件，内容如下：
    - 标题「日报：…」，标为空闲（`transparency: transparent`）；
    - 描述里有项目、杂活数、完成的重要计划，以及回到 Windose 的链接 `<origin>/#report=<日期>`；
    - 用私有扩展属性 `ameReport=<日期>` 找回事件，重新生成时 PATCH 更新同一个事件；
    - 草稿不写。
  - `events(from, to)`：读 primary 日历的事件，缓存 5 分钟。
- **`drive.js`**：`saveNote(note)` 把笔记存成「Windose 记事本」文件夹里的 txt。
  - 文件夹首次使用时创建，ID 记在 `google.json` 的 `driveFolder`。
  - 再次转存时更新同一个文件；文件 ID 由 `notes.setDrive` 记在笔记索引里。
- **`index.js`**：路由与对外接口。
  - `GET /api/google`：账号状态。
  - `POST /api/google/client | connect | disconnect | diary`：这四个需要 1 小时内输过验证码，否则返回 `{need:'totp'}`，前端 `net.post()` 会自动弹出验证码框。
  - `POST /api/google/drive-note {id}`：转存笔记。
  - `GET /api/google/callback`：放在登录检查之前（见下文「坑」），由 `server.js` 直接转交 `handleCallback`。
  - `onReport(report)`：正式日报生成后由服务器调用，写日记事件。
  - `events()`：供日历视图使用。

### 服务器其他相关

- **`server/calendar.js`**：`GET /api/calendar?month=YYYY-MM`，返回每天的日报概括、到期的重要计划、Google 日程。带 `ameReport` 的日记事件不重复显示。
- **`server/server.js` 的接线**：
  - 用 `createGoogle({ dataDir, origin: cfg.origin, notes, egress, audit })` 创建；
  - 日报的 `onNote` 回调里调用 `google.onReport(summary.reports.get(n.date))`；
  - 路由转发。
  - 搜 `google` 即可找到这几处。

### 网页 `remote/public/`

- **`js/apps/google.js`**：「Google 账户」窗口，从开始菜单打开。
  - 包含设置步骤、需在 Google Cloud 填的重定向地址、客户端表单、连接 / 断开、「日报写进 Google 日历」开关。
  - `status()` / `onStatus()` 供其他窗口判断是否已连接。
- **`js/apps/calendar.js`** 与 **`css/calendar.css`**：日历窗口，按月显示，点某天在右侧看详情。
- **`js/apps/notepad.js`**：「转存到 Google 云端硬盘」按钮，按连接状态启用。
- **`js/main.js`**：从 Google 回来时地址带 `#google=ok|fail`，据此自动打开账户窗口并提示结果。

### 测试（`remote/test/`，按用户规则不入 git）

- **`e2e-google.js`**（20 项）：搭一个假的 Google 跑全流程。
  - **原理**：用 openssl 生成自签证书起 HTTPS 服务，再加一个假的 CONNECT 代理，把所有隧道转到它；测试里的服务器进程设 `NODE_TLS_REJECT_UNAUTHORIZED=0`。
  - **覆盖范围**：
    - 客户端校验、授权地址与权限范围；
    - 不带 cookie 的回调；伪造和重放 `state` 被拒；
    - 流量经代理；密钥不外露；
    - 定时日报写成日记事件，重写时只更新不新增；
    - 日历月视图合并；
    - 笔记转存，再次转存时更新同一文件；
    - 令牌续期、授权失效提示、断开。
- **`ui-reports.js`**：包含日历窗口与账户窗口的截图检查，截图在 `test/out/shots/`。
- **运行方式**：
  - 全部端到端：在 `remote/` 下运行 `node test/run.js`；
  - 单个：`node test/e2e-google.js`；
  - `ui-*.js` 需要本机 Chrome。

## 3. 必须知道的坑

- **登录 cookie 是 `SameSite=Strict`**：从 `accounts.google.com` 跳回时浏览器不带它，所以：
  - 回调路由必须在登录检查之前；
  - 成功后返回一个带 `meta refresh` 的小页面再跳回 `/`，这一跳由本站发起，会带 cookie。直接 302 回 `/` 会被当成未登录。
- **群晖在国内**：访问 Google 必须走代理，用 `egress` 的 `pick(host)`，不要直连。代理不通时要给用户清楚的错误。
- **OAuth 同意屏幕要发布为正式版**：
  - 「测试」状态下，敏感权限（`calendar.events`）的 refresh token 7 天就失效；
  - 正式版未经验证只会多一个「未验证应用」警告页，用户点「继续」即可。账户窗口里的步骤已经写了这一点。
- **重定向 URI**：取自 `config.json` 的 `origin`（群晖上是 `https://win98.huatan.org`），完整地址是 `https://win98.huatan.org/api/google/callback`。该域名只在 Tailscale 内可达，但 Google 只是让浏览器跳过去，不受影响。
- **验证码**：改动账户需要 1 小时内输过验证码（`auth.isFresh(sess)`）。
- **没有正式日报就没有日记事件**：日记事件只在「正式日报生成后」写入，由服务器的 `onNote` 回调触发，每天早上 4:30 以后、各电脑安静 30 分钟才会生成。以下都不会写：
  - 草稿（「总结到现在」）；
  - 补录的旧日报（`brief: true`）。
- **日历事件一律带私有扩展属性 `ameReport`**：这样重写时能找回原事件，日历视图也能区分出哪些是日记。

## 4. 接下来要做的

1. **陪用户完成 Google Cloud 设置**：
   - 新建项目，启用 Calendar API 与 Drive API；
   - OAuth 同意屏幕选「外部」，并发布为正式版；
   - 创建凭据，类型「Web 应用」，重定向 URI 填 `https://win98.huatan.org/api/google/callback`；
   - 在 Windose「Google 账户」窗口里填客户端 ID 和密钥，然后点「连接」。
2. **用真账号逐项验证，出了问题就修**：
   - 授权往返；
   - 「日报写进日历」：可以等第二天早上，也可以想办法手动触发一次，比如加一个「把某天日报写进日历」的操作；
   - 日历窗口显示日程；
   - 笔记转存。
   - 另外看群晖 `remote/server/server.log` 里有没有 `Google 日历写入失败`。
3. **可选改进**（先问用户要不要）：
   - **补写旧日报**：给补录的旧日报和连上之前的日报补写日记事件，比如在账户窗口加一个「把过去的日报补进日历」按钮。
   - **周报**：写成周日的一个全天事件，或者写进那一周。
   - **早安气泡**：糖糖的早安气泡加上「今天有 N 个日程」，这是原设计里提到过的。
     - 数据要从服务器经 agent 传给糖糖（`app/morning.js`）；
     - 通知的格式见 `remote/server/summary/index.js` 的 `latestNote()`。
   - **日记写入失败要让用户看得到**：现在只写日志，可以在账户窗口显示「最近一次写入：成功 / 失败原因」。
   - **重要计划的截止日期同步**：写进 Google 日历，或者 Google Tasks（需要多申请一个 `tasks` 权限，要先征得用户同意）。

## 5. 分工与协作（两个对话并行）

- **目录分开**：本对话在独立的 git worktree 里工作，目录是 `D:\ametyping-google`，分支是 `feature/google`，从 `main` 开出。另一个对话在 `D:\ametyping`（`main`）上做「对话管理」相关的功能，两边尽量不改同一批文件。
- **本对话负责的文件**：
  - `remote/server/google/*`
  - `remote/server/calendar.js`
  - `remote/public/js/apps/google.js`
  - `remote/public/js/apps/calendar.js`
  - `remote/public/css/calendar.css`
- **公用文件要小心**，只做必要的小改动，并在提交说明里写清楚：
  - `remote/server/server.js`
  - `remote/public/js/main.js`
  - `remote/public/index.html`
  - `remote/public/js/apps/notepad.js`
  - `remote/server/summary/*`
  - `app/*`
- **测试文件不入 git**：新 worktree 里不会自带测试文件。已经从 `D:\ametyping\remote\test` 复制过来；以后两边的测试各自维护。
- **部署**：群晖只有一套。部署前先把 `feature/google` 合并到 `main`，或者先和另一个对话约好。不要把一个分支的旧文件覆盖到群晖上，把对方的改动冲掉。
- **完成后**：把 `feature/google` 合并回 `main`，有冲突就按双方的意图合并。

## 6. 环境与部署

- **SSH 别名**：
  - `ssh nas-ts`：群晖，经 Tailscale；
  - `ssh dell97`：Linux 机器；
  - `ssh aws1`：AWS 东京，是群晖的备用出网线路。
- **群晖上的程序目录**：`/volume2/docker/ame-remote/`。
  - 看板服务：`sh /volume2/docker/ame-remote/run.sh restart`（用绝对路径调用）。重启后网页需要重新登录。
  - 备用出网：`egress.sh start|status`，用户已在 DSM 设了开机启动。
  - 配置：`remote/server/config.json`，其中 `origin` 和 `summary.proxies` 与 Google 有关。
  - 数据目录：`remote/server/data/`，里面有 `google.json`、`reports/`、`notes/`、`todos.json`。
- **部署方式**：用 tar 打包需要的文件，经 ssh 在群晖的程序目录里解开，例如：
  `tar -cf - remote/server/google remote/public/js | ssh nas-ts 'cd /volume2/docker/ame-remote && tar -xf -'`
  - 只改网页文件不用重启；
  - 改了服务器代码要执行 `run.sh restart`。
- **群晖 Node**：`/var/packages/Node.js_v22/target/usr/local/bin/node`。
- **网页登录**：需要验证码，只有用户手里有，测试真实网页要请用户操作。

## 7. 用户的规则（摘自 CLAUDE.md，必须遵守）

- 提交说明要详细。修 bug 要写清原因和修法，概括要言简意赅，方便以后回溯。
- 不要把太多代码堆进同一个文件，不同功能分到合适的文件里。
- 测试文件不进 git，不推送到 GitHub（`remote/test/` 已被 .gitignore 忽略）。
- 除非用户要求，不要写 md 文档。本文档是用户要求写的。
- 提交说明末尾加上：`Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`。
- 用户目前使用手动审批模式：每个工具调用都要用户批准，所以要讲清楚每一步在做什么。
- 用简体中文和用户交流。
