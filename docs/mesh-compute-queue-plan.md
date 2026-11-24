# AmeMesh 轻量算力排队锁（Mini-Slurm）设计方案

面向多台工作站（如 `remote3090`、`dell97`、`dell211`、`huatanshaonian`）运行电磁求解（FEKO / CuPy MoM）与神经网络训练时的轻量级资源排队与互斥机制，无需部署重型 Slurm。

## 1. 设计目标与边界
- **解决痛点**：防止多个 Agent 或多个任务同时往同一张 GPU / 同一台高负载 CPU 工作站塞重计算，导致 OOM 爆显存或互相挤死。
- **感知外部手工任务**：即使你在某台工作站上**手动**启动了 FEKO 或 PyTorch 训练（未经过 `mesh_run`），本机 agent 也会通过硬件探测器感知真实 GPU 显存/利用率与 CPU 负载，自动暂缓放行队列中的下一个作业。
- **不同机器互不阻塞**：锁槽按 `(machine, resource)` 独立分配（默认每机 `gpu: 1` 槽、`cpu: 1` 槽，可按机覆盖）。
- **零侵入向后兼容**：`mesh_run` 默认 `resource="none"`（保持现有立即执行行为）；仅当传入 `resource="gpu"` 或 `resource="cpu"` 时进入算力排队锁。

## 2. 架构组件

| 模块 | 路径 | 职责 |
|---|---|---|
| 硬件忙闲探测器 | `remote/agent/compute-probe.js` | 探测本机 NVIDIA GPU（`nvidia-smi` 显存占比/利用率）与 CPU 负载，输出 `gpuBusy` / `cpuBusy` 快照 |
| 算力排队引擎 | `remote/server/mesh-compute-queue.js` | 维护持久化 FIFO 队列（`dataDir/mesh-compute-queue.json`），结合槽位占用与外部硬件忙闲决定是否放行 |
| Mesh RPC & HTTP | `remote/server/mesh.js` | 暴露 `GET/POST /api/mesh/queue` 及 `fromAgentRpc` 的 `op === 'queue'`（`enqueue / poll / heartbeat / complete / cancel / list`） |
| 作业执行器 | `tools/ame-mesh.js` | `mesh_run` 新增 `resource: 'none' | 'gpu' | 'cpu'`；排队型作业在后台 worker 内先入队轮询拿槽，拿到槽后再 spawn 真正计算命令，结束后自动回报 `complete` 释放槽位 |

## 3. 硬件忙闲默认判定阈值（外部占用保护）
- **GPU 忙（`gpuBusy = true`）**：任意 GPU 显存占用率 **≥ 15%** 或 GPU 利用率 **≥ 25%**（且当前没有本队列自己正在跑的 `gpu` 作业时，判定为外部手工进程占用，队列暂停放行直至释放）。
- **CPU 忙（`cpuBusy = true`）**：1 分钟平均负载 / 逻辑核数 **≥ 0.85**（Linux/macOS）或 Windows CPU 负载超阈值。
- **陈旧/崩溃自愈**：`running` 作业每 30 秒续租心跳；超过 `staleTimeoutMs`（默认 10 分钟）无心跳则自动标记为 `failed` 并释放槽位，避免死锁队列。

## 4. 接口契约
- **MCP `mesh_run`**：新增可选参数 `resource: "none" | "gpu" | "cpu"`（默认 `"none"`）。
- **HTTP**：
  - `GET /api/mesh/queue` → `{ ok: true, jobs: [...], slots: { ... } }`
  - `POST /api/mesh/queue` → `{ op: 'cancel', jobId }` / `{ op: 'clear_done' }` / `{ op: 'set_slots', machine, gpu, cpu }`
