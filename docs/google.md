# Google 衔接：现状与待办

2026-10-02 起已用真账号跑通，代码在 `main`，并已部署到群晖。

## 1. 现有功能

| 功能 | 说明 | 文件 |
|---|---|---|
| 账号 | 用户自己的 OAuth 客户端（Web 应用），经代理访问 Google；缺少新权限时提示重新授权 | `server/google/account.js`、`http.js` |
| 日报 / 周报进日历 | 写进单独的「Windose 日报」日历（全天、空闲、只放摘要和回 Windose 的链接）；周报放在周日 | `server/google/calendar.js` |
| 补写 | 账户窗口按钮：把所有日报和周报补进日历，重复运行不会重复写 | `server/google/backfill.js` |
| 失败重试 | 写入失败或授权失效时记下来，每小时重试一次，重新连上后也立即重试 | `server/google/retry.js` |
| 日历窗口 | 显示主日历的日程，以及其他列表里的 Google 任务；打开、刷新、切回页面时重新读取 | `server/calendar.js`、`public/js/apps/calendar.js` |
| 重要计划 ↔ Google 任务 | 双向同步到「Windose 重要计划」列表 | `server/google/tasks.js`、`tasks-sync.js` |
| 日报参考日程 | 写日报前先同步任务，再把当天日程作为背景交给模型 | `server/google/index.js` forReport、`summary/prompts.js` |
| 早安气泡 | 糖糖的气泡显示今天的日程和到期事项 | `server/google/index.js` agenda、`app/morning*.js` |
| 笔记转存 | 记事本转存到云端硬盘的「Windose 记事本」文件夹 | `server/google/drive.js` |
| 托盘提醒 | 授权失效、有待重试的写入、同步失败时，托盘出现⚠ | `public/js/apps/google.js` |
| 每日备份 | 每天 05:30 把 `config.json` 和整个 data 打包到 `/volume1/homes/huatanshaonian/ame-backup/`，全部保留（与 Google 无关，同期完成） | `server/backup.js` |

权限：`openid email calendar.events drive.file tasks calendar.app.created`。

## 2. 待验证

这几项测试已通过，但还没在真实环境里自然发生过：

- 每天 4:30 后自动生成的日报写进日历，并带上当天日程。
- 05:30 的自动备份。
- 更新糖糖后，第一个早上的气泡显示今日安排。
- 周一早上，周报写成周日的全天事件。
- 出故障时：托盘⚠和自动重试。

## 3. 先不做的（用户已确认，以后需要再做）

- **工作时间块**：按对话记录，把每天的工作写成「工作记录」日历里的时间块。
  - 局限：只覆盖用 AI 助手做的工作，日报里也已有各项目的时长。
- **Google 表格工时表**：每天追加一行统计。价值一般，原因同上。
- **Google 文档周报导出**：Windose 已能渲染 Markdown；用户考虑把日报改成 Markdown 格式。
- **带具体时间的重要计划**：Google Tasks 的接口只存日期。
  - 需要时间点时，可以另外建一个带提醒的日历活动。
- **读取主日历以外的日历**：需要多申请 `calendar.calendarlist.readonly` 权限。
- **隐私政策页 `/privacy`**：Google 品牌设置里填了这个地址，但页面不存在。不影响使用（未提交审核）。
- **Gmail 推送提醒**：留到做邮件功能时一起考虑（见 `docs/plan-mail.md`）。
- **云端硬盘异地备份**：目前只在群晖的另一块盘上备份；以后需要时再加。

## 4. 坑

- **登录 cookie 是 `SameSite=Strict`**：Google 跳回时浏览器不会带上它。所以：
  - 回调路由要放在登录检查之前；
  - 返回一个带 meta refresh 的小页面再跳回首页，不能直接 302。
- **经代理访问 Google**：
  - `http.js` 自己建 CONNECT 隧道，必须显式传 `port: 443` 和 `defaultPort: 443`。否则 Host 头会带上 `:80`，Google 回 404 `invalid_request`。
  - 用哪个代理由 `egress.pick()` 挑选。
- **OAuth 同意屏幕**：
  - 必须发布为正式版，否则授权 7 天就失效；
  - 不要上传徽标，否则必须先通过品牌验证；
  - 已获授权的网域填 `huatan.org`。
- **Google Tasks**：
  - `due` 只保留日期；
  - 在手机 App 里勾掉的任务会被标为隐藏，读取时要带 `showHidden=true`。
- **两个对话共用 `server/server.js`**：部署前先和群晖上的版本对比，不要用某个分支的旧文件直接覆盖。
