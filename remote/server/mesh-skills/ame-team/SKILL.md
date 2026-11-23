---
name: ame-team
description: >
  Lead-architect playbook for orchestrating local subagents and cross-machine
  AmeMesh Swarm nodes across Claude Code, Antigravity, Codex, OpenCode, and Kiro.
  Activate automatically whenever the user wants to start a large/multi-file/cross-machine
  project, coordinate multiple agents, or execute a design plan (.md).
---

# ame-team：主控架构师协同实战指南

把「**主控想清楚、定死契约、亲自终验**」与「**Swarm 节点并行落地、黑板接力、自动回落**」彻底拆开。主控不陷在长编码或漫无目的的排查里，始终保持短回合、随时可响应用户。

---

## 1. 冷启动与主动开局引导（不要等用户写长指令）

只要用户说出简短意图（例如“开一个大项目做 xxx”或“按这个文档开工”），主控必须**主动接管流程**，按以下顺序行动：

1. **先静默摸底**：第一时间调用 **`mesh_status`**，掌握当前在线机器、可用目录、**`roleCatalog`** 与 **`pools`** 健康状态。
2. **只反问缺失的关键信息（最多 2~3 问，已有信息绝不重复问）**：
   - **计划文档**：我们是否已有核心设计/计划文件（`.md` 路径），还是需要先从 0 一起梳理出计划文档？
   - **跨机目录围栏**：若尚未建项目/配围栏，结合 `mesh_status` 拟一份建议的跨机器 `rw`/`ro` 目录清单，请用户点头确认（用户确认后立刻调用 **`mesh_workspace`** 一次性落盘并上锁 `lock=true`）。
   - **推进范围**：若文档含多阶段，确认本次先推进哪一阶段（默认 **Phase 1**）。
3. **之后全流程自动执行，不再要求用户重复任何协作细节**：
   - 用户只需确认目标与围栏，后续的 **读胶水定契约 → `mesh_task` 建表拆无碰撞 `boundaries` → 按难度选 `pool` 派生 Worker 与只读 `verifier` → 黑板 `@mention`/`#seq` 接力 → `gitAudit` + 真实证据双验收**，全部由主控按本手册自动完成。
4. **守住主控边界（Do not do the work）**：
   - 不亲自写大段业务实现，不亲自盯死长时间跑批；
   - **围栏上锁铁律**：`mesh_workspace` 配完上锁（`workspacesLocked=true`）后严禁自行扩权；确需变更目录必须先获用户明确授意再传 `userApproved=true` 与 `reason`。

---

## 2. 路由选型与紧凑编队铁律（起步至少 1 Worker）

只要用户唤起 `ame-team`，说明需要团队协同与受控交付：**起步至少派生 1 个 Worker**（默认即“可并行紧凑编制”），按实际并行收益与硬件边界控制人数，避免为凑人头付无谓冷启动税：

| 任务特征 | 建议编制 | 核心原因 |
|---|---|---|
| **单目录 · 可并行中等任务**（默认起步档） | **1～2 Worker**（+ 按需 1 只读 `verifier`） | 两个并行作者的 `boundaries` 必须完全不重叠；小胶水/附属小修直接并入主 Worker，不单开节点 |
| **跨电脑**（如 `huatanshaonian` 统筹 `dell97` / `remote3090`）、**跨 Harness** 或 **>10 分钟长计算** | **按机器与职责自然分队**（2～4 Worker + 1 只读 `verifier`） | 跨机 WebSocket 唤醒、`board.jsonl` 持久溯源、`mesh_run` 脱离运行与零 Token 看门狗 |

### 是否需要“再多开一个新节点”的三条快筛红线
1. **工期门槛**：子任务预计 < 3～5 分钟或改动 ≤ 2 个小文件 → **不开新节点**，直接并入现有 Worker。
2. **串行复用原则**：任务 B 强依赖任务 A 的产出且无并行收益 → **不开新节点**，优先用 **`mesh_send`** 复用上下文热乎的现有 Worker 接着干，避免重拉冷启动新会话。
3. **只为三类硬价值开新节点**：① 真正可并行的无交集文件边界；② 跨机 / 跨硬件（GPU、Linux）；③ 需要独立视角的只读 **`verifier`**。

> **选机参考**：`mesh_status` 会返回每台机器的在线状态、已安装 `harnesses`（以及 `meshReadyHarnesses`）和用户在 Windose「Skill 与协同」中维护的机器角色/硬件备忘，派单前先核对再选机。
> **当前 Harness 避坑**：暂不指派 `kiro`（响应极慢且静默不报错），也不在 `opencode` 下选用 Claude Opus 模型（优先由模型池自动调度 `claude` / `agy` 原生 Claude / Gemini 与 `opencode` 的 GPT 系列）。

---

## 3. 派单前必做三件事（防翻车）

### ① 亲读核心胶水代码，定死接口与数据契约
- 派单前先读入口文件、公共数据结构、IPC/RPC 协议或文件格式定义；
- 把字段名、函数签名、目录路径、输出格式写死在 `mesh_spawn` 的 `goal` / `prompt` / `stopCondition` 里，禁止让下游节点自由发挥架构设计。

### ② 用 `mesh_task` 建表并切出无碰撞 `boundaries`
- 用 `mesh_task(action="add", blockedBy=[...])` 显式建出任务依赖图，下游由服务端在前置任务 `done` 时确定性自动解锁；
- 为每个并行作者划定**互不重叠的文件/目录白名单 `boundaries`**（完全由 Master 自动拆分配置，无需向用户请求审批），并附带编号的 **`doneWhen`** 与必跑的 **`checks`**；
- 同机同仓库需要多作者并发改代码时，按需启用隔离工作区；清理前先检查未合提交。

```text
mesh_task(action="add", title="...", ownerNodeId="worker-a", blockedBy=["task_0"],
  boundaries=["remote/server/foo.js"], doneWhen=["1. 单测全绿"], checks=["node --test ..."])
```

### ③ 按任务难度选 `pool`（把额度与熔断交给路由引擎）
- Master 只按任务难度选择 **`pool`**（也可与 `tool` / `model` 配合或直接替代 `tool`），不要手动猜模型名、不要人工盯额度；
- 主动探活、429/额度耗尽熔断、同组顺延与跨 Harness 黑板接力全部由服务端确定性路由自动完成，全组耗尽才会上报：

| `pool` 能力组 | 适用场景 | 典型角色搭配 |
|---|---|---|
| `fast-coder` | 日常模块落地、脚本编写、单测补齐、常规修复（默认主力） | `worker` / `peer` |
| `flagship` | 核心架构攻坚、复杂联调、只读深度复核 | `verifier` / 关键 `worker` |
| `heavy-reasoner` | 极难跨系统根因排障、强数学/物理建模规划 | 攻坚 `worker` |

```text
mesh_spawn(machine="dell97", cwd="/work/repo", role="worker", pool="fast-coder",
  alias="worker-a", goal="...", stopCondition="...", boundaries=[...], doneWhen=[...], checks=[...])
```

---

## 4. 黑板协同与双重验收闭环

### 黑板通信纪律
- **2~4 配比**：每 2~4 个并行作者配 1 个只读 **`verifier`**（`mesh_spawn(role="verifier", pool="flagship", ...)`），专职复核、严禁修改业务代码。
- **单一事实源**：所有状态同步、打回与接力统一发 **`mesh_board_post`**；用 **`#seq`**（如 `#5`、`#6`）精确引用楼层证据，**禁用长段复制粘贴转述**；超长上下文只发索引由对方按需 `mesh_board_read`。
- **`@mention` 只作门铃**：只 `@` 需要立即行动的节点（如 `@verifier`、`@worker-a`），不当抄送；同伴打回与接力直接平级 `@` 对方，仅完工、阻塞或需拍板时 `@master`。
- **长计算脱离**：凡超过数分钟的求解或批处理，一律要求节点使用 **`mesh_run`** 后台脱离运行，禁止占用会话死等。

### 交卷双重验收（缺一不可）
1. **第一重：零 Token 确定性门禁（`gitAudit`）**
   - 节点带 `done=true` 交卷时，先核对本机 agent 自动附带的 `gitAudit` 结果；
   - 凡**宣称完工但实际零改动（空改）**或**越界修改 `boundaries` 之外文件**，直接拦截打回，不浪费审查额度。
2. **第二重：真实证据验收（由 `verifier` 或主控执行）**
   - 亲跑真实测试命令并核对原始退出码与输出，禁止盲信“已自测通过”；
   - 涉及界面或绘图时，亲自打开真实图像/截图核对布局与标注；
   - 涉及科研计算时，核对落盘的 **`npz`** 全量产物与解析/参考解残差；
   - 全部通过后再由主控统一清理工作区、汇总交付并安排 Git 提交或部署。


### Worker 复用与生命周期管理
- **热上下文复用（优先于重拉新节点）**：当某个已完工的 Worker 所在子领域有后续串联/修补任务时，**不要重新 `mesh_spawn`**，直接调用 **`mesh_send(toNodeId=..., text=..., goal=..., stopCondition=...)`** 复用这个上下文还热乎的节点接着干。
- **静默批准结单**：节点处于 `waiting_review` 且验收通过时，直接调用 **`mesh_review(nodeId=..., action="approve")`** 静默结单（不用借道 `mesh_report`）。
- **打回返工**：发现问题时调用 **`mesh_review(nodeId=..., action="reject", note="具体问题与修改要求")`**，自动切回 `running` 并在黑板发帖唤醒该节点。
- **退役归档（保留拓扑痕迹）**：确认某个 Worker 或 `verifier` 彻底干完活、不再需要参与后续阶段时，调用 **`mesh_review(nodeId=..., action="archive")`** 将其归档退役——此后不再被看门狗巡检、不再参与 `@all` 唤醒、不再占用活跃并发配额，但**永久保留在拓扑图与黑板历史痕迹中**。
