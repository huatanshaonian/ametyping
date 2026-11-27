# 05 · Windose 全栈 GUI 美术风格统一方案（视觉会诊 + Design Tokens v2）

> 任务 `task_acd262145d` · 节点 `designer-opus-gui` · 2026-11-28 · 基线 commit `3c0a42b`
> 本文只做诊断和规范，**没有改任何业务 CSS/HTML/JS**。所有结论都来自无头 Chrome 的真实渲染截图和 `remote/public/css/*.css` 源码统计。

**截图根目录**：`D:/ametyping-refactor/docs/overhaul/shots-baseline/`（已被 git exclude 排除，不进提交）。下文图片用相对路径 `shots-baseline/xxx.png` 嵌入，在主检出 `D:/ametyping-refactor/docs/overhaul/` 下打开即可显示；每条问题后面同时写出绝对路径。

**复现**：

```bash
node remote/test/overhaul-gui-shots.js      # 隔离端口 web 18910 / CDP 9441 / 假 Magpie 18911，约 5.5 分钟
# AME_SHOTS_OUT=<目录> 改输出目录；AME_W98_ICONS=<目录> 指定 Win98 图标库；CHROME=<路径> 指定 Chrome
```

同目录的 `manifest.json` 逐张记录了截图内容、失败步骤和页面报错。

---

## 0. 结论先行（给拍板用）

1. **割裂的根源不在"Win98 和现代扁平混搭"，而在内容层绕过了令牌。** 外壳（9-slice 窗口框、任务栏、开始菜单、像素图标）这一层已经统一，并且能随色调切换。问题出在窗口内部：801 处硬编码 hex、220 种不同色值，这一层不认令牌。`projects.css`（285 处）和 `infra.css`（71 处）把 Bootstrap/Tailwind 色板（`#fff3cd` `#0369a1` `#d97706`）和 Win98 灰（`#808080` `#dfdfdf` `#000080`）直接写死在粉色 Windose 里。
2. **最严重的缺陷出在非默认色调下。** 在"深夜"色调里，算力面板是白底配浅色字，文字对比度只有 **1.20:1**，机器名、GPU 名、Colab 标题都看不见（`72-night-infra-compute.png`）；拓扑图里的 master 节点和黑板流卡片同样变成"白色孤岛"。"豆沙绿"和"沙漠"色调下，这些区块也保持白色。另外要更正一个说法：**夜灯不会造成冷暖打架**。夜灯是整页统一的 `filter`，所有颜色一起变暖；真正打架的是这些不跟随色调的硬编码色块。
3. **字体糊和"拥挤感"同源**：PixelMplus12 是 12px 网格的像素字体，但 CSS 里用了 21 种字号，非整数字号（11.5px 104 处、12.5px 52 处、10.5px 22 处）被抗锯齿糊成灰团，`reports.css`、`notepad.css` 等地方又混用了 YaHei、Consolas、SimSun。
4. **布局层级 bug**：`.ap-widget.urgent` 是 `position:fixed; z-index:9500`（`magpie.css:33`），"待介入"挂件压在所有窗口和网上邻居侧栏上面，几乎每张桌面截图都能看到；在手机上，Clippy 压住窗口内容。
5. **建议的统一方向**（第 2 节详述）用一句话概括：**"外壳像素化、内容只认令牌、立体只给可操作件、圆角归零、状态色收敛为 5 族 × 3 档"**。落地顺序是 M1 令牌层 → M2 projects/infra 换令牌 → M3 组件化 → M4 图标与桌宠。每一步都用本脚本重拍、和基线对比来验收。

需要用户拍板的 4 个决定见第 9 节。

---

## 1. 采样覆盖与说明

| 维度 | 覆盖 | 张数 |
|---|---|---|
| 桌面 | 启动态（看板自动打开）、清空窗口、开始菜单 | 3 |
| 核心窗口 | 看板（含权限卡片）、项目管理 6 个页签、网络与设备（拓扑/节点详情/NAS 详情/算力）、文献 5 个页签、记忆与存档、工作日报、重要计划、画板、邮件、日历、我的电脑、Magpie、记事本；13 个应用各有默认尺寸和最大化两版 | 41 |
| 控制面板 | 首页、显示属性、AI 模型、MCP、电脑、通知、Skill 与协同 5 个页签 | 11 |
| 外观/色调 | Win98 标准、Windose 深夜、Windose 夜灯 70%、Win98 豆沙绿、Win98 夜灯 70%；每组 7 张（桌面/黑板/拓扑/网络/算力/看板/控制面板） | 35 |
| 手机 390×844 | 桌面、开始菜单、网上邻居、看板、项目管理（两张）、网络与设备、文献、控制面板 | 9 |
| 桌宠气泡 | 日志列表、权限卡、提问卡、常驻对话、折叠条 | 5 |
| 图标 | 一图多用的现用图标 vs Win98 图标库候选（对比表） | 1 |

**模拟数据**：3 台在线电脑由假 agent socket 推送（会话状态有进行中、等确认、提问、完成），另有 2 台登记但离线；GPU 算力探针（A6000×2 / 3090 / 4070）；6 份 infra 报告（工作站、NAS、AWS、OpenWrt，含容器升级回退和服务停止）；AmeMesh 项目 1 个（5 个节点、5 个里程碑任务、5 条黑板帖、1 个 GPU 作业）；日报 2 份和周报 1 份；4 条计划；4 封邮件；文献模块沿用 `ui-literature.js` 的假 Zotero 和假文献源，跑完了画像和当日推送。

**采样限制**（不影响风格结论）：邮件服务器故意不可达，所以邮件窗口带一条红色错误提示；Magpie 额度的模拟数据格式和真实网关不一致，显示为"额度未知"；拓扑页没有找到"切换成图"的按钮，所以没有 23b 这张图。

---

## 2. 核心审美命题与设计原则

**命题**：既要守住 Windose 98 的复古像素灵魂（9-slice 粉青窗口框、像素图标、深蓝/靛紫标题、立体斜面），又要承载拓扑、仪表、文献阅读、代码块这类高密度信息。

现状为什么割裂：截图里"一半是 Win98 灰框，一半是现代圆角灰白卡片"，并不是两种风格在打架，而是**第三种来源**（各模块开发时顺手写的 Bootstrap/Tailwind/Material 色值和圆角）插进了内容层。Win98 本身就有一套完整的信息密集型语汇，下面这些原则都沿用它：

| # | 原则 | Win98 原型 | 现状反例 |
|---|---|---|---|
| P1 | **外壳像素化，内容只认令牌**：窗口框、任务栏、开始菜单、桌面图标保留位图质感；窗口内部的 CSS 一律不出现 hex 和 rgb 字面值 | 系统配色方案（Display Properties › Appearance）只改一组系统颜色，全部控件跟着变 | `projects.css` 285 处、`infra.css` 71 处 hex |
| P2 | **立体只给可操作件**：按钮、页签、输入框（凹槽）用 bevel；信息容器用"分组框"，即 1px 蚀刻线加标题，不加阴影、不填色 | Group Box / 属性页 | `.inf-comp-card` 灰底、`.pm-feed-item` 白底、主题文件以外 `box-shadow` 82 处，其中有发光阴影 `0 0 5px` |
| P3 | **圆角归零**：只有 ≤8px 的状态圆点允许 `50%` | Win98 没有圆角 | `.pm-gnode` 13px 胶囊、`projects.css` 9/7.5/6/4px |
| P4 | **状态色收敛为 5 族 × 3 档**（ok/warn/bad/info/idle × 前景/底色/描边），随色调切换 | 系统只有一个"警告黄"和一个"错误红" | 5 种红、7 种绿、6 种橙、4 种蓝 |
| P5 | **像素字只用整倍字号**：UI 文字 12/24px（PixelMplus12），辅助文字 10px（PixelMplus10），长文阅读单独用矢量"阅读体" | 系统字体 8pt MS Sans Serif，只用一个字号 | 21 种字号，非整数字号 180 处以上 |
| P6 | **高密度靠"表格 + 等宽对齐 + 细线分隔"，不靠卡片堆叠** | 详细信息视图（ListView Report） | 黑板、任务板、算力队列都是"卡片里套徽章再套卡片" |
| P7 | **层级只有 4 层**：桌面 → 窗口 → 浮层（菜单/对话框）→ 系统提示（托盘气泡）。挂件属于桌面层，不能压在窗口上面 | 托盘气泡从任务栏冒出 | `.ap-widget.urgent` z-index 9500 |

![默认外观：粉青外壳是统一的，窗口内容层割裂](shots-baseline/23-projects-topo.png)

---

## 3. 全局问题（跨页面，按严重度排序）

| 级别 | 编号 | 问题 | 截图证据 | 根因（源码位置） |
|---|---|---|---|---|
| 🔴 严重 | G1 | **深夜色调下出现白底白字**：算力面板、拓扑 master 节点、黑板流卡片、待介入告警卡在暗色窗口里是白色孤岛，文字对比度 1.12~1.20:1，等于看不见 | `D:/ametyping-refactor/docs/overhaul/shots-baseline/72-night-infra-compute.png`<br>`D:/ametyping-refactor/docs/overhaul/shots-baseline/72-night-projects-topo.png`<br>`D:/ametyping-refactor/docs/overhaul/shots-baseline/72-night-desktop.png` | `infra.css:113` `.inf-comp-left/right{background:#fff}`；`infra.css:110` 用了未定义的 `var(--win-bg,#c0c0c0)`；`projects.css:1115` `.pm-feed-item{background:#fafafa}`、`:1131` `color:#222`；`projects.css:1193` `.pm-gnode.role-master{background:#f4f7ff}` |
| 🔴 严重 | G2 | **"待介入"挂件压住窗口和网上邻居**：最大化窗口的右上角、网上邻居的电脑列表一直被遮住 | `D:/ametyping-refactor/docs/overhaul/shots-baseline/10-dashboard-max.png`<br>`D:/ametyping-refactor/docs/overhaul/shots-baseline/02-desktop-clean.png` | `magpie.css:33` `.ap-widget.urgent{position:fixed;z-index:9500}` |
| 🟠 高 | G3 | **色板失控**：去掉主题文件后仍有 220 种 hex；红色系 `#d90429 #c9184a #b00020 #800f2f #dc3545`，绿色系 `#1b8a3d #2d8a3e #2b8a3e #157347 #0b4f19 #15996b #16a34a`，蓝色系 `#0369a1 #0284c7 #2f6fed #1d6fd8` 互不相同 | `D:/ametyping-refactor/docs/overhaul/shots-baseline/30-infra-topo-max.png`（满屏纯红）<br>`D:/ametyping-refactor/docs/overhaul/shots-baseline/22-projects-board.png`（黄/绿/粉红状态块） | 见附录 A 统计 |
| 🟠 高 | G4 | **Win98 灰写死在 Windose 粉里**：`#808080/#dfdfdf/#000080` 在 projects.css 出现 51 次，粉色外观下出现灰色蚀刻边框和藏青标题 | `D:/ametyping-refactor/docs/overhaul/shots-baseline/32-infra-compute.png`（藏青小标题、灰色内凹框）<br>`D:/ametyping-refactor/docs/overhaul/shots-baseline/21-projects-research.png` | `projects.css:454/470/490/516/545`、`infra.css:111/114` |
| 🟠 高 | G5 | **像素字发糊、字体混杂**：11.5/12.5/10.5px 让 PixelMplus 抗锯齿成灰团；路径用 SimSun 衬线等宽，日报和邮件正文用 YaHei，看板 Markdown 表格没有渲染 | `D:/ametyping-refactor/docs/overhaul/shots-baseline/21-projects-research.png`（`D:/ametyping-refactor` 衬线体）<br>`D:/ametyping-refactor/docs/overhaul/shots-baseline/51-reports-max.png` | 字号分布见附录 A；`notepad.css:21` SimSun |
| 🟠 高 | G6 | **手机端页签逐字竖排**：项目管理 6 个页签被挤成每行一个字，第 6 个被裁掉；网络与设备的"关注服务/编辑节点"也逐字换行；Clippy 压住每个窗口的右下角 | `D:/ametyping-refactor/docs/overhaul/shots-baseline/84-phone-projects.png`<br>`D:/ametyping-refactor/docs/overhaul/shots-baseline/85-phone-infra.png`<br>`D:/ametyping-refactor/docs/overhaul/shots-baseline/86-phone-literature.png` | `.pm-tab` 缺少 `white-space:nowrap` 和横向滚动；Clippy 没有窄屏规则 |
| 🟡 中 | G7 | **Win98 外观下桌面图标文字看不清**：切到 Windows 标准后壁纸仍是粉色"ぴんく"，白字黑描边的标签在浅粉上对比度只有 1.23:1 | `D:/ametyping-refactor/docs/overhaul/shots-baseline/70-win98-desktop.png`<br>`D:/ametyping-refactor/docs/overhaul/shots-baseline/76-win98-green-desktop.png` | 壁纸选择和外观相互独立，win98 外观没有默认壁纸 |
| 🟡 中 | G8 | **圆角胶囊混入**：拓扑节点是 13px 胶囊，关系图图例和节点 hover 用的是 `#1d6fd8` 现代蓝 | `D:/ametyping-refactor/docs/overhaul/shots-baseline/23-projects-topo.png`（底部"协同关系图"） | `projects.css:1189-1190`、`:256/291/399/425` |
| 🟡 中 | G9 | **状态语义错位**："完成"在看板和气泡里都用 `--bad`（品红），读起来像出错了 | `D:/ametyping-refactor/docs/overhaul/shots-baseline/10-dashboard-max.png`（"完成 · CEM_Results"）<br>`D:/ametyping-refactor/docs/overhaul/shots-baseline/90-bubble-log.png` | 看板列表状态色；`bubble.html` `.st.done{color:rgb(180,50,110)}` |
| 🟡 中 | G10 | **现有令牌的对比度不达标**（小字要求 ≥4.5:1，背景 `#fff8ff`）：`--muted` 约 4.16、`--faint` 约 2.82、`--warn` 4.10、`--ok-text` 3.86 | 各页的灰色说明文字、"进行中"绿字 | `desktop.css:8-12` |
| 🟢 低 | G11 | **缺资源 / 未定义令牌**：`icons/clock-16.png` 404（每次打开项目管理都报错，页签里是一个破图标）；`app/assets/dialog/zpix.ttf` 在所有检出里都不存在；`--win-bg` `--accent` 没有定义 | `D:/ametyping-refactor/docs/overhaul/shots-baseline/26-projects-events.png`；`manifest.json` 中的 pageErrors | `projects.js:169`；`bubble.html:9` |
| 🟢 低 | G12 | **"null" 文字泄漏**（功能缺陷，顺带记录）：看板分组头右侧、项目"跨机目录"页底部、邮件正文顶部都直接显示 `null` | `D:/ametyping-refactor/docs/overhaul/shots-baseline/10-dashboard-max.png`<br>`D:/ametyping-refactor/docs/overhaul/shots-baseline/25-projects-vfs.png`<br>`D:/ametyping-refactor/docs/overhaul/shots-baseline/54-mail-max.png` | JS 渲染时把 `null` 转成了字符串（不在本阶段范围） |

![深夜色调：算力面板白底、机器名不可见](shots-baseline/72-night-infra-compute.png)

![深夜色调：拓扑 master 节点、黑板流、待介入告警卡都成了白色孤岛](shots-baseline/72-night-projects-topo.png)

---

## 4. 逐页视觉问题清单

### 4.1 桌面、开始菜单、挂件、任务栏

| 截图 | 不和谐之处 | 处理 |
|---|---|---|
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/02-desktop-clean.png` | ① 右上"待介入"挂件的标题栏是**红橙渐变**，是全站唯一一个不是粉/青/藏青的标题栏；② 它盖住了网上邻居标题和电脑列表；③ 计划挂件、Magpie 挂件、待介入挂件三者宽度和边框不一致；④ 图标列底部有两条来源不明的竖线残影（x≈145/235，在所有桌面截图里都有，待开发确认） | 挂件统一成"便签"组件（第 6.7 节），收进 `#desktop` 内部的挂件列；紧急态改为任务栏托盘闪烁加气泡 |
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/03-desktop-startmenu.png` | 开始菜单 20 项平铺，"记事本"和"Skill 管理"图标相同 | 见第 7 节和 04 方案 4-A |
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/01-desktop-boot.png` | `#mark` 机器名用 22px，像素字发虚 | 改成 24px |
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/70-win98-desktop.png` | Win98 外观仍用粉色壁纸，图标标签看不清；"待介入"红色标题和 Win98 藏青标题并存 | win98 外观在用户没选过壁纸时默认用"Windows 青色"；挂件标题统一用 `--title` 令牌 |

### 4.2 糖糖看板

| 截图 | 不和谐之处 | 处理 |
|---|---|---|
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/10-dashboard-max.png` | ① 分组头右侧显示 `null`；② 看板没有渲染 Markdown 表格，竖线原样露出；③ "完成"用了品红；④ 会话卡片之间用虚线分隔，分组头又是实色带，节奏不统一 | 状态色按第 5.3 节映射；分组头改成 Win98 的"列表分组标题" |
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/11-dashboard-permission.png` | 权限卡是**橙色粗边框**，和气泡里的权限卡（靛紫 2px 边框）不是一个家族；"允许/总是允许/拒绝"三个按钮的配色各不相同 | 统一成"确认卡"组件：`--warn-line` 描边，主按钮 `--fill`，拒绝按钮用 `--bad` 描边 |
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/72-night-dashboard.png` | 深夜下基本正常：看板的 43 处 hex 里有 26 处是 provider 品牌色，表面和文字都已经走令牌，可以作为其余模块的样板 | — |

### 4.3 项目管理（projects.css，285 处 hex）

| 截图 | 不和谐之处 | 处理 |
|---|---|---|
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/22-projects-board.png` | ① 任务计数用"黄/绿/粉红"Bootstrap 色块（`#fff3cd #c7f9cc #ffccd5`）；② 任务 ID 灰框、前置依赖黄框、边界路径灰框，三种框并存；③ 黑板帖"#1 任务"的蓝色左边条和"帖子"灰标签两套写法；④ 6 个页签里有 4 个图标相同，还有 1 个是破图 | 计数改成状态栏式的"文字 + 圆点"；ID 和路径统一为 `.chip.mono`；帖子类型只用左边条颜色区分 |
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/23-projects-topo.png` | ① "需要你处理"是**橙色告警条**（`#e67700`），工作线卡片的左边条是橙/靛/灰；② "●●●"三色圆点像红绿灯，含义要靠猜；③ 底部协同关系图是**圆角胶囊节点加现代蓝 hover**，和上面的方角卡片完全两套语言 | 告警条统一为 6.6 节的"信息栏"；节点改为方角、2px 描边，角色色按 5.4 节；三色圆点改为带文字的进度 `3/5` |
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/24-projects-roles.png` | ① 混入英文"Section A ·"；② 模型池每行 6 个输入框加 3 个按钮，过于拥挤；③ "上移/下移/删除"是纯文字按钮，删除是红色 | 用表格详细视图，行内只读，双击编辑 |
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/25-projects-vfs.png` | 底部有 `null`；路径用衬线等宽字，"展开结构树"的按钮比文字还宽 | 路径统一用 `--font-mono` |
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/26-projects-events.png` | 页签图标是破图（clock 404），只能看到 ⚡ emoji | 换用 Win98 库里的 `clock` |
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/76-win98-green-projects-topo.png` | 豆沙绿色调下：工作线卡片、黑板流卡片保持白色，周围的面板是绿色 | 同 G1，换成令牌后自动解决 |

### 4.4 网络与设备（infra.css，71 处 hex）

| 截图 | 不和谐之处 | 处理 |
|---|---|---|
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/30-infra-topo-max.png` | ① **满屏纯红** `#d90429`：节点边框、×服务标签、连线、"异常告警 16"，告警疲劳；② 连线是平滑曲线，节点是直角方框，风格不搭；③ 拓扑区左上 1/3 空白，右侧详情却挤成两列 | 告警只在节点角标上用 `--bad`，服务标签改为 `--bad-bg` 底加 `--bad-fg` 字；连线改成直角折线（Win98 网络图风格）；主机分组改为 `fieldset` 蚀刻框 |
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/31-infra-node.png` | 详情的数值格子用加粗等宽衬线体（`13800 / 16000 MB`），和其它页面的像素字不一致；"在线 · 41天 0小时"在格子里折行 | 数值用 `--font-mono` 12px 加 `tabular-nums`；格子改成"属性表"（标签左对齐，值右对齐） |
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/32-infra-compute.png` | ① 左右两栏是 Win98 内凹白框（`2px inset #dfdfdf`），放在粉色窗口里很突兀；② GPU 占用条是纯红和纯绿，没有中间色阶；③ 云算力卡片是虚线框加浅蓝条"已预留接口" | 仪表条按 6.8 节做三段阈值；栏框用 `--sunken` 令牌（Windose 下定义成 1px 靛紫细线） |
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/72-night-infra.png` | 深夜下分组标签（"终端与算力工作站"）是浅灰底配浅字，看不清 | 同 G1 |

![网络与设备：纯红告警、曲线连线和方框节点混在一起](shots-baseline/30-infra-topo-max.png)

### 4.5 文献、记忆、日报、计划、邮件、日历、画板、Magpie、记事本

| 截图 | 不和谐之处 | 处理 |
|---|---|---|
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/40-lit-feed-max.png` | **全站最协调的页面**：只用令牌加左边条区分"老报告/新文献/近期发表"。小问题是标签色（橙/靛）硬编码了 11 处 | 作为第 6 节组件规范的参考样板 |
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/50-knowledge-max.png` | 顶部 5 个 KPI 卡片各用一种**左边条颜色**（蓝/绿/橙/紫/灰），是典型的现代仪表盘写法 | 改成 Win98"状态栏格子"，统一 `--line` 描边，颜色只在数字异常时出现 |
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/51-reports-max.png` | 正文切换成 YaHei 矢量字，标题却是像素字加粗，同一个窗口里两种笔触 | 保留"阅读体"（长文必须用矢量字），但把它定为正式令牌 `--font-read`，标题同步改用 `--font-read` 加粗 |
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/54-mail-max.png` | 正文顶部有 `null`；工具栏里的错误提示是粉红色文字，没有图标 | 错误用 6.6 节的信息栏 |
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/53-board-max.png` | 色板圆点是 6 个现代饱和色（`#e53935` 类） | 画板颜色属于内容，不受令牌约束，可以保留；但圆点的描边改用 `--line-strong` |
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/57-magpie-max.png` | 4 个 KPI 卡片的大数字和 Knowledge 页的写法不同 | 统一用"状态栏格子" |
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/52-todo-max.png`、`55-calendar-max.png`、`58-notepad-max.png` | 基本协调，只有星标是 `#c43e00` 写死的橙色 | 星标用 `--warn-fg` |

### 4.6 控制面板

| 截图 | 不和谐之处 | 处理 |
|---|---|---|
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/60-control-home.png` | 左侧 11 项里有两对**同图**：OpenCode 配置指南和文献（紫色问号书）、电脑和 MCP（两台电脑） | 见第 7 节 |
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/66c-control-skills-pools.png` | "healthy · 正常"是英文加薄荷绿描边的徽章，和其它页的"在线"绿字不是一套 | 统一用状态徽章，文案只写中文 |
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/66e-control-skills-fleet.png` | 输入框（网关地址、默认代理）用的是**浏览器默认的 Arial 字体和灰边框**，没有继承像素字 | 全局给 `input, select, textarea` 加上 `font: inherit` |
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/62-control-ai.png` | 9 组"左边说明 + 两个下拉框"，节奏规整，但下拉框的边框是靛紫 2px，比输入框重 | 输入类统一用 `--sunken` |

### 4.7 手机 390×844

| 截图 | 不和谐之处 | 处理 |
|---|---|---|
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/84-phone-projects.png` | 页签逐字竖排（G6）；顶部重复显示项目名两次 | 页签横向滚动，`nowrap` |
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/85-phone-infra.png` | 按钮逐字换行；Clippy 压住状态栏 | 按钮 `nowrap`，窄屏时按钮组换行 |
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/80-phone-desktop.png` | Clippy 压住机器名和"在线 · 3 个会话"文字 | 窄屏时 Clippy 收进托盘 |
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/86-phone-literature.png`、`83-phone-dashboard.png` | 表现良好 | — |

![手机：项目管理页签逐字竖排](shots-baseline/84-phone-projects.png)

---

## 5. Design Tokens v2（CSS 变量体系升级表）

**做法**：新增 `remote/public/css/tokens.css`，在 `desktop.css` 之前引入。保留所有旧令牌名，旧名直接指向新名，这样可以分批迁移、随时回滚。`theme-win98.css` 和 `theme-shades.css` 只重定义**基础令牌**，语义令牌由基础令牌派生，自动跟着变。

### 5.1 表面与线条（surface / line）

| 令牌 | 角色 | Windose 浅 | Windose 深夜 | Win98 标准 | Win98 豆沙绿 | 旧名映射 |
|---|---|---|---|---|---|---|
| `--bg-desk` | 桌面底色（壁纸后面） | `#f7e1fb` | `#150d2b` | `#008080` | `#008080` | 新（取代 `#desktop` 规则里写死的 `#f7e1fb`；win98 下的值等于现在的 `--deep`） |
| `--bg-window` | 窗口内容底 | `#fff8ff` | `#261a47` | `#c0c0c0` | `#c0c0c0` | `--body`（win98 下原为 `#fff`，见注 1） |
| `--bg-panel` | 侧栏、工具条、分组头 | `#f1e6fb` | `#31225c` | `#c0c0c0` | `#c0c0c0` | `--head-bg` `--panel` |
| `--bg-raised` | 卡片、按钮、列表项 | `#ffffff` | `#2f2156` | `#c0c0c0` | `#c0c0c0` | `--surface` |
| `--bg-well` | 输入框、内容井（凹槽） | `#ffffff` | `#1d1438` | `#ffffff` | `#d7ebd7` | 新 |
| `--bg-tint` | 代码、引用、斑马纹 | `rgba(240,209,241,.5)` | `rgba(168,144,255,.16)` | `#ececec` | `#bedabe` | `--tint` |
| `--bg-term` | 终端、日志尾巴 | `#241640` | `#0e0820` | `#000000` | `#000000` | 新（替换 `#111`） |
| `--fg-term` | 终端文字 | `#f0d1f1` | `#e6dcff` | `#c0c0c0` | `#c0c0c0` | 新（替换 `#e0e0e0`） |
| `--line` | 细分隔、卡片描边 | `rgba(77,35,207,.3)` | `rgba(168,144,255,.38)` | `#808080` | `#808080` | `--edge` |
| `--line-strong` | 选中、焦点、窗口内主框 | `#4d23cf` | `#a890ff` | `#000080` | `#000080` | `--border` |
| `--line-soft` | 虚线行分隔 | `rgba(77,35,207,.18)` | `rgba(168,144,255,.22)` | `#dfdfdf` | `#a8c8a8` | 新 |

注 1：Win98 标准外观里，窗口底应该是灰色（`#c0c0c0`），白色只给输入框和列表这类"井"。现在 win98 下 `--body:#fff`，整个窗口都是白色，失去了 Win98 的质感（见 `70-win98-projects-board.png`）。改动前请先确认，因为它会影响所有窗口。

### 5.2 文字与强调

| 令牌 | Windose 浅 | 深夜 | Win98 | 豆沙绿 | 对比度（对 `--bg-window`） |
|---|---|---|---|---|---|
| `--ink` | `#2a1f5e` | `#f1e6ff` | `#000000` | `#000000` | 13.8 / 13.3 / 21 / 15.9 |
| `--muted`（改实色） | `#6f6894` | `#b9afd0` | `#404040` | `#404040` | 4.93 / 7.65 / 10.4 / 7.84 |
| `--faint`（只用于禁用态和装饰，不用于需要阅读的文字） | `#9893b0` | `#8a7fa8` | `#808080` | `#808080` | — |
| `--fill` / `--on-fill` | `#4d23cf` / `#fff` | `#6a4be0` / `#fff` | `#000080` / `#fff` | `#000080` / `#fff` | 8.55 / 5.68 / 16 / 16 |
| `--link` | `#4d23cf` | `#9fd8ff` | `#0000ff` | `#0000ff` | 新（统一 `a` 和"打开…"类链接） |

### 5.3 状态色（5 族 × 3 档，全部经过对比度校验）

规则：`-fg` 用于文字和图标，`-bg` 用于徽章或行底，`-line` 用于描边和左边条。**表内数字是 `-fg` 对 `-bg` / `-fg` 对窗口底的对比度，全部 ≥ 4.5:1**（计算脚本见附录 B）。

| 族 | 语义 | Windose 浅 fg / bg / line | 深夜 fg / bg / line | Win98 fg / bg / line | 豆沙绿 fg / bg | 对比度（浅/深/98/绿） |
|---|---|---|---|---|---|---|
| `ok` | 在线、完成、健康 | `#2c7a64` / `#e4f6ef` / `#3caa78` | `#7fe6bd` / `#1f3a3a` / `#4fc79a` | `#004d00` / `#e0f0e0` / `#008000` | `#005000` / `#b8dcb8` | 4.60/8.09/8.59/6.50 |
| `warn` | 等你确认、降级、阈值 | `#a8430f` / `#fff0e3` / `#d0521c` | `#ffb37a` / `#3f2a2a` / `#e8925a` | `#6b2d00` / `#fff0d0` / `#b04a10` | `#7a3300` / `#ecdcb0` | 5.42/7.60/9.31/6.71 |
| `bad` | 失败、离线告警、断开 | `#a42d63` / `#fde7f1` / `#b4326e` | `#ff9cc4` / `#43213f` / `#e86aa0` | `#800000` / `#ffe0e0` / `#a00000` | `#900000` / `#ecc8c0` | 5.70/7.07/8.86/6.22 |
| `info` | 进行中、提示、引用 | `#16707c` / `#e2faf7` / `#6fd8dd` | `#7ef0e0` / `#1d3646` / `#58cfc6` | `#000080` / `#e0e8ff` / `#000080` | `#000080` / `#c0d4e4` | 5.28/9.25/13.1/10.5 |
| `idle` | 空闲、未开始、离线 | `#6f6894` / `#f3eef8` / `#c9bde0` | `#a89cc4` / `#2f2556` / `#6a5f8e` | `#404040` / `#ececec` / `#808080` | `#404040` / `#bedabe` | 4.50/5.41/8.78/6.89 |

Win98 这一列特意用了更深的经典色（栗色 `#800000`、深绿 `#004d00`）。这样即使采纳 D1、把窗口底改成灰色 `#c0c0c0`，前景色对灰底仍然 ≥ 5.6:1。原先考虑的 `#006000`、`#8a3a00` 对灰底只有 4.3:1，不达标。

**状态语义映射**（全站统一，修正 G9）：

| 业务状态 | 令牌族 | 说明 |
|---|---|---|
| 进行中 / RUNNING / thinking | `info` | 不再用绿色。绿色表示"好的结果"，不是"正在进行" |
| 完成 / done / healthy / 在线 | `ok` | 不再用品红（`--bad`） |
| 等你确认 / 提问 / 待审 / 待检视 | `warn` | |
| 失败 / 回退 / 断开 / 已停止（期望运行） | `bad` | infra 的 `#d90429` 全部收口到这里 |
| 空闲 / 待办 / 未开始 / 离线（预期内） | `idle` | |

### 5.4 图表、拓扑与仪表

| 令牌 | 用途 | Windose 浅 | 深夜 | Win98 |
|---|---|---|---|---|
| `--viz-1`…`--viz-6` | 分类色（图例、多系列） | `#4d23cf` `#16707c` `#c2307f` `#a8430f` `#2c7a64` `#6f6894` | `#a890ff` `#7ef0e0` `#ff8fd0` `#ffb37a` `#7fe6bd` `#b9afd0` | `#000080` `#008080` `#800080` `#808000` `#008000` `#404040` |
| `--node-master` | 主控节点描边/底 | `--line-strong` / `--bg-raised` | 同左（自动） | 同左 |
| `--node-worker` | 执行节点 | `--info-line` | 自动 | 自动 |
| `--node-verifier` | 验收节点 | `--viz-3` | 自动 | 自动 |
| `--node-off` | 离线/未找到 | `--idle-line`，虚线 | 自动 | 自动 |
| `--link-ok` / `--link-standby` / `--link-down` | 主用 / 备用 / 中断 | `--ok-line` 实线 / `--muted` 虚线 / `--bad-line` 点划线 | 自动 | 自动 |
| `--meter-track` | 仪表条底槽 | `--bg-tint` | 自动 | `--bg-well` + `--sunken` |
| `--meter-ok/-warn/-bad` | 占用 <70% / 70–90% / >90% | `--ok-line` / `--warn-line` / `--bad-line` | 自动 | 自动 |

### 5.5 字体与字号（修正 G5）

| 令牌 | 值 | 用途 | 替换规则 |
|---|---|---|---|
| `--font-ui` | `"PixelMplus12", "Microsoft YaHei UI", sans-serif` | 全部界面文字 | — |
| `--font-meta` | `"PixelMplus10", var(--font-ui)` | 时间戳、计数、次要说明 | 需要新增 `PixelMplus10-Regular.ttf`（与 12 同一套字体，体积约 1.5 MB） |
| `--font-mono` | `"Cascadia Mono", Consolas, "PixelMplus12", monospace` | 路径、命令、ID、数值列 | 替换 `SimSun`、`monospace`、`Consolas, monospace` 等 23 处 |
| `--font-read` | `"Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif` | 日报正文、邮件正文、文献摘要、Markdown 长文 | 把 reports/mail 的现有写法正式化 |
| `--fs-meta` | `10px` | 配 `--font-meta` | 原 9–11.5px 的辅助文字 |
| `--fs-ui` | `12px` | 正文、按钮、页签、标题（标题靠加粗或颜色区分，不放大） | 原 12–13.5px |
| `--fs-read` | `14px / 1.7` | 配 `--font-read` | 原长文 13–15px |
| `--fs-display` | `24px` | 桌面机器名、KPI 大数字 | 原 18–22px |

像素字只允许 10/12/24px 三个字号。拿不准时用 12px 配 `--muted` 颜色来降一级，而不是缩小字号。

### 5.6 间距、圆角、阴影/立体、层级

| 组 | 令牌 | 值 | 说明 |
|---|---|---|---|
| 间距（2px 网格） | `--sp-1` … `--sp-7` | `2 4 6 8 12 16 24 px` | 现有 20 种取值收口到 7 档（现状最常用的是 6/4/8/5/2，5 和 3 并入 4 或 6） |
| 行高 | `--lh-ui` / `--lh-read` | `1.35` / `1.7` | |
| 圆角 | `--r` / `--r-dot` | `0` / `50%` | `--r-dot` 只给 ≤8px 的状态圆点 |
| 立体（两套外观同名） | `--raised` `--raised-outer` `--pressed` `--sunken` | win98：沿用现值；Windose：`--raised: inset 0 0 0 1px var(--line-strong)`，`--sunken: inset 1px 1px 0 var(--line)` | **Windose 下这四个令牌目前没有定义**，组件里写的是 `var(--raised, 兜底)`，各处兜底值都不一样 |
| 浮层投影 | `--shadow-pop` | Windose：`4px 4px 0 rgba(20,10,90,.35)`（与窗口一致）；win98：`none` | 禁止模糊阴影和 `0 0 Npx` 发光 |
| 层级 | `--z-desk` `--z-widget` `--z-windows` `--z-netpanel` `--z-taskbar` `--z-menu` `--z-popover` `--z-gate` | `0` `5` `10` `20` `50` `60` `70` `100` | `.ap-widget.urgent` 从 9500 降到 `--z-widget`，紧急提醒改走托盘 |

### 5.7 落地示例（tokens.css 片段）

```css
:root {
  /* 基础令牌：主题和色调只改这一层 */
  --bg-window: #fff8ff; --bg-raised: #fff; --bg-well: #fff; --bg-panel: #f1e6fb; --bg-tint: rgba(240,209,241,.5);
  --line: rgba(77,35,207,.3); --line-strong: #4d23cf; --line-soft: rgba(77,35,207,.18);
  --ok-fg: #2c7a64;  --ok-bg: #e4f6ef;  --ok-line: #3caa78;
  --warn-fg: #a8430f; --warn-bg: #fff0e3; --warn-line: #d0521c;
  --bad-fg: #a42d63; --bad-bg: #fde7f1; --bad-line: #b4326e;
  --info-fg: #16707c; --info-bg: #e2faf7; --info-line: #6fd8dd;
  --idle-fg: #6f6894; --idle-bg: #f3eef8; --idle-line: #c9bde0;
  --font-ui: "PixelMplus12", "Microsoft YaHei UI", sans-serif; --fs-ui: 12px; --fs-meta: 10px; --fs-display: 24px;
  --sp-1: 2px; --sp-2: 4px; --sp-3: 6px; --sp-4: 8px; --sp-5: 12px; --sp-6: 16px; --sp-7: 24px; --r: 0;
  --raised: inset 0 0 0 1px var(--line-strong); --sunken: inset 1px 1px 0 var(--line);
  /* 旧名兼容：迁移完成前保留 */
  --surface: var(--bg-raised); --edge: var(--line); --border: var(--line-strong); --body: var(--bg-window);
  --ok: var(--ok-line); --ok-text: var(--ok-fg); --warn: var(--warn-line); --bad: var(--bad-line);
}
```

---

## 6. 统一组件规范

所有组件只用第 5 节的令牌，下面不再重复写颜色。

| # | 组件 | 规范 | 替换的现有写法 |
|---|---|---|---|
| 6.1 | **按钮** | 高 22px，`padding: 0 var(--sp-4)`，`--fs-ui`，`box-shadow: var(--raised)`，按下用 `--pressed`。变体：主按钮（`--fill` 底、`--on-fill` 字）、次按钮（`--bg-raised`）、危险按钮（`--bad-fg` 字、`--bad-line` 描边，**不填红底**）、文字按钮（无框，`--link`）。禁用：`--faint` 字，去掉立体 | 项目页的红底"删除项目"；infra 的"启动"填色按钮 |
| 6.2 | **页签 Tab** | Win98 属性页样式：选中页签比其它页签高 2px，和内容区连通、没有下边线；未选中的落在 `--bg-panel` 上。**禁止页签内放图标**（除非每个图标都不同）；窄屏用 `overflow-x:auto; white-space:nowrap` | `.pm-tab`（图标重复、手机竖排）、`.lit-tab`、`.skp-tab` 三套写法 |
| 6.3 | **徽章 / Chip** | 高 16px，`0 var(--sp-2)`，`--fs-meta`，`1px solid` 加状态色 `-line` 描边，`-bg` 底，`-fg` 字，方角。ID 和路径类用 `.chip.mono`（`--font-mono`，`--idle` 族） | `.pm-badge` `.pm-task-stat` `.pm-kind-badge` `.pm-role-badge` `.inf-pill` `.rd-branch-pill`（6 套） |
| 6.4 | **分组框（容器）** | `fieldset` 语义：`1px solid var(--line)`，标题压在边框上（`legend`，`--fs-ui` 加粗，`--line-strong` 色）；内边距 `--sp-4`；**不加阴影、不填色** | `.inf-comp-card` `.pm-card` 以及知识库 KPI 卡片的彩色左边条 |
| 6.5 | **列表 / 详细视图** | 行高 22px，奇偶行用 `--bg-tint` 斑马纹，选中行 `--fill`；列头用 `--raised`；数值列 `--font-mono` 右对齐 | 任务板、算力队列、模型池（现在是卡片套卡片） |
| 6.6 | **信息栏（Alert）** | 左侧 16px Win98 消息图标（`msg_information` / `msg_warning` / `msg_error`），`-bg` 底，`1px` `-line` 描边；只有 `warn`/`bad`/`info` 三种 | "需要你处理"橙条、邮件红字错误、知识库黄色提示条 |
| 6.7 | **便签 / 桌面挂件** | 宽 270px，标题栏用 `--title` 渐变（同窗口），内容 `--bg-window`；紧急态**不改变标题颜色**，只在标题加 `warn` 徽章计数，并让托盘图标闪烁 | 红橙渐变标题的"待介入" |
| 6.8 | **仪表条（Meter）** | 高 10px，槽是 `--meter-track` 加 `--sunken`，填充按阈值取 `--meter-ok/-warn/-bad`，右侧用 `--font-mono` 写数值 | `.inf-meter` 的纯红/纯绿 |
| 6.9 | **拓扑节点** | 方角，`2px solid` 角色色（5.4 节），内容是"图标 16px + 名称 + 状态点"，宽度 ≥ 120px，名称省略时 hover 显示全名；连线用直角折线，状态见 `--link-*` | `.pm-gnode`（13px 胶囊）、`.inf-node`（红色粗框） |
| 6.10 | **输入框 / 下拉框** | `--bg-well` 底，`box-shadow: var(--sunken)`，`font: inherit`（修正 fleet 页的 Arial），高 22px | 各处的 1px/2px 描边输入框 |
| 6.11 | **空状态** | 居中的 32px Win98 图标 + 一行 `--muted` 文字 + 可选的一个主按钮 | 文献卡片库、Knowledge 的纯文字空状态 |
| 6.12 | **代码 / 终端块** | `--bg-term` / `--fg-term`，`--font-mono` 12px，左边条 `--line-strong` | `.inf-comp-tail{background:#111}`、Markdown `pre` |

---

## 7. 图标去重与重配清单

现状：`icon()` 调用里 `projects` 一个图标用了 9 次（项目管理窗口标题、项目列表、4 个页签、研究复核等），`help_book_big`、`network_normal_two_pcs`、`network_cool_two_pcs`、`notepad`、`key_win` 都是一图多义；`clock` 引用了但图标文件不存在。候选全部来自 `D:/ametyping/windows98-icons/png`（1757 个 PNG，不在 git 里），已按**实际像素尺寸**挑出 32px 版本（这个库的 `-0/-1` 后缀和尺寸没有固定对应关系）。对比表：

![图标对比：红底是现用图标，右边是候选](shots-baseline/99-icon-candidates.png)

`D:/ametyping-refactor/docs/overhaul/shots-baseline/99-icon-candidates.png`

**重配清单**（原则：一个含义对应一个图标；同一个图标只能在不同位置表达同一个含义）。"源文件"列是 `windows98-icons/png/` 下实测为 32px 和 16px 的文件。M4 时复制成 `remote/public/icons/<新名>.png` 和 `<新名>-16.png`：

| 用途 | 位置（源码） | 现用 | 改为 | 源文件 32 / 16 | 理由 |
|---|---|---|---|---|---|
| 文献（桌面、开始菜单、文献窗） | `main.js:61`、`literature.js:27` | `help_book_big` | **`catalog`** | `catalog-1` / `catalog-0` | 卡片目录柜，对应"文献卡片库"的语义；和"帮助书"区分开 |
| 深读窗 | `lit-reader.js:26` | `help_book_big` | **`search_file_2`** | `search_file_2-0` / `-1` | 放大镜加文档，表示"精读一篇" |
| 控制面板 › 文献 | `control.js` ITEMS | `help_book_big` | `catalog` | 同上 | 和桌面的文献图标保持一致 |
| 控制面板 › OpenCode 配置指南 | `control.js` ITEMS | `help_book_big` | **`help_book_computer`** | `help_book_computer-0` / `-1` | 帮助书加电脑，表示"安装配置指南" |
| Skill 管理（桌面）/ Skill 与协同 | `main.js:63`、`control.js` ITEMS | `notepad` | **`script_file_teal`** | `script_file_teal-1` / `-0` | 脚本文档，青色和 Windose 的 `--cyan` 呼应；"记事本"独占 `notepad`。若采纳 04 方案 4-A 删掉桌面上的"Skill 管理"，只改控制面板这一处 |
| 控制面板 › MCP | `control.js` ITEMS | `network_normal_two_pcs` | **`tools_gear`** | `tools_gear-0` / `-1` | 工具加齿轮，表示"给 agent 用的工具服务器" |
| 网络与设备（桌面、窗口） | `main.js:52`、`infra.js:58` | `network_cool_two_pcs` | **`network_three_pcs`** | `network_three_pcs-0` / `-1` | 多台机器组成的网络；和"网上邻居"的双机图标区分开 |
| 网络与设备 › 路由节点 | `infra.js` ROLE_ICONS.router | `network_cool_two_pcs` | **`network_drive_world`** | `network_drive_world-0` / `-1` | 网关通往外网 |
| 网络与设备 › 云端节点 | `infra.js` ROLE_ICONS.cloud | `network_normal_two_pcs` | **`world`** | `world-0` / `-1` | 公网主机 |
| 控制面板 › 电脑 | `control.js` ITEMS | `network_normal_two_pcs` | **`computer_2`**（仓库已有） | — | 和网上邻居列表里的单机图标同义，都表示"一台电脑" |
| 网上邻居（开始菜单、托盘） | `main.js:69` | `network_normal_two_pcs` | 保持 | — | 去重以后它独占这个图标 |
| Google 账户 | `control.js` ITEMS | `key_win`（与"注销"同图） | **`key_world`** | `key_world-0` / `-1` | 在线账户的钥匙；"注销"独占 `key_win` |
| 项目管理 › 研究与计算 | `projects.js:164` | `projects` | **`magnifying_glass`** | `magnifying_glass-0` / `-1` | 6 个页签各用一个图标，否则按 6.2 节去掉页签图标 |
| 项目管理 › 黑板与任务 | `projects.js:165` | `projects` | **`notepad_file`**（仓库已有） | — | 帖子和任务 |
| 项目管理 › 协同拓扑与契约 | `projects.js:166` | `projects` | 保持 `projects` | — | 拓扑就是项目本体 |
| 项目管理 › 角色与模型池 | `projects.js:167` | `projects` | **`users`** | `users-0` / `-1` | 角色 |
| 项目管理 › 触发器与看门狗 | `projects.js:169` | `clock`（**文件缺失，404**） | **`clock`**（补文件） | `clock-1` / `clock-0` | 修复破图 |

去重后的检查规则：在 `main.js`、`control.js`、`infra.js`、`projects.js` 里，`icon('x')` 的每个 `x` 只能对应一个功能含义（可以在 M4 加一条静态检查）。

---

## 8. 桌宠气泡（`app/bubble.html`）与 Windose 桌面的家族化

| 截图 | 观察 |
|---|---|
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/90-bubble-log.png` | 9-slice 粉青窗口框（`windowbase_active.png`），和网页窗口（`windowbase_active_clean.png`）**同源**，血缘已经很近 |
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/91-bubble-permission.png` | 权限卡是靛紫 2px 框配粉底按钮；网页看板的同一张卡是橙色框配三色按钮，**两边不像一家** |
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/92-bubble-ask.png` | 提问卡的选项按钮（粉底、选中时靛紫）是全站最好的"选择题"组件，网页 `dash-ask.js` 可以反过来向它看齐 |
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/93-bubble-chat.png` | 对话气泡：用户消息是粉底，助手消息是白底加淡紫框，代码块是粉底加靛紫左边条，与 6.12 节的规范一致 |
| `D:/ametyping-refactor/docs/overhaul/shots-baseline/94-bubble-collapsed.png` | 折叠条加红色方块未读数，像素化处理到位 |

**差异与方案：**

| # | 差异 | 现状 | 方案 |
|---|---|---|---|
| B1 | 令牌名不同、值相同 | 气泡 `--ink: rgb(58,34,84)`、`--blue: rgb(77,35,207)`（= 网页 `--border`）、`--pink: rgb(240,209,241)`（= `--title`）；状态色 `rgb(60,140,120)`/`rgb(208,82,28)`/`rgb(180,50,110)` 和网页的 `--ok-text/--warn/--bad` 字面值相同，但是各自写了一份 | 抽出 `windose-tokens.css` 作为唯一来源，网页和 Electron 各引用一次（由 `check-static.js` 校验两份内容一致，或者在构建时复制）。气泡改用 `--line-strong`、`--title`、`--ok-fg` 等名字 |
| B2 | 字体缺失 | `font-family: "zpix", "PixelMplus", …`，但 `assets/dialog/zpix.ttf` 在所有检出里都不存在，实际回退到 PixelMplus12 | 二选一：补上 zpix（中文字形更全的像素字，需要确认许可）；或者删掉 zpix，和网页统一用 PixelMplus12 加 PixelMplus10。**推荐后者**，家族一致性更高 |
| B3 | 状态语义 | `.st.done` 是品红，和网页的问题一样（G9） | 跟随 5.3 节：进行中 `info`、完成 `ok` |
| B4 | 色调不跟随 | 气泡永远是浅色；网页切到深夜后，桌面上的糖糖仍然是亮粉色 | 气泡读取同一份 `shade` 偏好（agent 已经和服务器通信，可以下发 `t:'shade'`），套用 `html[data-shade=night]` 的令牌值 |
| B5 | 权限卡不一致 | 网页是橙框三色按钮，气泡是靛紫框粉按钮 | 两边都用 6.6 节信息栏加 6.1 节按钮：`warn` 描边，主按钮"允许"用 `--fill`，"总是允许"是次按钮，"拒绝"是危险按钮 |
| B6 | 滚动条 | 气泡 6px 靛紫细条，网页 12px 带粉色描边 | 统一为 8px，`--fill` 滑块，`--bg-tint` 轨道 |

---

## 9. 落地路线与拍板事项

### 9.1 里程碑（每步都用 `node remote/test/overhaul-gui-shots.js` 重拍，和本基线逐张对比）

| 里程碑 | 范围 | 预计改动 | 验收 |
|---|---|---|---|
| **M1 令牌层** | 新增 `tokens.css`（第 5 节），旧名兼容；Windose 补齐 `--raised/--sunken`；修正 G10 的四个低对比令牌；补 `--win-bg/--accent` | 1 个新文件，`index.html` 加 1 行，`theme-*.css` 小改 | 全部截图肉眼无差异（除对比度提升）；`check-static` 通过 |
| **M2 换令牌** | `infra.css`、`projects.css`、`topo-overview.css`、`control.css`、`dash.css` 的 hex 改成令牌；修 G1、G2、G4、G8 | 约 470 处替换 | 深夜/豆沙绿下没有白色孤岛；非主题 CSS 的 hex 数量从 579 降到 ≤ 40（只剩品牌色，比如 provider 图标颜色） |
| **M3 组件化** | 第 6 节的 12 个组件收口为 `components.css`；页签、徽章、分组框、仪表条全站统一；修 G5、G6 | 中等 | 字号只剩 10/12/14/24；手机页签不再竖排 |
| **M4 图标与桌宠** | 第 7 节图标重配（复制进 `remote/public/icons/`）；第 8 节气泡家族化；修 G7、G11 | 小 | 图标对比表里没有重复项；控制台没有 404 |

建议给 `check-static.js` 加一个**硬编码色值门禁**（非 `theme-*.css`、`tokens.css` 的文件里，新增 hex 就报错）。这能防止回潮，不过属于 M2 的范围，本阶段不做。

### 9.2 需要用户拍板

| # | 问题 | 推荐 | 备选 |
|---|---|---|---|
| D1 | Win98 标准外观下窗口底色用灰色 `#c0c0c0`（正宗）还是保持白色 | **灰色**，白色只给输入框和列表 | 保持白色（改动小，但"标准"外观会显得单薄） |
| D2 | "进行中"改成 `info`（青色），"完成"改成 `ok`（绿色） | **改** | 保持现状（绿=进行中、品红=完成） |
| D3 | 桌宠字体去掉 zpix、统一用 PixelMplus | **统一** | 补 zpix 字体文件（先确认许可） |
| D4 | 紧急"待介入"从屏幕右上的悬浮挂件改成任务栏托盘闪烁加气泡 | **改** | 保留悬浮，但限制在桌面区域内，z-index 低于窗口 |

---

## 附录 A · 源码统计（`remote/public/css/`，基线 `3c0a42b`）

| 文件 | 行数 | hex | rgb() | border-radius | box-shadow | var(--) | font-size |
|---|---|---|---|---|---|---|---|
| projects.css | 1238 | **285** | 4 | 11 | 28 | 283 | 119 |
| theme-win98.css | 127 | 153 | 6 | 0 | 33 | 42 | 0 |
| infra.css | 138 | **71** | 3 | 1 | 5 | 39 | 30 |
| theme-shades.css | 59 | 69 | 26 | 0 | 0 | 6 | 0 |
| control.css | 331 | 52 | 0 | 0 | 2 | 197 | 57 |
| dash.css | 330 | 43 | 3 | 2 | 4 | 232 | 73 |
| topo-overview.css | 99 | 28 | 10 | 2 | 3 | 49 | 17 |
| desktop.css | 253 | 27 | 22 | 2 | 8 | 189 | 25 |
| magpie.css | 49 | 22 | 1 | 0 | 9 | 61 | 25 |
| menu.css | 39 | 14 | 3 | 0 | 5 | 20 | 6 |
| literature.css | 242 | 11 | 3 | 0 | 3 | 220 | 77 |
| 其余 15 个 | 672 | 26 | 14 | 8 | 15 | 427 | 129 |
| **合计 26 个** | **3577** | **801** | **95** | **26** | **115** | **1765** | **558** |

（不含两个主题文件时：hex 579、rgb() 63、box-shadow 82。）

- 不同 hex 色值：全部 287 种；不含两个主题文件 220 种。
- 字号分布：12px 148、11px 106、**11.5px 104**、**12.5px 52**、13px 41、10px 35、**10.5px 22**、14px 11、15px 8、**13.5px 7**，另有 11 种零星取值。
- 间距（gap/padding/margin 的 px 值）：6px 240、4px 220、8px 150、5px 110、2px 104、3px 75、10px 65、1px 61、12px 28……共 20 种取值。
- 字体声明：`Consolas, monospace` 13 处、`monospace` 6 处、`SimSun` 1 处、`Calibri/DengXian` 2 处（Office 预览，属于内容，保留）。
- 未定义令牌：`--win-bg`（infra.css:110）、`--accent`（files.css:17）。`--nl`、`--pct`、`--total-scale-factor` 由 JS 设置，正常。

## 附录 B · 对比度计算

WCAG 2.x 相对亮度公式，脚本思路：`L = 0.2126R + 0.7152G + 0.0722B`（线性化后），`CR = (L1+0.05)/(L2+0.05)`。现有令牌（对 `#fff8ff`）：`--muted` 约 4.16，`--faint` 约 2.82，`--warn` 4.10，`--ok-text` 3.86，`--bad` 5.56。深夜色调下算力面板 `--ink #f1e6ff` 对 `#fff` 是 1.20，master 节点对 `#f4f7ff` 是 1.12。Win98 外观下桌面标签白字对粉色壁纸 `#f7e1fb` 是 1.23。

## 附录 C · 截图清单

见 `D:/ametyping-refactor/docs/overhaul/shots-baseline/manifest.json`（每张截图的说明、失败步骤、去重后的页面报错）。
