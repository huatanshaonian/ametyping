# 前端 Web JS 重构与 Bug 修复报告 (`02-web-js-refactor.md`)

> 对应任务：`task_b336125592` (`worker-web-refactor`)  
> 严格约束：零 CSS / HTML / DOM 结构 / 类名 / 桌面图标 / 菜单入口改动；所有新增模块均遵守 `remote/server/server.js` 第 97 行 `STATIC` 正则单层扁平命名规范（`/js/apps/[A-Za-z0-9][A-Za-z0-9._-]*\.js`）。

---

## 1. 巨石模块扁平化拆分

### 1.1 `remote/public/js/apps/projects.js`（3,044 行 → 225 行 + 6 个 `proj-*.js`）

对外导出签名 `export function open(projectId = null)` 保持 100% 不变，按子视图与职责拆分为 7 个高内聚扁平 ES Modules：

| 模块路径 | 职责说明 |
| --- | --- |
| `remote/public/js/apps/projects.js` | 窗口生命周期（`open`/`mount`/`destroy`）、左侧项目目录、主头部与 Tab 切换、全局 `mesh`/`catalog`/`net` 订阅协调 |
| `remote/public/js/apps/proj-const.js` | 共享常量（`ROLE_NAMES`、`REVIEW_NAMES`、`TASK_STATUSES`、`BOARD_KINDS`、`BOARD_KIND_LABELS`、`TOPO_EDGE_TYPE_NAMES`）与纯解析函数（`renderPostBody`、`formatAuditMessage`、`matchNodeByToken`、`extractMentionTokens`、`roleOriginOf`） |
| `remote/public/js/apps/proj-board.js` | 「黑板与任务」Tab（`createBoardTab`、`openNewTaskDialog`）：频道栏、共享任务板、黑板流筛选与 `#seq` 跳转、`@mention` 快捷点名 |
| `remote/public/js/apps/proj-topo.js` | 「协同拓扑与契约」Tab（`createTopologyView`）：椭圆/分层药丸布局、二次曲线 SVG 连线、黑板 `@` 交互回放条、黑板看板流与分组详情泳道 |
| `remote/public/js/apps/proj-roles.js` | 「角色与模型池」Tab（`createRolesTab`）：角色 `.md` 模板库编辑/新建/恢复默认、模型能力池候选编排、健康度与按需余额探测 |
| `remote/public/js/apps/proj-panels.js` | 节点详情卡片（`renderNodeCard` 与静态边断开）、跨机工作区与 VFS 结构树（`renderVfsTab`）、大文件摆渡（`renderTransfersTab`）、目录触发器与看门狗事件流水（`renderEventsTab`） |
| `remote/public/js/apps/proj-dialogs.js` | 全部项目级弹窗：`openWatchdogConfigDialog`、`openAddTriggerDialog`、`openSpawnDialog`、`openBindSessionDialog`、`openLinkDialog`、`openSendDialog`、`openAddWorkspaceDialog`、`openManualWorkspaceDialog`、`openNewTransferDialog` |

### 1.2 `remote/public/js/apps/infra.js`（1,087 行 → 215 行 + 3 个 `infra-*.js`）

对外导出签名 `export function open(initialNodeId)` 保持 100% 不变，拆分为 4 个扁平 ES Modules（复用既有 `infra-compute.js`）：

| 模块路径 | 职责说明 |
| --- | --- |
| `remote/public/js/apps/infra.js` | 窗口生命周期（`open`/`mount`/`destroy`）、状态拉取与刷新、远程控制/关注/降级动作、顶栏统计与 Tab 切换、心跳/ResizeObserver/WebSocket 清理 |
| `remote/public/js/apps/infra-topo.js` | 节点分层排序、节点卡片渲染（`renderNodeCard`）、三列拓扑排版（`renderTopology`）及横/竖自适应 SVG 链路走廊与徽章避让绘制（`drawSvgLinks`） |
| `remote/public/js/apps/infra-detail.js` | 右侧详情面板（`renderDetailPane`：KPI 网格、Sing-box 代理横幅、常驻服务列表、Docker 容器列表与升级状态、关联链路）与事件流水视图（`renderEventsView`） |
| `remote/public/js/apps/infra-dialogs.js` | 设备节点弹窗（`openNodeDialog`）与互联链路弹窗（`openLinkDialog`） |

---

## 2. 公共辅助收敛去重与死代码清理

对照全仓静态审计报告 `D:/ametyping-refactor/docs/overhaul/shots-baseline/00-codebase-audit.md`（#7 楼）：

### 2.1 公共辅助提取与收敛

| 公共位置 | 新增/增强函数 | 收敛消除的重复实现 |
| --- | --- | --- |
| `remote/public/js/util.js` | `ago(t)`（兼容数值时间戳与 ISO 字符串） | 移除 `fleet-panel.js`、`mcp-panel.js` 重复手写的 `ago` |
| `remote/public/js/util.js` | `mdhm(t)`、`hhmm(t)` | 移除 `google.js`、`mail-accounts.js` 重复的 `when(t)`；移除 `lit-pdfq.js` 重复的 `hm(t)` |
| `remote/public/js/util.js` | `fmtBytes(b)`、`fmtUptime(sec)`、`formatResetAt(resetAt)` | 统一 `infra-detail.js` 与 `proj-roles.js` 格式化辅助 |
| `remote/public/js/util.js` | `SVG_NS`、`svgEl(tag, attrs, ...kids)` | 消除 `infra.js` (`svgNode`) 与 `projects.js` (`svgEl`) 两套 SVG 节点构造器 |
| `remote/public/js/util.js` | `codeBlock(title, text, btnText)` | 消除 `mcp-panel.js` 与 `opencode-guide.js` 完全克隆的代码复制块（审计报告 Cluster #8） |
| `remote/public/js/net.js` | `getJson(url, fallback)`（含 401 跳 `/login` 与异常兜底） | 收敛 `infra.js`、`infra-compute.js`、`fleet-panel.js`、`mcp-panel.js`、`skills-panel.js`、`mail-accounts.js` 重复的 `fetch().then(r=>r.json())` 与 `fetchJson` |
| `remote/public/js/net.js` | 直接复用 `net.post()` 内置 TOTP 重试 | 移除 `fleet-panel.js` (`post`) 与 `mcp-panel.js` (`postFleet`) 冗余的二次 `need === 'totp'` 包装及多余 `askCode` 导入（审计报告 Cluster #12） |
| `remote/public/js/dialog.js` | 统一 `confirmBox` | 将 `fleet-panel.js` 与 `skills-panel.js` 中残留的浏览器原生 `confirm()` 替换为 Windose 风格 `confirmBox()` |

### 2.2 零引用死代码与未用导入清理

- `remote/public/js/util.js`：移除零引用死导出 `$$`（审计报告 Section 2：`prodRefs=0, testRefs=0`）。
- `remote/public/js/push.js`：移除零引用死导出 `subscription`（`internal=0, prodRefs=0, testRefs=0`），将仅内部使用的 `deviceName` 降级为文件私有函数。
- `remote/public/js/wallpaper.js`：移除零引用死导出 `openSettings`（`prodRefs=0, testRefs=0`）。
- `remote/public/js/apps/projects.js`：移除未使用的死导入 `import { open as openResearchPilots } from './research-pilots.js'`。
- `remote/public/js/apps/skills-panel.js`：移除未使用的 `import { askCode } from '../gate.js'`。

---

## 3. 真实 Bug 与泄漏/竞态修复清单

| # | 位置 | 类别 | 根因说明 | 修复方式 |
| --- | --- | --- | --- | --- |
| 1 | `apps/proj-panels.js`（原 `projects.js:2119`） | **功能 Bug** | 「归档退役」按钮调用 `confirmBox({ title, text, okText, cancelText })`，但 `confirmBox(text, opts)` 第一个参数应为字符串且选项名为 `ok`/`cancel`，导致弹窗正文显示 `[object Object]` 且标题/按钮文案失效 | 修正为 `confirmBox(text, { title, ok, cancel })` |
| 2 | `apps/dash-agents.js` + `apps/dashboard.js` | **定时器泄漏** | `createAgents()` 每次打开糖糖看板都会启动 `setInterval(..., 15e3)` 但未暴露清理函数，窗口关闭后定时器与闭包永久驻留内存 | `dash-agents.js` 返回 `destroy() { clearInterval(timer); }`，并在 `dashboard.js` `destroy()` 中调用（同时清理 `draftT` 防抖定时器） |
| 3 | `apps/skills-panel.js` | **WebSocket 订阅泄漏** | `createFleetView()` 懒挂载 `fleetPanel()`（其内部注册了 `net.on('fleet', ...)`），但 `createFleetView()` 与 `skills-panel.js` 的 `panel()` 均未返回 `destroy()`，导致切走控制面板页或关闭控制面板后 `fleet` 监听器永久泄漏 | 为 `createFleetView()`、`createMdLibraryView()`、`createMachinesView()` 及 `panel()` 补全 `destroy()`，关闭时解绑 `fleet` 订阅 |
| 4 | `js/backnav.js` + `apps/dashboard.js` | **监听器 / Observer 泄漏** | (a) `backnav.step()` 未返回取消注册函数，每次打开/关闭看板都会往全局 `steps` 数组永久追加闭包；(b) `backnav.pane()` 在节点卸载时仅 `mo.disconnect()` 而漏调 `ro.disconnect()` | `step()` 返回解绑函数并在 `dashboard.js` `destroy()` 调用；`pane()` 在卸载清理时同步 `ro.disconnect()` |
| 5 | `apps/google.js` | **定时器泄漏 & 竞态** | `panel()` 未暴露 `destroy()`，`tasks` 8s 延迟刷新与 `backfill` 2s 轮询 `setTimeout` 在页面切换后未清理，且并发 `render()` 无序号保护 | 追踪 `tasksTimer`/`bfTimer` 并在 `destroy()` 清理；增加 `destroyed` 与 `renderSeq` 竞态保护 |
| 6 | `apps/infra.js` + `apps/infra-compute.js` | **异步覆盖竞态** | `infra` 与 `sessions` WS 事件高频触发 `fetchState()` 时，慢返回的旧响应会覆盖新状态；`requestAnimationFrame` 回调与 `computeView.refresh()` 在窗口关闭后仍可能写入已卸载 DOM | 增加 `fetchSeq`/`refreshSeq` 单调序号与 `destroyed` 守卫；`infra-compute.js` 补全 `destroy()` 并由 `infra.js` 调用 |
| 7 | `apps/proj-topo.js` + `apps/proj-roles.js` | **异步覆盖竞态** | `loadBoardHistory()`、`loadRoles()`、`loadPools()` 在快速切换项目或重复刷新时无请求序号校验，慢响应会覆盖最新状态 | 增加 `loadToken` / `rolesLoadToken` / `poolsLoadToken` 序号守卫与 `destroyed` 检查 |
| 8 | `apps/fleet-panel.js` + `apps/mcp-panel.js` + `apps/mail-accounts.js` | **异步覆盖竞态** | 面板切换/关闭后进行中的 `fetch` 仍会回写 DOM，且高频 WS 推送可能引起乱序覆盖 | 统一补充 `destroyed` 标志与 `loadSeq` 序号守卫，完善 `destroy()` |
| 9 | `apps/infra-topo.js` (`drawSvgLinks`) | **标识符遮蔽崩溃** | 拆分时首参命名为 `svgEl`（接收 `<svg>` 容器节点），遮蔽了顶层 `import { svgEl } from '../util.js'` 辅助函数，导致存在互联链路时抛出 `TypeError: svgEl is not a function` | 将容器形参重命名为 `svgCanvas`，消除与 `svgEl()` 构造器的同名遮蔽 |
| 10 | `apps/proj-panels.js` + `js/mesh.js` | **功能 Bug** | 「触发器与看门狗」Tab 删除目录触发器按钮传入 `{ op: 'delete' }`，而 `mesh.trigger()` 仅判断 `d.op === 'remove'` 才路由至 `/api/mesh/trigger-remove`，导致点击删除误走 `trigger-upsert` 无法删除触发器 | `proj-panels.js` 改为 `op: 'remove'`，同时 `mesh.js` 兼容 `op === 'remove' \|\| op === 'delete'` |

---

## 4. 验证记录

- `node remote/test/check-static.js`：全量 214 CJS + 149 ESM 语法、V8 模块链接与命名空间导入校验 100% 通过。
- `STATIC` 正则合规核对：全部 `remote/public/js/*.js` 与 `remote/public/js/apps/*.js` 100% 匹配 `server.js` 第 97 行静态白名单正则，无任何子目录嵌套；全模块导入符号零参数/局部变量同名遮蔽。
- `node remote/test/ui-infra.js`：退出码 0，8/8 断言全部 PASS，`no page errors`。
- `projects` 全 6 个 Tab + 传输摆渡 + 全弹窗 + `infra` 多链路拓扑与算力 Tab 真实无头 Chrome（CDP）端到端验证：依次点击切换「研究与计算」「黑板与任务」「协同拓扑与契约」「角色与模型池」「跨机目录与结构树」「⚡ 触发器与看门狗」及「传输/摆渡」，实测 SVG 链路与 `@mention` 动态边绘制、触发器删除与全部子弹窗开闭，25/25 断言 PASS，零 `Runtime.exceptionThrown`、零 `console.error`。
- `node remote/test/ui-control.js`：全程 `no page errors`（零 JS 异常与控制台错误；脚本内 2 处历史遗留断言因 `90a1057` 新增第 4 个 `windose-hpc` MCP 卡片及 Windows 检出 `opencode-magpie.json` CRLF 换行差异而未更新，位于 `remote/test/` 边界外未改动）。
