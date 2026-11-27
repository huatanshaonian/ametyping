# AmeTyping 全仓代码静态审计基线报告 (`00-codebase-audit.md`)

> 由确定性静态 AST/Token 扫描器 `node tools/audit-codebase.js` 生成（排除 `node_modules`、`vendor`、`remote/test` 及 `*.test.js` 业务噪声；单测仅用于辅助区分「纯死代码」与「仅单测引用导出」）。

## 全局概览指标

| 指标维度 | 数值 | 说明 |
| --- | ---: | --- |
| 生产 JS/MJS 文件数 | 450 | 扫描总行数 74,558 行，提取具名/回调块函数 7,854 个 |
| 测试 JS 文件数（参照集） | 181 | 含 `remote/test/**` 与根目录/`app/*.test.js` |
| 跨文件重复/近似函数簇 | 109 | Exact-AST 归一化克隆 106 簇 + Near-Clone 结构克隆 3 簇 |
| `renameSync` 原子写盘散落点 | 82 | 跨 68 个生产文件重复实现写临时文件再 rename |
| 导出符号总数 (CJS + ESM) | 1334 | CJS `module.exports` 926 个 + ESM `export` 408 个 |
| 零外部生产引用导出符号 | 221 | 其中纯零引用（连测试也未引用）138 个，仅单测引用 83 个 |
| 超长文件（>500 行） | 22 | JS 21 个 / CSS 1 个 / HTML 0 个 |
| 超长函数（>80 行） | 67 | 最大单函数 251 行 (app/remote-control.js) |
| CSS + `bubble.html` `#hex` 色值 | 841 | 业务规则硬编码 **698** 处 + `--*` 变量定义 143 处（去重后 288 种色值） |

---

## 1. 跨文件相似/重复函数聚类与高频重复模式

### 1.1 归一化函数块指纹聚类（Top 重复簇）

| # | 级别 | 指纹 | 出现次数 | 均行 | 代表函数名 | 分布位置（文件:起止行） |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 1 | Near-Clone | `8776f6929131` | 2 | 14 | `greet` | `app/agy-cli.js:L20-L33` (greet)<br>`app/kiro-cli.js:L20-L33` (greet) |
| 2 | Exact-AST | `0e5953012d88` | 2 | 10 | `loadSqlite` | `remote/server/embed/store.js:L14-L23` (loadSqlite)<br>`remote/server/literature/kb-struct.js:L10-L19` (loadSqlite) |
| 3 | Near-Clone | `f562b379a922` | 2 | 9 | `code` | `remote/public/js/apps/mcp-panel.js:L16-L24` (code)<br>`remote/public/js/apps/opencode-guide.js:L12-L20` (code) |
| 4 | Exact-AST | `94c701efc9a3` | 16 | 1 | `day, full, ymd` | `remote/public/js/apps/lit-review.js:L12-L12` (day)<br>`remote/public/js/apps/mail.js:L26-L26` (full)<br>`remote/server/google/index.js:L62-L62` (ymd)<br>`remote/server/google/index.js:L99-L99` (ymd)<br>`remote/server/literature/absjob.js:L11-L11` (ymd)<br>`remote/server/literature/feed.js:L56-L56` (ymd)<br>`remote/server/literature/pdfqueue.js:L16-L16` (ymd)<br>`remote/server/literature/review.js:L21-L21` (ymd)<br>`remote/server/literature/stats.js:L9-L9` (ymd)<br>`remote/server/mail/compose.js:L22-L22` (when)<br>`remote/server/mail/store.js:L14-L14` (monthOf)<br>`remote/server/mail/triage-prompt.js:L19-L19` (ymd)<br>`remote/server/session-export.js:L9-L9` (ymd)<br>`remote/server/session-export.js:L11-L11` (dayTitle)<br>`remote/server/summary/scheduler.js:L8-L8` (dayOf)<br>`remote/server/summary/weekly.js:L17-L17` (dayOf) |
| 5 | Exact-AST | `0f2a4c1d87eb` | 2 | 8 | `loadCliUpdates, loadMachineProfiles` | `remote/server/mesh.js:L1025-L1032` (loadCliUpdates)<br>`remote/server/mesh.js:L1069-L1076` (loadMachineProfiles) |
| 6 | Exact-AST | `1b5387ef77bd` | 2 | 8 | `post, postFleet` | `remote/public/js/apps/fleet-panel.js:L17-L24` (post)<br>`remote/public/js/apps/mcp-panel.js:L8-L15` (postFleet) |
| 7 | Near-Clone | `543560d91918` | 2 | 8 | `pngOf` | `remote/server/board/index.js:L23-L30` (pngOf)<br>`remote/server/literature/notes.js:L28-L35` (pngOf) |
| 8 | Exact-AST | `e1bc8d4e6a69` | 2 | 8 | `save` | `remote/server/fs-catalog.js:L64-L71` (save)<br>`remote/server/mesh.js:L558-L565` (save) |
| 9 | Exact-AST | `13e9fa09278d` | 2 | 7 | `replyVia, via` | `app/main-sessions.js:L77-L83` (replyVia)<br>`headless/sessions-win.js:L33-L39` (via) |
| 10 | Exact-AST | `227628cdc4e1` | 2 | 7 | `<anonymous>` | `remote/server/google/http.js:L11-L17` (<anonymous>)<br>`remote/server/literature/http.js:L15-L21` (<anonymous>) |
| 11 | Exact-AST | `45f9084f83fc` | 2 | 7 | `onData` | `remote/server/google/http.js:L19-L25` (onData)<br>`remote/server/literature/http.js:L23-L29` (onData) |
| 12 | Exact-AST | `7c8c4ebe610c` | 2 | 7 | `normKey` | `remote/public/js/fs-catalog.js:L8-L13` (normKey)<br>`remote/server/fs-catalog.js:L20-L26` (normKey) |
| 13 | Exact-AST | `5978c0baa44f` | 12 | 1 | `obj` | `remote/server/literature/prompts/card.js:L10-L10` (obj)<br>`remote/server/literature/prompts/feed.js:L7-L7` (obj)<br>`remote/server/literature/prompts/figures.js:L8-L8` (obj)<br>`remote/server/literature/prompts/profile.js:L13-L13` (obj)<br>`remote/server/literature/prompts/reader.js:L10-L10` (obj)<br>`remote/server/literature/prompts/review.js:L8-L8` (obj)<br>`remote/server/literature/prompts/translate.js:L6-L6` (obj)<br>`remote/server/literature/prompts/vision.js:L6-L6` (obj)<br>`remote/server/mail/triage-prompt.js:L7-L7` (obj)<br>`remote/server/summary/prompts.js:L7-L7` (obj)<br>`remote/server/summary/qa.js:L8-L8` (obj)<br>`remote/server/summary/weekly.js:L9-L9` (obj) |
| 14 | Exact-AST | `33d8ee050d2b` | 2 | 6 | `pick, <addEventListener:click>` | `app/bubble.js:L208-L213` (pick)<br>`remote/public/js/apps/dash-ask.js:L39-L44` (<addEventListener:click>) |
| 15 | Exact-AST | `448f835786b2` | 10 | 1 | `when, day, fmtTime` | `remote/public/js/apps/ai-cli.js:L8-L8` (when)<br>`remote/public/js/apps/google.js:L99-L99` (when)<br>`remote/public/js/apps/lit-notes.js:L16-L16` (day)<br>`remote/public/js/apps/mail-accounts.js:L18-L18` (when)<br>`remote/public/js/apps/notepad.js:L12-L12` (when)<br>`remote/public/js/apps/notify.js:L7-L7` (when)<br>`remote/public/js/apps/report-search.js:L9-L9` (when)<br>`remote/public/js/apps/report-view.js:L11-L11` (when)<br>`remote/server/summary/prompts.js:L26-L26` (fmtTime)<br>`remote/server/summary/qa.js:L12-L12` (fmt) |
| 16 | Exact-AST | `4623a925dd06` | 2 | 5 | `md` | `app/bubble.js:L381-L385` (md)<br>`remote/public/js/apps/dashboard.js:L493-L497` (md) |
| 17 | Exact-AST | `96275d68eeda` | 2 | 5 | `<addEventListener:input>` | `app/bubble.js:L217-L221` (<addEventListener:input>)<br>`remote/public/js/apps/dash-ask.js:L47-L51` (<addEventListener:input>) |
| 18 | Exact-AST | `e71896043bf1` | 2 | 5 | `sessionLabel, label` | `app/main-sessions.js:L56-L60` (sessionLabel)<br>`headless/sessions.js:L82-L86` (label) |
| 19 | Exact-AST | `ea4efbd14cd0` | 2 | 5 | `<anonymous>` | `app/opencode.js:L58-L62` (<anonymous>)<br>`opencode-plugin/index.js:L217-L221` (<anonymous>) |
| 20 | Exact-AST | `00b320962c2e` | 4 | 2 | `pidAlive, alive` | `app/main-sessions.js:L30-L30` (pidAlive)<br>`app/opencode.js:L29-L31` (alive)<br>`headless/ame-headless-win.js:L52-L52` (pidAlive)<br>`remote/agent/session-scanner.js:L22-L22` (pidAlive) |
| 21 | Exact-AST | `43e9159d7dd7` | 4 | 2 | `<anonymous>` | `tools/run-cards-batch.js:L107-L107` (<anonymous>)<br>`tools/run-cards-via-agy.js:L242-L242` (<anonymous>)<br>`tools/run-full-kb-batch.js:L118-L121` (<anonymous>)<br>`tools/run-teams-batch.js:L76-L76` (<anonymous>) |
| 22 | Exact-AST | `07e178255214` | 2 | 4 | `subscribe` | `remote/public/js/marks.js:L15-L15` (subscribe)<br>`remote/public/js/mesh.js:L42-L47` (subscribe) |
| 23 | Exact-AST | `0d1e8e9a0d15` | 2 | 4 | `emitWarning` | `remote/server/embed/store.js:L16-L19` (emitWarning)<br>`remote/server/literature/kb-struct.js:L12-L15` (emitWarning) |
| 24 | Exact-AST | `64eee3f187c4` | 2 | 4 | `recentFiles` | `app/kiro-records.js:L173-L176` (recentFiles)<br>`app/opencode-records.js:L86-L89` (recentFiles) |
| 25 | Exact-AST | `81a2e7e9e13c` | 2 | 4 | `<anonymous>` | `remote/server/claude-profile-requests.js:L33-L35` (<anonymous>)<br>`remote/server/mesh.js:L510-L513` (<anonymous>) |
| 26 | Exact-AST | `1d9cd889baa7` | 7 | 1 | `say` | `remote/public/js/apps/board.js:L69-L69` (say)<br>`remote/public/js/apps/computers.js:L22-L22` (say)<br>`remote/public/js/apps/filedlg.js:L52-L52` (say)<br>`remote/public/js/apps/notepad.js:L35-L35` (say)<br>`remote/public/js/apps/notify.js:L24-L24` (say)<br>`remote/public/js/apps/office-apps.js:L29-L29` (say)<br>`remote/public/js/wallpaper.js:L93-L93` (say) |
| 27 | Exact-AST | `578e3dd4282c` | 7 | 1 | `cut, short, oneLine` | `app/codex-records.js:L13-L13` (cut)<br>`app/kiro-records.js:L26-L26` (cut)<br>`app/transcript.js:L11-L11` (cut)<br>`remote/agent/subagents.js:L22-L22` (short)<br>`remote/server/literature/history.js:L18-L18` (cut)<br>`remote/server/literature/review.js:L22-L22` (cut)<br>`remote/server/summary/digest.js:L13-L13` (oneLine) |
| 28 | Exact-AST | `7e04452c06c9` | 7 | 1 | `todayStr, today` | `app/morning-page.js:L6-L6` (todayStr)<br>`app/morning.js:L24-L24` (today)<br>`remote/public/js/apps/mail-alerts.js:L12-L12` (today)<br>`remote/public/js/apps/todo-plan.js:L9-L9` (today)<br>`remote/server/literature/cards.js:L19-L19` (today)<br>`remote/server/literature/kb.js:L16-L16` (today)<br>`remote/server/literature/reader.js:L21-L21` (today) |
| 29 | Exact-AST | `94980222252c` | 7 | 1 | `save, saveInbox, saveProps` | `remote/server/literature/archive.js:L19-L19` (save)<br>`remote/server/literature/feed.js:L66-L66` (saveInbox)<br>`remote/server/literature/feed.js:L67-L67` (save)<br>`remote/server/literature/kb.js:L68-L68` (saveProps)<br>`remote/server/literature/translate.js:L24-L24` (save)<br>`remote/server/literature/vision.js:L67-L67` (saveReq)<br>`remote/server/literature/zotero/mirror.js:L54-L54` (save) |
| 30 | Exact-AST | `9eb3f6447863` | 7 | 1 | `save, saveIndex, saveCred` | `remote/server/ai/api-key.js:L15-L15` (save)<br>`remote/server/artifacts.js:L21-L21` (saveIndex)<br>`remote/server/google/tasks-sync.js:L21-L21` (save)<br>`remote/server/literature/zotero/local-api.js:L17-L17` (saveCred)<br>`remote/server/mail/drafts.js:L20-L20` (save)<br>`remote/server/mail/triage.js:L23-L23` (save)<br>`remote/server/push/index.js:L23-L23` (save) |
| 31 | Exact-AST | `5d393a93240c` | 6 | 1 | `hhmm, hm` | `app/bubble.js:L17-L17` (hhmm)<br>`remote/public/js/apps/lit-pdfq.js:L9-L9` (hm)<br>`remote/public/js/util.js:L26-L26` (hhmm)<br>`remote/server/google/index.js:L63-L63` (hm)<br>`remote/server/summary/digest.js:L11-L11` (hhmm)<br>`remote/server/summary/prompts.js:L45-L45` (hm) |
| 32 | Exact-AST | `6b450d9c9da8` | 6 | 1 | `sha, hash` | `remote/agent/memory-sync.js:L6-L6` (sha)<br>`remote/agent/native-archive.js:L8-L8` (hash)<br>`remote/agent/opencode-export.js:L6-L6` (hash)<br>`remote/server/research/normalize.js:L5-L5` (hash)<br>`remote/server/vault/database.js:L7-L7` (hash)<br>`remote/server/vault/memory.js:L3-L3` (sha) |
| 33 | Exact-AST | `42c516c094ca` | 3 | 2 | `<on:end>` | `app/opencode.js:L61-L61` (<on:end>)<br>`opencode-plugin/index.js:L220-L220` (<on:end>)<br>`remote/agent/pet-client.js:L76-L78` (<on:end>) |
| 34 | Exact-AST | `a6505ad570f0` | 3 | 2 | `changed, notify` | `remote/public/js/marks.js:L7-L7` (changed)<br>`remote/public/js/mesh.js:L9-L13` (notify)<br>`remote/public/js/todos.js:L8-L8` (changed) |
| 35 | Exact-AST | `2dcfc83e9206` | 2 | 3 | `applyFold, folding` | `remote/public/js/apps/approve-widget.js:L117-L121` (applyFold)<br>`remote/public/js/apps/magpie.js:L239-L239` (folding) |
| 36 | Exact-AST | `387c57307ae0` | 2 | 3 | `blobId` | `remote/agent/fleet.js:L38-L40` (blobId)<br>`remote/deploy/deploy-lib.js:L35-L37` (blobId) |
| 37 | Exact-AST | `4679805a0c87` | 2 | 3 | `cleanStr` | `remote/agent/sugon-runner.js:L15-L17` (cleanStr)<br>`remote/server/mesh-compute-queue.js:L26-L28` (cleanStr) |
| 38 | Exact-AST | `5fb2c46e239d` | 2 | 3 | `findAgy, findKiro` | `app/agy-cli.js:L12-L14` (findAgy)<br>`app/kiro-cli.js:L12-L14` (findKiro) |
| 39 | Exact-AST | `6d6a385e3337` | 2 | 3 | `<anonymous>` | `headless/ame-headless-win.js:L32-L34` (<anonymous>)<br>`headless/ame-headless.js:L39-L41` (<anonymous>) |
| 40 | Exact-AST | `08182a8e1a4a` | 5 | 1 | `opt` | `remote/agent/update-guard.js:L101-L101` (opt)<br>`remote/deploy/deploy.js:L26-L26` (opt)<br>`tools/run-cards-batch.js:L12-L12` (opt)<br>`tools/run-cards-via-agy.js:L13-L13` (opt)<br>`tools/run-teams-batch.js:L25-L25` (opt) |
| 41 | Exact-AST | `dfb9dedd07b7` | 5 | 1 | `out` | `app/main-sessions.js:L322-L322` (out)<br>`headless/ame-headless-win.js:L77-L77` (out)<br>`headless/ame-headless.js:L175-L175` (out)<br>`opencode-plugin/index.js:L384-L384` (out)<br>`remote/agent/mesh-bridge.js:L209-L209` (out) |
| 42 | Exact-AST | `e53f2fc92b3a` | 5 | 1 | `cut, clip` | `remote/server/literature/prompts/card.js:L22-L22` (cut)<br>`remote/server/literature/prompts/feed.js:L14-L14` (cut)<br>`remote/server/literature/prompts/profile.js:L32-L32` (cut)<br>`remote/server/literature/prompts/review.js:L22-L22` (cut)<br>`remote/server/push/events.js:L14-L14` (clip) |
| 43 | Exact-AST | `4637463ff177` | 4 | 1 | `onChange, on, onNew` | `remote/public/js/push.js:L19-L19` (onChange)<br>`remote/public/js/shade.js:L49-L49` (onChange)<br>`remote/server/literature/browser/cdp.js:L48-L48` (on)<br>`remote/server/mail/index.js:L174-L174` (onNew) |
| 44 | Exact-AST | `741251902afe` | 4 | 1 | `str` | `app/mail-notice.js:L14-L14` (str)<br>`app/morning.js:L21-L21` (str)<br>`remote/server/artifacts.js:L45-L45` (str)<br>`remote/server/mail/drafts.js:L15-L15` (str) |
| 45 | Exact-AST | `9922a074f101` | 4 | 1 | `saveIndex, save` | `remote/server/notes.js:L17-L17` (saveIndex)<br>`remote/server/session-marks.js:L17-L17` (save)<br>`remote/server/todo-lists.js:L17-L17` (save)<br>`remote/server/todos.js:L24-L24` (save) |
| 46 | Exact-AST | `9b1037c3388c` | 4 | 1 | `log` | `tools/run-cards-batch.js:L39-L39` (log)<br>`tools/run-cards-via-agy.js:L23-L23` (log)<br>`tools/run-full-kb-batch.js:L28-L28` (log)<br>`tools/run-teams-batch.js:L28-L28` (log) |
| 47 | Exact-AST | `a97706b9f96e` | 4 | 1 | `short, clean` | `remote/agent/agy-subagents.js:L14-L14` (short)<br>`remote/agent/codex-subagents.js:L7-L7` (short)<br>`remote/agent/opencode-subagents.js:L9-L9` (short)<br>`remote/server/mail/triage.js:L66-L66` (clean) |
| 48 | Exact-AST | `d38f960354bc` | 4 | 1 | `save` | `remote/server/ai/settings.js:L48-L48` (save)<br>`remote/server/literature/pdfqueue.js:L22-L22` (save)<br>`remote/server/literature/settings.js:L24-L24` (save)<br>`remote/server/mail/accounts.js:L20-L20` (save) |
| 49 | Exact-AST | `d3fd5f45c30a` | 4 | 1 | `kb, size` | `remote/public/js/apps/mail-compose.js:L12-L12` (kb)<br>`remote/public/js/apps/mail.js:L28-L28` (kb)<br>`remote/public/js/apps/report-view.js:L14-L14` (size)<br>`remote/server/summary/prompts.js:L43-L43` (kb) |
| 50 | Exact-AST | `01426737f85f` | 2 | 2 | `<anonymous>` | `app/bubble.js:L383-L384` (<anonymous>)<br>`remote/public/js/apps/dashboard.js:L495-L496` (<anonymous>) |
| 51 | Exact-AST | `112ec6964248` | 2 | 2 | `sendJSON, send` | `remote/agent/agent.js:L48-L50` (sendJSON)<br>`remote/public/js/net.js:L27-L27` (send) |
| 52 | Exact-AST | `4ca4e93ca064` | 2 | 2 | `nextDay` | `remote/server/google/calendar.js:L18-L20` (nextDay)<br>`remote/server/google/remind.js:L14-L14` (nextDay) |
| 53 | Exact-AST | `caa23f725675` | 2 | 2 | `<btn:下载 PDF>, onclick` | `remote/public/js/apps/lit-library.js:L78-L78` (<btn:下载 PDF>)<br>`remote/public/js/apps/lit-reader.js:L41-L42` (onclick) |
| 54 | Exact-AST | `1e5dd09d89ab` | 3 | 1 | `<on:data>` | `app/main-sessions.js:L367-L367` (<on:data>)<br>`headless/ame-headless-win.js:L115-L115` (<on:data>)<br>`headless/ame-headless.js:L213-L213` (<on:data>) |
| 55 | Exact-AST | `4e77c0e98e46` | 3 | 1 | `norm` | `remote/server/research/directories.js:L7-L7` (norm)<br>`remote/server/research/review.js:L4-L4` (norm)<br>`remote/server/research/service.js:L128-L128` (norm) |
| 56 | Exact-AST | `51afbb0e6b74` | 3 | 1 | `who` | `remote/public/js/apps/mail.js:L27-L27` (who)<br>`remote/server/mail/compose.js:L23-L23` (who)<br>`remote/server/mail/triage.js:L36-L36` (who) |
| 57 | Exact-AST | `56fb85fe777f` | 3 | 1 | `safe` | `remote/server/store.js:L16-L16` (safe)<br>`remote/server/summary/search.js:L65-L65` (safe)<br>`remote/server/summary/search.js:L129-L129` (safe) |
| 58 | Exact-AST | `61998b8e168f` | 3 | 1 | `esc` | `remote/public/js/apps/board-sheet.js:L8-L8` (esc)<br>`remote/public/js/util.js:L25-L25` (esc)<br>`remote/server/google/index.js:L16-L16` (esc) |
| 59 | Exact-AST | `699f788e4ed1` | 3 | 1 | `<on:mail-notice-close>, <on:open-dashboard>, <on:morning-close>` | `app/mail-notice.js:L66-L66` (<on:mail-notice-close>)<br>`app/main.js:L148-L148` (<on:open-dashboard>)<br>`app/morning.js:L89-L89` (<on:morning-close>) |
| 60 | Exact-AST | `6f0130e30e4e` | 3 | 1 | `<addEventListener:keydown>` | `remote/public/js/apps/todo-app.js:L73-L73` (<addEventListener:keydown>)<br>`remote/public/js/apps/todo-plan.js:L60-L60` (<addEventListener:keydown>)<br>`remote/public/js/apps/todo.js:L77-L77` (<addEventListener:keydown>) |
| 61 | Exact-AST | `72c85d745133` | 3 | 1 | `hm` | `remote/public/js/apps/calendar.js:L14-L14` (hm)<br>`remote/public/js/apps/mail-compose.js:L14-L14` (hm)<br>`remote/server/session-export.js:L10-L10` (hm) |
| 62 | Exact-AST | `7d173957ac98` | 3 | 1 | `btn` | `remote/public/js/apps/lit-library.js:L61-L61` (btn)<br>`remote/public/js/apps/lit-review.js:L16-L16` (btn)<br>`remote/public/js/apps/lit-vision.js:L13-L13` (btn) |
| 63 | Exact-AST | `8074f1b681a4` | 3 | 1 | `pagesBlock, block` | `remote/server/literature/prompts/card.js:L23-L23` (pagesBlock)<br>`remote/server/literature/prompts/digest.js:L7-L7` (block)<br>`remote/server/literature/prompts/reader.js:L20-L20` (pagesBlock) |
| 64 | Exact-AST | `e0069b1599ef` | 3 | 1 | `list` | `remote/server/board/store.js:L41-L41` (list)<br>`remote/server/mail/drafts.js:L29-L29` (list)<br>`remote/server/notes.js:L21-L21` (list) |
| 65 | Exact-AST | `0411cf556790` | 2 | 1 | `<on:data>` | `app/opencode.js:L60-L60` (<on:data>)<br>`opencode-plugin/index.js:L219-L219` (<on:data>) |
| 66 | Exact-AST | `05eb3095a3bc` | 2 | 1 | `label` | `remote/server/literature/digest.js:L44-L44` (label)<br>`remote/server/literature/reader.js:L70-L70` (label) |
| 67 | Exact-AST | `0616761a814c` | 2 | 1 | `md` | `app/mail-notice-page.js:L4-L4` (md)<br>`app/morning-page.js:L4-L4` (md) |
| 68 | Exact-AST | `1e9310f42af3` | 2 | 1 | `md` | `remote/public/js/apps/lit-notes.js:L115-L115` (md)<br>`remote/public/js/apps/lit-reader.js:L154-L154` (md) |
| 69 | Exact-AST | `22a362cb5e21` | 2 | 1 | `onclick` | `remote/public/js/apps/todo-plan.js:L96-L96` (onclick)<br>`remote/public/js/apps/todo.js:L43-L43` (onclick) |
| 70 | Exact-AST | `2ad9e4146052` | 2 | 1 | `n` | `remote/public/js/apps/dash-agents.js:L48-L48` (n)<br>`remote/server/literature/pdfqueue.js:L126-L126` (n) |
| 71 | Exact-AST | `2cdc1ffc536e` | 2 | 1 | `<on:fs>` | `remote/public/js/fs-upload.js:L16-L16` (<on:fs>)<br>`remote/public/js/fs.js:L8-L8` (<on:fs>) |
| 72 | Exact-AST | `31a518313886` | 2 | 1 | `edited, <addEventListener:input>` | `remote/public/js/apps/mail-compose.js:L93-L93` (edited)<br>`remote/public/js/apps/notepad.js:L66-L66` (<addEventListener:input>) |
| 73 | Exact-AST | `31da23c7c54b` | 2 | 1 | `post` | `remote/public/js/apps/board-out.js:L16-L16` (post)<br>`remote/public/js/apps/board.js:L25-L25` (post) |
| 74 | Exact-AST | `35a71c8baae2` | 2 | 1 | `<addEventListener:keydown>` | `remote/public/js/apps/explorer.js:L92-L92` (<addEventListener:keydown>)<br>`remote/public/js/dialog.js:L18-L18` (<addEventListener:keydown>) |
| 75 | Exact-AST | `3cf1379f6d63` | 2 | 1 | `ontoggle` | `remote/public/js/apps/lit-feed.js:L100-L100` (ontoggle)<br>`remote/public/js/apps/lit-pool.js:L49-L49` (ontoggle) |
| 76 | Exact-AST | `4d24367a324e` | 2 | 1 | `plain` | `remote/agent/harness.js:L40-L40` (plain)<br>`remote/server/fleet/releases.js:L19-L19` (plain) |
| 77 | Exact-AST | `50a09c77a9ca` | 2 | 1 | `when` | `remote/public/js/apps/explorer.js:L27-L27` (when)<br>`remote/public/js/apps/filedlg.js:L12-L12` (when) |
| 78 | Exact-AST | `5b1b0001cd57` | 2 | 1 | `<anonymous>` | `remote/public/js/apps/lit-evidence.js:L103-L103` (<anonymous>)<br>`remote/public/js/apps/lit-pool.js:L31-L31` (<anonymous>) |
| 79 | Exact-AST | `685287644740` | 2 | 1 | `<addEventListener:abort>, <on:timeout>` | `opencode-plugin/index.js:L225-L225` (<addEventListener:abort>)<br>`remote/agent/pet-client.js:L81-L81` (<on:timeout>) |
| 80 | Exact-AST | `6a5f787812ee` | 2 | 1 | `done` | `remote/server/summary/claude.js:L39-L39` (done)<br>`remote/server/summary/codex.js:L25-L25` (done) |
| 81 | Exact-AST | `6e6d78a9ec3f` | 2 | 1 | `button` | `remote/public/js/apps/knowledge-review.js:L17-L17` (button)<br>`remote/public/js/apps/knowledge.js:L36-L36` (button) |
| 82 | Exact-AST | `754c59131279` | 2 | 1 | `save` | `remote/public/js/apps/ai-api.js:L20-L20` (save)<br>`remote/public/js/apps/ai-google.js:L26-L26` (save) |
| 83 | Exact-AST | `76f5b7be952d` | 2 | 1 | `done` | `remote/server/research/service.js:L122-L122` (done)<br>`remote/server/vault/service.js:L6-L6` (done) |
| 84 | Exact-AST | `787758a3ff90` | 2 | 1 | `vnum, parts` | `remote/agent/harness.js:L32-L32` (vnum)<br>`remote/server/fleet/releases.js:L17-L17` (parts) |
| 85 | Exact-AST | `7a8d3dda0388` | 2 | 1 | `<addEventListener:keydown>` | `remote/public/js/apps/todo-plan.js:L24-L24` (<addEventListener:keydown>)<br>`remote/public/js/apps/todo.js:L50-L50` (<addEventListener:keydown>) |
| 86 | Exact-AST | `7af85326a3b9` | 2 | 1 | `unquote` | `remote/server/literature/feed.js:L55-L55` (unquote)<br>`remote/server/literature/profile.js:L25-L25` (unquote) |
| 87 | Exact-AST | `8dca8543744a` | 2 | 1 | `clip` | `app/permission-rules.js:L11-L11` (clip)<br>`app/transcript.js:L37-L37` (clip) |
| 88 | Exact-AST | `8e7e7e961f8d` | 2 | 1 | `<import:./lit-reader.js>` | `remote/public/js/apps/todo-plan.js:L96-L96` (<import:./lit-reader.js>)<br>`remote/public/js/apps/todo.js:L43-L43` (<import:./lit-reader.js>) |
| 89 | Exact-AST | `8fd06953bc04` | 2 | 1 | `click, press` | `remote/server/literature/browser/extlogin.js:L29-L29` (click)<br>`remote/server/literature/browser/signin.js:L65-L65` (press) |
| 90 | Exact-AST | `91f30d6f18f8` | 2 | 1 | `say` | `remote/public/js/apps/mail-compose.js:L83-L83` (say)<br>`remote/public/js/apps/office.js:L102-L102` (say) |
| 91 | Exact-AST | `9998170fc326` | 2 | 1 | `key` | `remote/server/literature/browser/extlogin.js:L30-L30` (key)<br>`remote/server/literature/browser/signin.js:L113-L113` (key) |
| 92 | Exact-AST | `99d77fc0b23e` | 2 | 1 | `<on:status>` | `remote/public/js/fs-upload.js:L17-L17` (<on:status>)<br>`remote/public/js/fs.js:L10-L10` (<on:status>) |
| 93 | Exact-AST | `a26a24e30666` | 2 | 1 | `str, s` | `remote/server/server.js:L424-L424` (str)<br>`remote/server/store.js:L51-L51` (s) |
| 94 | Exact-AST | `bc7d536de1bb` | 2 | 1 | `line` | `app/mail-notice-page.js:L5-L5` (line)<br>`app/morning-page.js:L7-L7` (line) |
| 95 | Exact-AST | `c92f6c2b5bd6` | 2 | 1 | `show` | `remote/public/js/apps/download-disk.js:L89-L89` (show)<br>`remote/public/js/apps/download-folder.js:L56-L56` (show) |
| 96 | Exact-AST | `d1d2bb8aa427` | 2 | 1 | `onchange` | `remote/public/js/apps/todo-plan.js:L90-L90` (onchange)<br>`remote/public/js/apps/todo.js:L36-L36` (onchange) |
| 97 | Exact-AST | `d49338f3d334` | 2 | 1 | `<addEventListener:keydown>` | `remote/public/js/apps/lit-notes.js:L71-L71` (<addEventListener:keydown>)<br>`remote/public/js/apps/lit-reader.js:L204-L204` (<addEventListener:keydown>) |
| 98 | Exact-AST | `d5bdc3c50aa0` | 2 | 1 | `save` | `remote/server/literature/reader.js:L28-L28` (save)<br>`remote/server/literature/vision.js:L63-L63` (save) |
| 99 | Exact-AST | `d61580d6b569` | 2 | 1 | `message, say` | `remote/public/js/apps/claude-apis.js:L25-L25` (message)<br>`remote/public/js/apps/knowledge.js:L33-L33` (say) |
| 100 | Exact-AST | `d93684f6110d` | 2 | 1 | `hide` | `app/mail-notice.js:L49-L49` (hide)<br>`app/morning.js:L71-L71` (hide) |
| 101 | Exact-AST | `dbb7381e8e7a` | 2 | 1 | `<anonymous>` | `remote/public/js/apps/board-gallery.js:L27-L27` (<anonymous>)<br>`remote/public/js/apps/board-surface.js:L334-L334` (<anonymous>) |
| 102 | Exact-AST | `de0399f0b562` | 2 | 1 | `readJSON` | `remote/agent/fleet.js:L42-L42` (readJSON)<br>`remote/agent/update-guard.js:L16-L16` (readJSON) |
| 103 | Exact-AST | `e336250ae918` | 2 | 1 | `<anonymous>` | `remote/server/research/service.js:L122-L122` (<anonymous>)<br>`remote/server/vault/service.js:L6-L6` (<anonymous>) |
| 104 | Exact-AST | `e6db8bfd0a9d` | 2 | 1 | `name` | `remote/server/session-marks.js:L18-L18` (name)<br>`remote/server/todo-lists.js:L18-L18` (name) |
| 105 | Exact-AST | `ef22d988a85a` | 2 | 1 | `<addEventListener:keydown>` | `remote/public/js/apps/explorer.js:L349-L349` (<addEventListener:keydown>)<br>`remote/public/js/apps/filedlg.js:L128-L128` (<addEventListener:keydown>) |
| 106 | Exact-AST | `efb418fb7a32` | 2 | 1 | `canonical` | `remote/server/research/directories.js:L8-L8` (canonical)<br>`remote/server/research/review.js:L5-L5` (canonical) |
| 107 | Exact-AST | `f5009cd3f661` | 2 | 1 | `get` | `remote/public/js/mesh.js:L29-L29` (get)<br>`remote/server/mail/drafts.js:L30-L30` (get) |
| 108 | Exact-AST | `f68bbab17fe1` | 2 | 1 | `<anonymous>` | `app/main-sessions.js:L369-L369` (<anonymous>)<br>`headless/ame-headless.js:L215-L215` (<anonymous>) |
| 109 | Exact-AST | `f927cfc7aec5` | 2 | 1 | `finish` | `remote/server/ai/deepseek-api.js:L48-L48` (finish)<br>`remote/server/ai/google-ai-api.js:L66-L66` (finish) |

### 1.2 原子写盘 `renameSync` 全仓分布（共 82 处）

| 子域 | 处数 | 具体文件与行号 |
| --- | ---: | --- |
| **Server** | 61 | `remote/mcp/client.js` (L61); `remote/server/agents-admin.js` (L14); `remote/server/ai/api-key.js` (L15); `remote/server/ai/deepseek-api.js` (L124); `remote/server/ai/google-ai-api.js` (L181); `remote/server/ai/settings.js` (L48); `remote/server/artifacts.js` (L21); `remote/server/backup.js` (L47); `remote/server/board/store.js` (L35); `remote/server/embed/store.js` (L132); `remote/server/fleet/index.js` (L88); `remote/server/fleet/releases.js` (L51); `remote/server/fs-catalog.js` (L68); `remote/server/google/account.js` (L21); `remote/server/google/tasks-sync.js` (L21); `remote/server/infra.js` (L165); `remote/server/literature/archive.js` (L19); `remote/server/literature/digest.js` (L61); `remote/server/literature/downloads.js` (L46); `remote/server/literature/feed.js` (L66, L67); `remote/server/literature/history.js` (L24); `remote/server/literature/kb-struct.js` (L192); `remote/server/literature/kb.js` (L68, L82); `remote/server/literature/mcp.js` (L192); `remote/server/literature/notes.js` (L60, L173); `remote/server/literature/pdfqueue.js` (L22); `remote/server/literature/profile.js` (L33); `remote/server/literature/reader.js` (L28); `remote/server/literature/review.js` (L33); `remote/server/literature/settings.js` (L24); `remote/server/literature/translate.js` (L24); `remote/server/literature/vision.js` (L63, L67); `remote/server/literature/zotero/local-api.js` (L17); `remote/server/literature/zotero/mirror.js` (L54); `remote/server/magpie/index.js` (L20); `remote/server/mail/accounts.js` (L20); `remote/server/mail/drafts.js` (L20); `remote/server/mail/triage.js` (L23); `remote/server/mesh-compute-queue.js` (L95); `remote/server/mesh-model-router.js` (L115); `remote/server/mesh-roles.js` (L137); `remote/server/mesh.js` (L551, L562, L1003, L1038, L1082); `remote/server/notes.js` (L17); `remote/server/office/sessions.js` (L24); `remote/server/push/index.js` (L23); `remote/server/research/service.js` (L30); `remote/server/search-index/index.js` (L45); `remote/server/session-marks.js` (L17); `remote/server/store.js` (L185); `remote/server/summary/reports.js` (L17); `remote/server/todo-lists.js` (L17); `remote/server/todos.js` (L24); `remote/server/walls.js` (L97) |
| **Agent/Headless** | 17 | `headless/ame-headless-win.js` (L26); `remote/agent/agent-config.js` (L25); `remote/agent/claude-profiles.js` (L113); `remote/agent/fleet.js` (L46, L234, L392); `remote/agent/harness.js` (L77); `remote/agent/hook-installer-common.js` (L76); `remote/agent/memory-sync.js` (L35); `remote/agent/mesh-bridge.js` (L83, L93, L102); `remote/agent/opencode-export.js` (L41); `remote/agent/quota-notices.js` (L19); `remote/agent/sugon-runner.js` (L771, L797, L819) |
| **Pet(app)** | 2 | `app/quota-notice.js` (L12); `app/session-registry.js` (L80) |
| **Hooks/Installers** | 1 | `opencode-plugin/index.js` (L43) |
| **Tools** | 1 | `tools/ame-mesh.js` (L71) |

### 1.3 四类典型跨目录复制粘贴辅助函数清单

- **JSON 安全读写辅助函数（9 处定义）**：`install-opencode-plugin.js:L46` (`parseJsonc`, 4行)、`opencode-plugin/index.js:L38` (`writeJson`, 4行)、`remote/agent/fleet.js:L42` (`readJSON`, 1行)、`remote/agent/fleet.js:L43` (`writeJSON`, 5行)、`remote/agent/hook-installer-common.js:L58` (`readJsonFile`, 6行)、`remote/agent/update-guard.js:L16` (`readJSON`, 1行)、`remote/server/literature/kb-struct.js:L96` (`parseJson`, 8行)、`remote/server/summary/reports.js:L16` (`readJson`, 1行)、`remote/server/summary/reports.js:L17` (`writeJson`, 1行)
- **HTTP/HTTPS 原生请求调用点（27 处）**：`app/opencode.js:L57` (`http.request`)、`opencode-plugin/index.js:L216` (`http.request`)、`remote/agent/harness.js:L101` (`http.request`)、`remote/agent/hook-common.js:L78` (`http.request`)、`remote/agent/pet-client.js:L53` (`http.request`)、`remote/mcp/client.js:L31` (`http.request`)、`remote/server/ai/anthropic-api.js:L172` (`http.get`)、`remote/server/google/http.js:L43` (`https.request`)、`remote/server/literature/browser/cdp.js:L12` (`http.get`)、`remote/server/literature/fulltext.js:L95` (`http.get`)、`remote/server/literature/intake.js:L58` (`http.get`)、`remote/server/literature/mcp.js:L48` (`http.request`)、`remote/server/literature/sources/cnjournals.js:L38` (`http.get`)、`remote/server/literature/sources/feeds.js:L61` (`http.get`)、`remote/server/literature/sources/feeds.js:L77` (`http.get`)、`remote/server/literature/sources/feeds.js:L143` (`http.get`)、`remote/server/literature/sources/s2.js:L29` (`http.request`)、`remote/server/literature/zotero/local-api.js:L24` (`http.request`)、`remote/server/literature/zotero/local-api.js:L43` (`http.request`)、`remote/server/literature/zotero/local-api.js:L64` (`http.request`)、`remote/server/literature/zotero/local-api.js:L96` (`http.request`)、`remote/server/office/hook.js:L32` (`http.get`)、`remote/server/office/index.js:L62` (`http.get`)、`remote/server/office/proxy.js:L35` (`http.request`)、`remote/server/office/proxy.js:L52` (`http.request`)、`remote/server/walls.js:L62` (`https.get`)、`tools/ame-mesh.js:L32` (`http.request`)
- **路径 / Shell / PowerShell 引号转义函数（4 处定义）**：`agy-hook.js:L13` (`unquote`, 9行)、`remote/agent/hook-installer-common.js:L13` (`psQuote`, 1行)、`remote/agent/hook-installer-common.js:L16` (`winCmdQuote`, 5行)、`remote/agent/hook-installer-common.js:L33` (`needsQuote`, 1行)
- **HTML 转义函数（7 处定义）**：`app/bubble.js:L376` (`esc`, 1行)、`remote/public/js/apps/board-sheet.js:L8` (`esc`, 1行)、`remote/public/js/util.js:L25` (`esc`, 1行)、`remote/server/google/index.js:L16` (`esc`, 1行)、`remote/server/literature/cards.js:L35` (`noteHtml`, 10行)、`remote/server/literature/cards.js:L36` (`esc`, 1行)、`remote/server/literature/history.js:L82` (`esc`, 1行)

---

## 2. 全量 CJS `module.exports` 与 ESM `export` 零生产引用符号清单

> 说明：`prodRefs = 0` 表示该导出符号名在全仓所有**其他生产源码文件（含 HTML 内联脚本）**中出现次数为 0。若 `testRefs > 0` 说明仅供单测白盒调用（可评估是否保留供单测或收敛内部接口）；若 `testRefs = 0` 且非框架动态反射钩子，属于高置信度可清理死导出/可降级文件私有函数。

| 子域 | 模块体制 | 文件与行号 | 导出符号 | 文件内自引 | 单测引用 (`testRefs`) | 判定建议 |
| --- | --- | --- | --- | ---: | ---: | --- |
| Agent/Headless | CJS | `headless/launch.js:L187` | `buildTail` | 2 | 13 | 内部函数（仅额外导出给单测） |
| Agent/Headless | CJS | `remote/agent/agent-config.js:L144` | `withBypass` | 2 | 5 | 内部函数（仅额外导出给单测） |
| Agent/Headless | CJS | `remote/agent/codex-quota.js:L120` | `parseRateLimitsFromLines` | 2 | 2 | 内部函数（仅额外导出给单测） |
| Agent/Headless | CJS | `remote/agent/colab-runner.js:L584` | `parseColabUsage` | 2 | 4 | 内部函数（仅额外导出给单测） |
| Agent/Headless | CJS | `remote/agent/colab-runner.js:L585` | `parseSessionId` | 2 | 3 | 内部函数（仅额外导出给单测） |
| Agent/Headless | CJS | `remote/agent/colab-runner.js:L588` | `DEFAULT_FALLBACK_GPUS` | 3 | 0 | 仅文件内部自用（无需导出） |
| Agent/Headless | CJS | `remote/agent/colab-runner.js:L589` | `DEFAULT_MAX_DURATION_MIN` | 3 | 0 | 仅文件内部自用（无需导出） |
| Agent/Headless | CJS | `remote/agent/colab-runner.js:L590` | `DEFAULT_MIN_BALANCE_CCU` | 3 | 0 | 仅文件内部自用（无需导出） |
| Agent/Headless | CJS | `remote/agent/compute-probe.js:L206` | `probeGpu` | 2 | 0 | 仅文件内部自用（无需导出） |
| Agent/Headless | CJS | `remote/agent/compute-probe.js:L207` | `probeCpu` | 2 | 2 | 内部函数（仅额外导出给单测） |
| Agent/Headless | CJS | `remote/agent/compute-probe.js:L209` | `parseNvidiaSmiOutput` | 2 | 2 | 内部函数（仅额外导出给单测） |
| Agent/Headless | CJS | `remote/agent/compute-probe.js:L210` | `parseCpuListCount` | 2 | 2 | 内部函数（仅额外导出给单测） |
| Agent/Headless | CJS | `remote/agent/compute-probe.js:L211` | `normalizePciBusId` | 2 | 3 | 内部函数（仅额外导出给单测） |
| Agent/Headless | CJS | `remote/agent/compute-probe.js:L212` | `readPciNumaNode` | 2 | 4 | 内部函数（仅额外导出给单测） |
| Agent/Headless | CJS | `remote/agent/compute-probe.js:L213` | `readNumaNodes` | 2 | 3 | 内部函数（仅额外导出给单测） |
| Agent/Headless | CJS | `remote/agent/fleet.js:L441` | `httpBaseOf` | 2 | 0 | 仅文件内部自用（无需导出） |
| Agent/Headless | CJS | `remote/agent/fleet.js:L441` | `downloadBundle` | 2 | 0 | 仅文件内部自用（无需导出） |
| Agent/Headless | CJS | `remote/agent/harness.js:L305` | `SPEC` | 10 | 0 | 仅文件内部自用（无需导出） |
| Agent/Headless | CJS | `remote/agent/harness.js:L305` | `IDS` | 3 | 0 | 仅文件内部自用（无需导出） |
| Agent/Headless | CJS | `remote/agent/harness.js:L305` | `netFile` | 3 | 0 | 仅文件内部自用（无需导出） |
| Agent/Headless | CJS | `remote/agent/harness.js:L305` | `older` | 3 | 3 | 内部函数（仅额外导出给单测） |
| Agent/Headless | CJS | `remote/agent/harness.js:L305` | `proxyUrlOf` | 2 | 4 | 内部函数（仅额外导出给单测） |
| Agent/Headless | CJS | `remote/agent/infra-probe.js:L356` | `probeTcp` | 10 | 0 | 仅文件内部自用（无需导出） |
| Agent/Headless | CJS | `remote/agent/infra-probe.js:L356` | `SYSTEMD_IGNORE` | 2 | 0 | 仅文件内部自用（无需导出） |
| Agent/Headless | CJS | `remote/agent/locate.js:L117` | `SEARCH` | 6 | 0 | 仅文件内部自用（无需导出） |
| Agent/Headless | CJS | `remote/agent/memory-sync.js:L256` | `cleanManaged` | 4 | 0 | 仅文件内部自用（无需导出） |
| Agent/Headless | CJS | `remote/agent/memory-sync.js:L256` | `START` | 10 | 7 | 内部函数（仅额外导出给单测） |
| Agent/Headless | CJS | `remote/agent/memory-sync.js:L256` | `END` | 14 | 0 | 仅文件内部自用（无需导出） |
| Agent/Headless | CJS | `remote/agent/mesh-bridge.js:L344` | `globToRegex` | 2 | 0 | 仅文件内部自用（无需导出） |
| Agent/Headless | CJS | `remote/agent/mesh-bridge.js:L344` | `scanDirFiles` | 2 | 0 | 仅文件内部自用（无需导出） |
| Agent/Headless | CJS | `remote/agent/native-archive.js:L201` | `compactAgyToolOutputs` | 2 | 2 | 内部函数（仅额外导出给单测） |
| Agent/Headless | CJS | `remote/agent/native-archive.js:L201` | `fileHash` | 4 | 0 | 仅文件内部自用（无需导出） |
| Agent/Headless | CJS | `remote/agent/pet-client.js:L184` | `apiOf` | 2 | 0 | 仅文件内部自用（无需导出） |
| Agent/Headless | CJS | `remote/agent/session-scanner.js:L534` | `deriveState` | 3 | 0 | 仅文件内部自用（无需导出） |
| Agent/Headless | CJS | `remote/agent/sugon-runner.js:L845` | `DEFAULT_CONFIG_PATH` | 8 | 0 | 仅文件内部自用（无需导出） |
| Agent/Headless | CJS | `remote/agent/sugon-runner.js:L846` | `DEFAULT_RAYFILE_BIN` | 4 | 0 | 仅文件内部自用（无需导出） |
| Agent/Headless | CJS | `remote/agent/sugon-runner.js:L847` | `stripClusterBanner` | 13 | 2 | 内部函数（仅额外导出给单测） |
| Agent/Headless | CJS | `remote/agent/sugon-runner.js:L849` | `resolveSugonProfile` | 4 | 0 | 仅文件内部自用（无需导出） |
| Agent/Headless | CJS | `remote/agent/sugon-runner.js:L850` | `computeKeyExpiryDays` | 2 | 0 | 仅文件内部自用（无需导出） |
| Agent/Headless | CJS | `remote/agent/sugon-runner.js:L851` | `parseKeyExpireFromFilename` | 2 | 0 | 仅文件内部自用（无需导出） |
| Agent/Headless | CJS | `remote/agent/sugon-runner.js:L852` | `buildRayfileDownloadPlan` | 2 | 1 | 内部函数（仅额外导出给单测） |
| Agent/Headless | CJS | `remote/agent/sugon-runner.js:L853` | `parseSinfoPartitions` | 2 | 2 | 内部函数（仅额外导出给单测） |
| Agent/Headless | CJS | `remote/agent/sugon-runner.js:L854` | `parseSqueueJobs` | 2 | 2 | 内部函数（仅额外导出给单测） |
| Agent/Headless | CJS | `remote/agent/sugon-runner.js:L855` | `parseSacctFailures` | 2 | 2 | 内部函数（仅额外导出给单测） |
| Agent/Headless | CJS | `remote/agent/sugon-runner.js:L856` | `parseSbatchJobId` | 2 | 2 | 内部函数（仅额外导出给单测） |
| Agent/Headless | CJS | `remote/agent/sugon-runner.js:L857` | `buildSbatchScript` | 2 | 2 | 内部函数（仅额外导出给单测） |
| Agent/Headless | CJS | `remote/agent/update-guard.js:L109` | `restoreFiles` | 2 | 0 | 仅文件内部自用（无需导出） |
| Agent/Headless | CJS | `remote/deploy/deploy-lib.js:L136` | `REPO` | 4 | 5 | 内部函数（仅额外导出给单测） |
| Hooks/Installers | CJS | `agy-hook.js:L398` | `handleEvent` | 3 | 16 | 内部函数（仅额外导出给单测） |
| Hooks/Installers | CJS | `agy-hook.js:L401` | `decisionFor` | 3 | 7 | 内部函数（仅额外导出给单测） |
| Hooks/Installers | CJS | `agy-hook.js:L406` | `resolveEvent` | 2 | 0 | 仅文件内部自用（无需导出） |
| Hooks/Installers | CJS | `hook-relay.js:L163` | `sessionTitle` | 2 | 0 | 仅文件内部自用（无需导出） |
| Hooks/Installers | CJS | `hook-relay.js:L163` | `lastAssistantText` | 2 | 0 | 仅文件内部自用（无需导出） |
| Hooks/Installers | CJS | `install-agy-hooks.js:L119` | `uninstall` | 1 | 2 | 内部函数（仅额外导出给单测） |
| Hooks/Installers | CJS | `install-kiro-hooks.js:L120` | `mergeObject` | 2 | 0 | 仅文件内部自用（无需导出） |
| Hooks/Installers | CJS | `install-kiro-hooks.js:L120` | `removeObject` | 3 | 0 | 仅文件内部自用（无需导出） |
| Hooks/Installers | CJS | `install-kiro-hooks.js:L120` | `mergeArray` | 2 | 0 | 仅文件内部自用（无需导出） |
| Hooks/Installers | CJS | `install-kiro-hooks.js:L120` | `removeArray` | 3 | 0 | 仅文件内部自用（无需导出） |
| Hooks/Installers | CJS | `install-kiro-hooks.js:L120` | `TRIGGERS` | 3 | 4 | 内部函数（仅额外导出给单测） |
| Hooks/Installers | CJS | `install-mesh-mcp.js:L149` | `mergeClaudeJson` | 2 | 7 | 内部函数（仅额外导出给单测） |
| Hooks/Installers | CJS | `install-mesh-mcp.js:L149` | `mergeAgyJson` | 2 | 6 | 内部函数（仅额外导出给单测） |
| Hooks/Installers | CJS | `install-mesh-mcp.js:L149` | `mergeCodexToml` | 2 | 8 | 内部函数（仅额外导出给单测） |
| Hooks/Installers | CJS | `install-mesh-mcp.js:L149` | `mergeOpenCodeJson` | 2 | 6 | 内部函数（仅额外导出给单测） |
| Hooks/Installers | CJS | `install-mesh-mcp.js:L149` | `mergeKiroJson` | 2 | 6 | 内部函数（仅额外导出给单测） |
| Hooks/Installers | CJS | `install-mesh-mcp.js:L149` | `installKiro` | 1 | 5 | 内部函数（仅额外导出给单测） |
| Hooks/Installers | CJS | `install-mesh-mcp.js:L149` | `allEntries` | 2 | 0 | 仅文件内部自用（无需导出） |
| Hooks/Installers | CJS | `install-mesh-mcp.js:L149` | `CLIENT_SCRIPT` | 3 | 0 | 仅文件内部自用（无需导出） |
| Hooks/Installers | CJS | `install-mesh-mcp.js:L149` | `MESH_SCRIPT` | 5 | 0 | 仅文件内部自用（无需导出） |
| Hooks/Installers | CJS | `install-opencode-plugin.js:L161` | `addEntry` | 2 | 0 | 仅文件内部自用（无需导出） |
| Hooks/Installers | CJS | `install-opencode-plugin.js:L161` | `parseJsonc` | 3 | 2 | 内部函数（仅额外导出给单测） |
| Hooks/Installers | CJS | `install-opencode-plugin.js:L161` | `keyPos` | 3 | 0 | 仅文件内部自用（无需导出） |
| Hooks/Installers | CJS | `install-opencode-plugin.js:L161` | `ENTRY` | 6 | 0 | 仅文件内部自用（无需导出） |
| Hooks/Installers | ESM | `opencode-plugin/protocol.js:L85` | `contextWindowOf` | 1 | 0 | 仅文件内部自用（无需导出） |
| Hooks/Installers | CJS | `permission-hook.js:L66` | `formatReply` | 2 | 0 | 仅文件内部自用（无需导出） |
| Pet(app) | CJS | `app/agy-records.js:L478` | `fileUriToPath` | 3 | 0 | 仅文件内部自用（无需导出） |
| Pet(app) | CJS | `app/agy-records.js:L479` | `idOfFile` | 2 | 0 | 仅文件内部自用（无需导出） |
| Pet(app) | CJS | `app/agy-records.js:L480` | `rootOfFile` | 3 | 0 | 仅文件内部自用（无需导出） |
| Pet(app) | CJS | `app/btw-panel.js:L140` | `panelOf` | 6 | 7 | 内部函数（仅额外导出给单测） |
| Pet(app) | CJS | `app/btw-panel.js:L140` | `appendPage` | 2 | 3 | 内部函数（仅额外导出给单测） |
| Pet(app) | CJS | `app/btw-panel.js:L140` | `readAnswer` | 2 | 3 | 内部函数（仅额外导出给单测） |
| Pet(app) | CJS | `app/kiro-cli.js:L60` | `resumeArgs` | 2 | 3 | 内部函数（仅额外导出给单测） |
| Pet(app) | CJS | `app/kiro-records.js:L190` | `isLive` | 1 | 0 | 仅文件内部自用（无需导出） |
| Pet(app) | CJS | `app/opencode-records.js:L116` | `META` | 3 | 0 | 仅文件内部自用（无需导出） |
| Pet(app) | CJS | `app/outline.js:L70` | `rectsOfMask` | 2 | 5 | 内部函数（仅额外导出给单测） |
| Pet(app) | CJS | `app/outline.js:L70` | `growMask` | 2 | 3 | 内部函数（仅额外导出给单测） |
| Pet(app) | CJS | `app/outline.js:L70` | `OUTLINE` | 7 | 4 | 内部函数（仅额外导出给单测） |
| Pet(app) | CJS | `app/screen-text.js:L54` | `MAX_CHARS` | 2 | 0 | 仅文件内部自用（无需导出） |
| Pet(app) | CJS | `app/session-locate.js:L61` | `OPENCODE_EXE` | 2 | 0 | 仅文件内部自用（无需导出） |
| Pet(app) | CJS | `app/session-source.js:L24` | `providerOf` | 1 | 4 | 内部函数（仅额外导出给单测） |
| Pet(app) | CJS | `app/session-source.js:L24` | `rawOf` | 1 | 2 | 内部函数（仅额外导出给单测） |
| Server | CJS | `remote/mcp/client.js:L121` | `callAgent` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/ai/anthropic-api.js:L179` | `forApi` | 5 | 2 | 内部函数（仅额外导出给单测） |
| Server | CJS | `remote/server/ai/anthropic-api.js:L179` | `contentOf` | 2 | 6 | 内部函数（仅额外导出给单测） |
| Server | CJS | `remote/server/ai/google-ai-api.js:L222` | `DEFAULT_MODELS` | 7 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/ai/settings.js:L157` | `TASKS` | 4 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/auth.js:L117` | `totpAt` | 2 | 71 | 内部函数（仅额外导出给单测） |
| Server | CJS | `remote/server/auth.js:L118` | `FRESH_MS` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/board/store.js:L88` | `cleanDoc` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/embed/clean.js:L140` | `MIN_EFFECTIVE_CHARS` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/embed/clean.js:L145` | `detectTag` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/embed/client.js:L146` | `formatQuery` | 3 | 2 | 内部函数（仅额外导出给单测） |
| Server | CJS | `remote/server/embed/client.js:L147` | `truncateAndNormalize` | 2 | 9 | 内部函数（仅额外导出给单测） |
| Server | CJS | `remote/server/embed/search.js:L202` | `makeSnippet` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/embed/search.js:L203` | `DEFAULT_RRF_K` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/embed/store.js:L492` | `fromBlob` | 4 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/fleet/magpie-keys.js:L82` | `httpJSON` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/fleet/releases.js:L132` | `inRange` | 3 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/fleet/releases.js:L132` | `summaryPrompt` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/google/account.js:L114` | `SCOPES` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/google/calendar.js:L151` | `OWN_NAME` | 4 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/google/tasks-sync.js:L113` | `LIST_TITLE` | 4 | 2 | 内部函数（仅额外导出给单测） |
| Server | CJS | `remote/server/infra.js:L976` | `DEFAULT_NODES` | 3 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/infra.js:L976` | `DEFAULT_LINKS` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/infra.js:L976` | `OFFLINE_MS` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/literature/annots.js:L165` | `sortIndex` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/literature/annots.js:L165` | `cleanRects` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/literature/benchmark.js:L120` | `parseLastJsonLine` | 3 | 2 | 内部函数（仅额外导出给单测） |
| Server | CJS | `remote/server/literature/browser/cdp.js:L58` | `getJson` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/literature/browser/sites.js:L103` | `SITES` | 4 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/literature/browser/sites.js:L103` | `OTHER` | 4 | 1 | 内部函数（仅额外导出给单测） |
| Server | CJS | `remote/server/literature/cards.js:L266` | `noteHtml` | 2 | 2 | 内部函数（仅额外导出给单测） |
| Server | CJS | `remote/server/literature/cards.js:L266` | `NOTE_TAG` | 5 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/literature/digest.js:L77` | `PART` | 3 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/literature/downloads.js:L205` | `cleanDoi` | 3 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/literature/downloads.js:L205` | `MAX_PER_CALL` | 4 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/literature/evidence-schemas.js:L349` | `SCHEMAS` | 4 | 3 | 内部函数（仅额外导出给单测） |
| Server | CJS | `remote/server/literature/evidence-schemas.js:L353` | `verifyQuote` | 3 | 21 | 内部函数（仅额外导出给单测） |
| Server | CJS | `remote/server/literature/evidence-schemas.js:L355` | `normalizeForMatch` | 4 | 2 | 内部函数（仅额外导出给单测） |
| Server | CJS | `remote/server/literature/evidence.js:L182` | `buildPrompt` | 2 | 4 | 内部函数（仅额外导出给单测） |
| Server | CJS | `remote/server/literature/evidence.js:L182` | `csvCell` | 3 | 7 | 内部函数（仅额外导出给单测） |
| Server | CJS | `remote/server/literature/figures.js:L141` | `HAS_FIG` | 3 | 7 | 内部函数（仅额外导出给单测） |
| Server | CJS | `remote/server/literature/notes.js:L205` | `inkOf` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/literature/paradigm.js:L413` | `CONTRADICTION_SCHEMA` | 2 | 5 | 内部函数（仅额外导出给单测） |
| Server | CJS | `remote/server/literature/profile.js:L253` | `AIAA` | 3 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/literature/sources/cnjournals.js:L47` | `articles` | 2 | 2 | 内部函数（仅额外导出给单测） |
| Server | CJS | `remote/server/literature/sources/cnjournals.js:L47` | `JOURNALS` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/literature/sources/openalex.js:L79` | `abstractOf` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/literature/sources/openalex.js:L79` | `fromWork` | 4 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/literature/sources/s2.js:L65` | `fromS2` | 3 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/literature/stream.js:L246` | `TEAM_SCHEMA` | 3 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/literature/stream.js:L246` | `teamIdOf` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/literature/zotero/local-api.js:L105` | `APP_NAME` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/literature/zotero/mirror.js:L143` | `yearOf` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/literature/zotero/webdav.js:L66` | `extract` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/mail/accounts.js:L82` | `DEF` | 4 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/mail/compose-prompt.js:L30` | `TONES` | 3 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/mail/compose.js:L165` | `parseList` | 4 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/mail/imap.js:L161` | `FIRST_DAYS` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/mail/parse.js:L65` | `htmlText` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/mail/store.js:L126` | `dupOf` | 3 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/mesh-auto-judge.js:L209` | `JUDGE_SCHEMA` | 3 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/mesh-auto-judge.js:L210` | `ruleBasedJudge` | 2 | 4 | 内部函数（仅额外导出给单测） |
| Server | CJS | `remote/server/mesh-auto-judge.js:L211` | `buildJudgePrompt` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/mesh-board.js:L468` | `parseMentions` | 2 | 3 | 内部函数（仅额外导出给单测） |
| Server | CJS | `remote/server/mesh-board.js:L469` | `resolveTargets` | 3 | 18 | 内部函数（仅额外导出给单测） |
| Server | CJS | `remote/server/mesh-board.js:L470` | `parseChannelMentions` | 2 | 4 | 内部函数（仅额外导出给单测） |
| Server | CJS | `remote/server/mesh-board.js:L471` | `parseRefs` | 2 | 3 | 内部函数（仅额外导出给单测） |
| Server | CJS | `remote/server/mesh-compute-queue.js:L679` | `RESOURCES` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/mesh-compute-queue.js:L679` | `PRIORITIES` | 4 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/mesh-compute-queue.js:L679` | `DEFAULT_SLOTS` | 3 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/mesh-fable-advisor.js:L218` | `findDevinExpiringWindow` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/mesh-fable-advisor.js:L219` | `collectHardProblems` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/mesh-fable-advisor.js:L221` | `buildAdvisorPrompt` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/mesh-model-router.js:L544` | `DEFAULT_POOLS` | 3 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/mesh-repair.js:L112` | `BUILTIN_ROLES` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/mesh-repair.js:L114` | `inferRole` | 3 | 3 | 内部函数（仅额外导出给单测） |
| Server | CJS | `remote/server/mesh-repair.js:L115` | `knownRoleSet` | 3 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/mesh-repair.js:L116` | `looksLikeAutoAlias` | 3 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/mesh-roles.js:L177` | `parseFrontmatter` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/mesh-sugon-advisor.js:L225` | `ruleBasedDiagnose` | 2 | 2 | 内部函数（仅额外导出给单测） |
| Server | CJS | `remote/server/mesh-sugon-advisor.js:L228` | `buildDiagnosisPrompt` | 3 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/mesh-watchdog.js:L689` | `DEFAULT_CONFIG` | 4 | 2 | 内部函数（仅额外导出给单测） |
| Server | CJS | `remote/server/mesh-watchdog.js:L692` | `normalizeErrorSig` | 2 | 4 | 内部函数（仅额外导出给单测） |
| Server | CJS | `remote/server/mesh.js:L4388` | `isSubPath` | 4 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/mesh.js:L4388` | `formatEnvelope` | 5 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/push/events.js:L107` | `DONE_MIN` | 2 | 2 | 内部函数（仅额外导出给单测） |
| Server | CJS | `remote/server/push/webpush.js:L61` | `vapid` | 2 | 1 | 内部函数（仅额外导出给单测） |
| Server | CJS | `remote/server/push/webpush.js:L61` | `encrypt` | 2 | 1 | 内部函数（仅额外导出给单测） |
| Server | CJS | `remote/server/push/webpush.js:L61` | `fromB64u` | 4 | 3 | 内部函数（仅额外导出给单测） |
| Server | CJS | `remote/server/research/directories.js:L838` | `DEFAULT_MODEL` | 13 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/research/extract.js:L106` | `evidenceUnits` | 3 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/research/normalize.js:L127` | `jsonLines` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/search-index/terms.js:L45` | `CJK_RUN` | 3 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/session-export.js:L64` | `messagesOf` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/summary/digest.js:L90` | `activeMinutes` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/summary/digest.js:L90` | `absPath` | 2 | 3 | 内部函数（仅额外导出给单测） |
| Server | CJS | `remote/server/summary/qa.js:L112` | `TERMS_SCHEMA` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/summary/qa.js:L112` | `ANSWER_SCHEMA` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/summary/weekly.js:L86` | `WEEK_SCHEMA` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/vault/review.js:L453` | `CATEGORIES` | 3 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/vault/review.js:L453` | `NEW_PROJECT_PREFIX` | 2 | 0 | 仅文件内部自用（无需导出） |
| Server | CJS | `remote/server/walls.js:L118` | `sniff` | 2 | 5 | 内部函数（仅额外导出给单测） |
| Tools | CJS | `tools/ame-mesh.js:L911` | `rpc` | 24 | 21 | 内部函数（仅额外导出给单测） |
| Tools | CJS | `tools/ame-mesh.js:L911` | `handleMcpCall` | 2 | 11 | 内部函数（仅额外导出给单测） |
| Tools | CJS | `tools/ame-mesh.js:L911` | `MCP_TOOLS` | 2 | 13 | 内部函数（仅额外导出给单测） |
| Tools | CJS | `tools/ame-mesh.js:L911` | `callLocal` | 2 | 0 | 仅文件内部自用（无需导出） |
| Tools | CJS | `tools/ame-mesh.js:L911` | `buildAssignedEnv` | 2 | 5 | 内部函数（仅额外导出给单测） |
| Tools | CJS | `tools/ame-mesh.js:L911` | `executeCommandWorker` | 3 | 0 | 仅文件内部自用（无需导出） |
| Tools | CJS | `tools/ame-mesh.js:L911` | `watchPidWorker` | 3 | 0 | 仅文件内部自用（无需导出） |
| Tools | CJS | `tools/ame-mesh.js:L911` | `runBgMcp` | 2 | 0 | 仅文件内部自用（无需导出） |
| Tools | CJS | `tools/ame-mesh.js:L911` | `runCli` | 2 | 5 | 内部函数（仅额外导出给单测） |
| Tools | CJS | `tools/ame-mesh.js:L911` | `parseCliFlags` | 3 | 0 | 仅文件内部自用（无需导出） |
| Web | ESM | `remote/public/js/apps/board-ink.js:L26` | `markerColor` | 1 | 0 | 仅文件内部自用（无需导出） |
| Web | ESM | `remote/public/js/apps/board-page.js:L15` | `loadTex` | 2 | 0 | 仅文件内部自用（无需导出） |
| Web | ESM | `remote/public/js/apps/dash-ask.js:L18` | `answerOf` | 1 | 0 | 仅文件内部自用（无需导出） |
| Web | ESM | `remote/public/js/apps/lit-md.js:L14` | `stripFront` | 1 | 0 | 仅文件内部自用（无需导出） |
| Web | ESM | `remote/public/js/apps/opencode-config.js:L14` | `entryFor` | 1 | 3 | 内部函数（仅额外导出给单测） |
| Web | ESM | `remote/public/js/apps/opencode-config.js:L63` | `sourceOf` | 2 | 0 | 仅文件内部自用（无需导出） |
| Web | ESM | `remote/public/js/apps/pdf-annot.js:L21` | `mergeRects` | 1 | 0 | 仅文件内部自用（无需导出） |
| Web | ESM | `remote/public/js/apps/term-parse.js:L59` | `hintLine` | 6 | 6 | 内部函数（仅额外导出给单测） |
| Web | ESM | `remote/public/js/apps/todo-side.js:L27` | `addList` | 1 | 0 | 仅文件内部自用（无需导出） |
| Web | ESM | `remote/public/js/apps/topo-model.js:L7` | `OTHER_KEY` | 2 | 0 | 仅文件内部自用（无需导出） |
| Web | ESM | `remote/public/js/apps/topo-model.js:L13` | `threadKeyOfTask` | 1 | 6 | 内部函数（仅额外导出给单测） |
| Web | ESM | `remote/public/js/dialog.js:L30` | `msgBox` | 2 | 0 | 仅文件内部自用（无需导出） |
| Web | ESM | `remote/public/js/push.js:L18` | `subscription` | 0 | 0 | 死导出 / 可彻底移除 |
| Web | ESM | `remote/public/js/push.js:L22` | `deviceName` | 1 | 0 | 仅文件内部自用（无需导出） |
| Web | ESM | `remote/public/js/theme.js:L7` | `THEMES` | 1 | 0 | 仅文件内部自用（无需导出） |
| Web | ESM | `remote/public/js/theme.js:L34` | `currentScale` | 1 | 0 | 仅文件内部自用（无需导出） |
| Web | ESM | `remote/public/js/util.js:L3` | `$$` | 0 | 0 | 死导出 / 可彻底移除 |
| Web | ESM | `remote/public/js/wallpaper.js:L87` | `openSettings` | 0 | 0 | 死导出 / 可彻底移除 |
| Web | ESM | `remote/public/js/wm.js:L85` | `toggleMax` | 2 | 0 | 仅文件内部自用（无需导出） |

---

## 3. 超长文件（>500 行）与超长函数（>80 行）热点榜

### 3.1 超长文件榜（>500 行，共 22 个）

| 排名 | 子域 | 类型 | 行数 | 文件路径 |
| ---: | --- | --- | ---: | --- |
| 1 | Server | JS | **4389** | `remote/server/mesh.js` |
| 2 | Web | JS | **3044** | `remote/public/js/apps/projects.js` |
| 3 | Web | CSS | **1239** | `remote/public/css/projects.css` |
| 4 | Web | JS | **1087** | `remote/public/js/apps/infra.js` |
| 5 | Server | JS | **1017** | `remote/server/server.js` |
| 6 | Server | JS | **977** | `remote/server/infra.js` |
| 7 | Tools | JS | **912** | `tools/ame-mesh.js` |
| 8 | Agent/Headless | JS | **865** | `remote/agent/sugon-runner.js` |
| 9 | Server | JS | **839** | `remote/server/research/directories.js` |
| 10 | Web | JS | **764** | `remote/public/js/apps/skills-panel.js` |
| 11 | Server | JS | **694** | `remote/server/mesh-watchdog.js` |
| 12 | Server | JS | **680** | `remote/server/mesh-compute-queue.js` |
| 13 | Web | JS | **644** | `remote/public/js/apps/infra-compute.js` |
| 14 | Server | JS | **616** | `remote/server/fleet/index.js` |
| 15 | Agent/Headless | JS | **592** | `remote/agent/colab-runner.js` |
| 16 | Web | JS | **566** | `remote/public/js/apps/dashboard.js` |
| 17 | Server | JS | **565** | `remote/server/literature/index.js` |
| 18 | Server | JS | **559** | `remote/server/literature/kb-struct.js` |
| 19 | Server | JS | **547** | `remote/server/mesh-model-router.js` |
| 20 | Agent/Headless | JS | **535** | `remote/agent/session-scanner.js` |
| 21 | Web | JS | **521** | `remote/public/js/apps/opencode-base.js` |
| 22 | Pet(app) | JS | **503** | `app/renderer-rig.js` |

### 3.2 超长函数榜（>80 行，共 67 个）

| 排名 | 子域 | 行数 | 函数名 / 回调标识 | 位置 (`文件:起止行`) |
| ---: | --- | ---: | --- | --- |
| 1 | Pet(app) | **251** | `createRemoteControl` | `app/remote-control.js:L37-L287` |
| 2 | Server | **250** | `askAssistant` | `remote/server/research/directories.js:L585-L834` |
| 3 | Server | **237** | `createReview` | `remote/server/research/review.js:L18-L254` |
| 4 | Server | **232** | `createComputeQueue` | `remote/server/mesh-compute-queue.js:L38-L269` |
| 5 | Web | **228** | `createTopologyView` | `remote/public/js/apps/projects.js:L774-L1001` |
| 6 | Web | **193** | `panel` | `remote/public/js/apps/knowledge.js:L17-L209` |
| 7 | Server | **189** | `createResearch` | `remote/server/research/service.js:L10-L198` |
| 8 | Agent/Headless | **186** | `createFiles` | `remote/agent/files.js:L39-L224` |
| 9 | Server | **182** | `createFsCatalog` | `remote/server/fs-catalog.js:L54-L235` |
| 10 | Agent/Headless | **174** | `createProfiles` | `remote/agent/claude-profiles.js:L23-L196` |
| 11 | Server | **172** | `handle` | `remote/server/mesh.js:L3808-L3979` |
| 12 | Agent/Headless | **167** | `createPetClient` | `remote/agent/pet-client.js:L16-L182` |
| 13 | Server | **158** | `fromAgentRpc` | `remote/server/mesh.js:L4173-L4330` |
| 14 | Web | **151** | `createClippyWidget` | `remote/public/js/apps/clippy.js:L43-L193` |
| 15 | Server | **146** | `createDirectories` | `remote/server/research/directories.js:L155-L300` |
| 16 | Server | **146** | `createMemory` | `remote/server/vault/memory.js:L7-L152` |
| 17 | Server | **145** | `onAgentMessage` | `remote/server/server.js:L425-L569` |
| 18 | Tools | **143** | `runCli` | `tools/ame-mesh.js:L763-L905` |
| 19 | Pet(app) | **137** | `createPanelAndGestures` | `app/main-gestures.js:L7-L143` |
| 20 | Server | **136** | `tick` | `remote/server/mesh-watchdog.js:L153-L288` |
| 21 | Server | **135** | `openVault` | `remote/server/vault/database.js:L10-L144` |
| 22 | Server | **134** | `createVaultService` | `remote/server/vault/service.js:L7-L140` |
| 23 | Server | **130** | `createEmbedSearch` | `remote/server/embed/search.js:L68-L197` |
| 24 | Server | **127** | `<anonymous>` | `remote/server/server.js:L681-L807` |
| 25 | Web | **126** | `dialog` | `remote/public/js/apps/filedlg.js:L25-L150` |
| 26 | Server | **126** | `createMail` | `remote/server/mail/index.js:L30-L155` |
| 27 | Server | **124** | `openKbStruct` | `remote/server/literature/kb-struct.js:L164-L287` |
| 28 | Server | **124** | `createSearch` | `remote/server/summary/search.js:L27-L150` |
| 29 | Hooks/Installers | **123** | `onEvent` | `opencode-plugin/index.js:L258-L380` |
| 30 | Server | **123** | `enqueue` | `remote/server/mesh-compute-queue.js:L441-L563` |
| 31 | Server | **122** | `createResearchStore` | `remote/server/research/database.js:L7-L128` |
| 32 | Server | **119** | `fromAgentFs` | `remote/server/mesh.js:L3222-L3340` |
| 33 | Server | **112** | `handleBrowser` | `remote/server/infra.js:L795-L906` |
| 34 | Server | **109** | `evaluateMagpie` | `remote/server/mesh-model-router.js:L191-L299` |
| 35 | Server | **107** | `createFleet` | `remote/server/fleet/index.js:L49-L155` |
| 36 | Server | **107** | `snapshot` | `remote/server/infra.js:L495-L601` |
| 37 | Server | **106** | `manageTask` | `remote/server/mesh.js:L2284-L2389` |
| 38 | Server | **105** | `createHpcTools` | `remote/server/hpc/mcp.js:L131-L235` |
| 39 | Web | **101** | `panel` | `remote/public/js/apps/opencode-guide.js:L183-L283` |
| 40 | Server | **101** | `call` | `remote/server/hpc/mcp.js:L132-L232` |
| 41 | Server | **100** | `upsertNode` | `remote/server/mesh.js:L1488-L1587` |
| 42 | Web | **99** | `<anonymous>` | `remote/public/js/apps/filedlg.js:L26-L124` |
| 43 | Server | **99** | `handle` | `remote/server/research/service.js:L97-L195` |
| 44 | Web | **97** | `renderBoardTab` | `remote/public/js/apps/projects.js:L284-L380` |
| 45 | Server | **97** | `createInfra` | `remote/server/infra.js:L119-L215` |
| 46 | Server | **97** | `createAgentSocket` | `remote/server/literature/agent-socket.js:L43-L139` |
| 47 | Hooks/Installers | **96** | `handleEvent` | `agy-hook.js:L226-L321` |
| 48 | Agent/Headless | **96** | `apply` | `remote/agent/memory-sync.js:L141-L236` |
| 49 | Web | **96** | `panel` | `remote/public/js/apps/claude-apis.js:L5-L100` |
| 50 | Server | **96** | `seed` | `remote/server/research/review.js:L93-L188` |
| 51 | Web | **95** | `mountReader` | `remote/public/js/apps/lit-reader.js:L34-L128` |
| 52 | Agent/Headless | **94** | `createCollector` | `remote/agent/infra-probe.js:L131-L224` |
| 53 | Server | **94** | `createVision` | `remote/server/literature/vision.js:L58-L151` |
| 54 | Server | **93** | `createAi` | `remote/server/ai/index.js:L21-L113` |
| 55 | Server | **92** | `sanitizeReport` | `remote/server/infra.js:L232-L323` |
| 56 | Agent/Headless | **90** | `createArtifacts` | `remote/agent/artifacts.js:L31-L120` |
| 57 | Agent/Headless | **89** | `createComputeDispatcher` | `remote/agent/compute-dispatcher.js:L22-L110` |
| 58 | Web | **89** | `openWatchdogConfigDialog` | `remote/public/js/apps/projects.js:L2345-L2433` |
| 59 | Server | **88** | `createMesh` | `remote/server/mesh.js:L94-L181` |
| 60 | Server | **87** | `handle` | `remote/server/vault/service.js:L52-L138` |
| 61 | Agent/Headless | **86** | `createMemorySync` | `remote/agent/memory-sync.js:L37-L122` |
| 62 | Server | **85** | `diagnoseSugonFailure` | `remote/server/mesh-sugon-advisor.js:L121-L205` |
| 63 | Server | **85** | `createSummary` | `remote/server/summary/index.js:L36-L120` |
| 64 | Server | **84** | `createFsRelay` | `remote/server/fs-relay.js:L23-L106` |
| 65 | Tools | **84** | `createLitAsker` | `tools/lib/lit-ask.js:L14-L97` |
| 66 | Agent/Headless | **82** | `createSessionScanner` | `remote/agent/session-scanner.js:L45-L126` |
| 67 | Server | **82** | `normalize` | `remote/server/research/normalize.js:L27-L108` |

---

## 4. `remote/public/css/*.css` 与 `app/bubble.html` 硬编码 `#hex` 色值统计

### 4.1 按文件统计（区分业务规则硬编码 vs `--*` 变量定义）

| 文件路径 | 业务硬编码 `#hex` | `--*` 变量定义 `#hex` | 总出现次数 | 去重色值数 |
| --- | ---: | ---: | ---: | ---: |
| `remote/public/css/projects.css` | **285** | 0 | 285 | 97 |
| `remote/public/css/theme-win98.css` | **101** | 52 | 153 | 21 |
| `remote/public/css/infra.css` | **71** | 0 | 71 | 52 |
| `remote/public/css/control.css` | **52** | 0 | 52 | 33 |
| `remote/public/css/dash.css` | **43** | 0 | 43 | 38 |
| `app/bubble.html` | **40** | 0 | 40 | 28 |
| `remote/public/css/topo-overview.css` | **28** | 0 | 28 | 9 |
| `remote/public/css/magpie.css` | **22** | 0 | 22 | 10 |
| `remote/public/css/menu.css` | **14** | 0 | 14 | 6 |
| `remote/public/css/literature.css` | **11** | 0 | 11 | 7 |
| `remote/public/css/board.css` | **7** | 0 | 7 | 3 |
| `remote/public/css/todo.css` | **6** | 0 | 6 | 5 |
| `remote/public/css/desktop.css` | **3** | 24 | 27 | 19 |
| `remote/public/css/pdf.css` | **3** | 0 | 3 | 2 |
| `remote/public/css/reports.css` | **3** | 0 | 3 | 3 |
| `remote/public/css/todo-app.css` | **3** | 0 | 3 | 3 |
| `remote/public/css/theme-shades.css` | **2** | 67 | 69 | 59 |
| `remote/public/css/docx.css` | **1** | 0 | 1 | 1 |
| `remote/public/css/files.css` | **1** | 0 | 1 | 1 |
| `remote/public/css/office.css` | **1** | 0 | 1 | 1 |
| `remote/public/css/ppt.css` | **1** | 0 | 1 | 1 |
| `remote/public/css/calendar.css` | **0** | 0 | 0 | 0 |
| `remote/public/css/dash-agents.css` | **0** | 0 | 0 | 0 |
| `remote/public/css/mail.css` | **0** | 0 | 0 | 0 |
| `remote/public/css/notepad.css` | **0** | 0 | 0 | 0 |
| `remote/public/css/office-apps.css` | **0** | 0 | 0 | 0 |
| `remote/public/css/xlsx.css` | **0** | 0 | 0 | 0 |
| **合计** | **698** | **143** | **841** | **288** |

### 4.2 高频硬编码 `#hex` 色值 Top 30（按非变量硬编码次数降序）

| 排名 | 色值 | 业务硬编码次数 | `--*` 定义次数 | 涉及文件数 | 主要分布文件 |
| ---: | --- | ---: | ---: | ---: | --- |
| 1 | `#fff` | **71** | 15 | 17 | `app/bubble.html`, `remote/public/css/board.css`, `remote/public/css/control.css`, `remote/public/css/dash.css` 等17个 |
| 2 | `#808080` | **51** | 7 | 6 | `remote/public/css/infra.css`, `remote/public/css/magpie.css`, `remote/public/css/menu.css`, `remote/public/css/projects.css` 等6个 |
| 3 | `#c0c0c0` | **40** | 11 | 8 | `remote/public/css/infra.css`, `remote/public/css/literature.css`, `remote/public/css/magpie.css`, `remote/public/css/menu.css` 等8个 |
| 4 | `#000` | **40** | 1 | 9 | `remote/public/css/control.css`, `remote/public/css/dash.css`, `remote/public/css/literature.css`, `remote/public/css/magpie.css` 等9个 |
| 5 | `#000080` | **33** | 3 | 9 | `remote/public/css/dash.css`, `remote/public/css/infra.css`, `remote/public/css/literature.css`, `remote/public/css/magpie.css` 等9个 |
| 6 | `#d90429` | **15** | 0 | 4 | `remote/public/css/dash.css`, `remote/public/css/infra.css`, `remote/public/css/projects.css`, `remote/public/css/topo-overview.css` |
| 7 | `#dfdfdf` | **12** | 4 | 4 | `remote/public/css/control.css`, `remote/public/css/infra.css`, `remote/public/css/projects.css`, `remote/public/css/theme-win98.css` |
| 8 | `#1b8a3d` | **12** | 0 | 3 | `remote/public/css/infra.css`, `remote/public/css/projects.css`, `remote/public/css/topo-overview.css` |
| 9 | `#e67700` | **12** | 0 | 3 | `remote/public/css/infra.css`, `remote/public/css/projects.css`, `remote/public/css/topo-overview.css` |
| 10 | `#c9184a` | **10** | 0 | 3 | `remote/public/css/infra.css`, `remote/public/css/magpie.css`, `remote/public/css/projects.css` |
| 11 | `#0284c7` | **8** | 0 | 2 | `remote/public/css/projects.css`, `remote/public/css/topo-overview.css` |
| 12 | `#2d8a3e` | **8** | 0 | 1 | `remote/public/css/projects.css` |
| 13 | `#c43e00` | **8** | 0 | 1 | `remote/public/css/projects.css` |
| 14 | `#0369a1` | **7** | 0 | 2 | `remote/public/css/projects.css`, `remote/public/css/topo-overview.css` |
| 15 | `#1084d0` | **7** | 0 | 4 | `remote/public/css/magpie.css`, `remote/public/css/menu.css`, `remote/public/css/theme-win98.css`, `remote/public/css/todo.css` |
| 16 | `#111` | **7** | 0 | 2 | `remote/public/css/infra.css`, `remote/public/css/projects.css` |
| 17 | `#b57c00` | **7** | 0 | 1 | `remote/public/css/projects.css` |
| 18 | `#ffd166` | **7** | 0 | 1 | `remote/public/css/projects.css` |
| 19 | `#fff3cd` | **7** | 0 | 2 | `remote/public/css/infra.css`, `remote/public/css/projects.css` |
| 20 | `#666` | **6** | 0 | 3 | `remote/public/css/infra.css`, `remote/public/css/literature.css`, `remote/public/css/projects.css` |
| 21 | `#6b46c1` | **6** | 0 | 2 | `remote/public/css/dash.css`, `remote/public/css/projects.css` |
| 22 | `#0b4f19` | **5** | 0 | 1 | `remote/public/css/projects.css` |
| 23 | `#15996b` | **5** | 0 | 1 | `remote/public/css/control.css` |
| 24 | `#2f6fed` | **5** | 0 | 1 | `remote/public/css/control.css` |
| 25 | `#3a2000` | **5** | 0 | 1 | `remote/public/css/projects.css` |
| 26 | `#8a94a6` | **5** | 0 | 2 | `remote/public/css/projects.css`, `remote/public/css/topo-overview.css` |
| 27 | `#c7f9cc` | **5** | 0 | 1 | `remote/public/css/projects.css` |
| 28 | `#e0f2fe` | **5** | 0 | 1 | `remote/public/css/projects.css` |
| 29 | `#ffffcc` | **5** | 0 | 1 | `remote/public/css/projects.css` |
| 30 | `#4d23cf` | **4** | 2 | 3 | `remote/public/css/board.css`, `remote/public/css/desktop.css`, `remote/public/css/theme-shades.css` |

