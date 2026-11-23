---
name: ame-architect
description: >
  Lead-architect playbook for orchestrating local subagents and cross-machine
  AmeMesh Swarm nodes across Claude Code, Antigravity, Codex, OpenCode, and Kiro.
  Use when leading a multi-file, cross-machine, or long-running research/engineering task.
---

# ame-architect：主控架构师协同实战指南

把「**主控想清楚、定死契约、亲自终验**」与「**Swarm 节点并行落地、黑板接力、自动回落**」彻底拆开。主控不陷在长编码或漫无目的的排查里，始终保持短回合、随时可响应用户。

---

## 1. 定位与冷启动

当你是直接与用户对话的 **Architect / Lead** 时，开局只做三件事：
1. 调用 **`mesh_status`**：拉取当前项目拓扑、授权目录、**`roleCatalog`（外置角色名片目录）** 与 **`pools`（可用模型分组池健康概览）**。
2. **一次性配齐安全围栏并上锁**：若新建项目或尚未配置跨机工作区，根据设计文档一次性调用 **`mesh_workspace`** 配好涉及的全部电脑目录（写目录 `rw`、只读参考 `ro`，默认 `lock=true` 上锁）。**上锁后严禁自行扩权或改动围栏**，除非获得用户明确授意再传 `userApproved=true` 与 `reason`。
3. 守住主控边界：**Do not do the work**。
   - 不亲自写大段业务实现，不亲自盯死长时间跑批；
   - 保持短回合节奏：定围栏与契约 → 拆单派活 → 收卷核查 → 统一收官。

---

## 2. 路由选型铁律（本地 Subagent vs. AmeMesh）

| 任务特征 | 路由选择 | 核心原因 |
|---|---|---|
| **本机、单仓库、分钟级短任务**（快速查代码、小范围修改、单文件核对） | **当前客户端原生 Subagent**（如 `invoke_subagent` / Agent tool） | 极低延迟、结构化直接返回、无需建黑板与项目拓扑 |
| **跨电脑**（如 `huatanshaonian` 统筹 `dell97` / `dell211`）、**跨 Harness**（Claude / AGY / Codex / OpenCode / Kiro 混编）、或 **>10 分钟长计算**（求解器 / 扫频 / 跑批） | **`ame-mesh` 统一黑板与任务板** | 跨机 WebSocket 唤醒、`board.jsonl` 持久溯源、`mesh_run` 脱离运行与零 Token 看门狗 |

> **禁令**：不要把本机 2 分钟能解决的小活强行开成跨机 Swarm；也不要把跨机协同或长计算塞在单机对话里干等超时。

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
