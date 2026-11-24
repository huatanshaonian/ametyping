# AmeMesh 轻量算力排队锁（Mini-Slurm）设计方案

面向多台工作站（如 `remote3090`、`dell97`、`dell211`、`huatanshaonian`）运行电磁求解（FEKO / CuPy MoM）与神经网络训练时的轻量级资源排队与互斥机制，无需部署重型 Slurm。现已升级支持**多卡 GPU 逐卡精确分配、双卡合并原子调度（防饥饿预约）与双路 CPU/NUMA 并发调度**。

## 1. 设计目标与边界
- **解决痛点**：防止多个 Agent 或多个任务同时往同一张 GPU / 同一台高负载 CPU 工作站塞重计算，导致 OOM 爆显存或互相挤死。
- **多卡/双路细粒度并发**：在多卡双路工作站（如 `dell97` 的 2 × RTX 4090 + 双路 Xeon NUMA）上，支持两张卡并行跑单卡作业、双卡合并跑大作业、以及两个 NUMA 节点并发跑 CPU 作业。
- **逐卡感知外部手工任务**：即使你在某台工作站上**手动**占用了 GPU 0（未经过 `mesh_run`），本机 agent 也会通过硬件探测器逐卡上报显存/利用率，调度器自动避开 GPU 0，将 `gpus=1` 作业直接分配到空闲的 GPU 1（不阻塞整机）。
- **双卡合并原子性与防饥饿**：当队头作业申请 `gpus=2` 或 `gpus="all"` 且当前仅剩 1 张卡空闲时，调度器激活 **Head-of-Line（HoL）预约**，防止后到的 `gpus=1` 作业无限插队饿死双卡作业；等全部所需卡同时空闲后原子分配 `[0, 1]`。
- **零侵入向后兼容**：`mesh_run` 默认 `resource="none"`（保持现有立即执行行为）；仅传 `resource="gpu"` 或 `resource="cpu"` 时默认申请 `gpus=1` 或 `numa=1`，完全兼容旧单槽行为。

## 2. `dell97` 双卡双路拓扑实地调研结果（只读 SSH 实测）

2026-11-24 通过 `ssh dell97` 实测 `nvidia-smi topo -m`、`nvidia-smi --query-gpu`、`/sys/bus/pci/devices/*/numa_node`、`/sys/devices/system/node/node*/cpulist`、`numactl --hardware` 与 `lscpu`：

### 2.1 CPU 与 NUMA 拓扑
- **型号**：2 × Intel(R) Xeon(R) Gold 6230R CPU @ 2.10GHz（2 座，每座 26 物理核 / 52 逻辑线程，共 52 核 104 线程）
- **总内存**：约 125 GiB（Node 0: 64079 MB，Node 1: 64439 MB）
- **NUMA 距离**：本地 `10`，跨路（UPI）`21`

| NUMA 节点 | `cpulist`（`/sys/devices/system/node/node*/cpulist`） | 逻辑核数 | 内存大小 | 挂载 GPU |
|---|---|---|---|---|
| `node0` | `0-25,52-77` | 52（26 物理核） | 64079 MB | GPU 0（RTX 4090） |
| `node1` | `26-51,78-103` | 52（26 物理核） | 64439 MB | GPU 1（RTX 4090） |

### 2.2 GPU 与 PCIe/NUMA 亲和性
- **`nvidia-smi topo -m`**：GPU0 与 GPU1 之间为 `SYS`（跨 PCIe + 双路 UPI 互联，无 NVLink）。
- **sysfs 路径注意事项**：`nvidia-smi --query-gpu=pci.bus_id` 输出 8 位域前缀（如 `00000000:73:00.0`），而 Linux `/sys/bus/pci/devices/` 使用 4 位域小写路径（`0000:73:00.0`、`0000:a6:00.0`），探针已做自动归一化。

| GPU 索引 | 型号 | 显存 | `pci.bus_id` | sysfs `numa_node` | CPU Affinity |
|---|---|---|---|---|---|
| `0` | NVIDIA GeForce RTX 4090 | 24564 MiB | `00000000:73:00.0` | `0` | `0-25,52-77` |
| `1` | NVIDIA GeForce RTX 4090 | 24564 MiB | `00000000:A6:00.0` | `1` | `26-51,78-103` |

### 2.3 绑定工具可用性
- `/usr/bin/numactl`：已安装
- `/usr/bin/taskset`：已安装
- `/usr/bin/lscpu`：已安装

## 3. 架构组件

| 模块 | 路径 | 职责 |
|---|---|---|
| 硬件忙闲与拓扑探测器 | `remote/agent/compute-probe.js` | 逐卡解析 `nvidia-smi`（`index/name/pciBusId/memUsedMiB/memTotalMiB/utilPct/busy/numaNode`）与 Linux sysfs NUMA 拓扑（`cpuCount`/`numaNodes`），保留 `hasGpu`/`gpuBusy`/`cores`/`cpuBusy`/`load1` 向后兼容 |
| 细粒度算力调度引擎 | `remote/server/mesh-compute-queue.js` | 维护持久化 FIFO 队列（`dataDir/mesh-compute-queue.json`），支持逐卡分配、外部单卡避让、多卡原子合并、HoL 防饥饿预约、双路 NUMA 并发与 GPU→NUMA 亲和信息计算 |
| Mesh RPC & HTTP | `remote/server/mesh.js` | 暴露 `GET/POST /api/mesh/queue` 及 `fromAgentRpc` 的 `op === 'queue'`（`enqueue / poll / heartbeat / complete / cancel / topology / list`），透传 `gpus` 与 `numa` 参数 |
| 作业执行器与环境注入 | `tools/ame-mesh.js` | `mesh_run` 支持 `resource`、`gpus`、`numa`；拿到槽位后向子进程自动注入 `CUDA_VISIBLE_DEVICES`、`AME_ASSIGNED_GPUS`、`AME_ASSIGNED_NUMA`、`AME_ASSIGNED_CPUS` 及单 NUMA CPU 作业的 `OMP_NUM_THREADS`（不覆盖用户显式设置） |

## 4. 硬件忙闲判定阈值与调度策略
- **单卡 GPU 忙（`gpu.busy = true`）**：单卡显存占用率 **≥ 15%** 或算力利用率 **≥ 25%**。
  - 若某卡不在队列 `running` 作业的 `assignedGpus` 中且 `gpu.busy === true`，判定为外部手工进程占用，调度器自动跳过该卡，仅从空闲卡中分配。
  - `gpuBusy` 顶层字段保持向后兼容：当机器上**所有** GPU 均忙时为 `true`。
- **双卡/多卡合并与 HoL 防饥饿**：
  - 申请 `gpus=2` 或 `gpus="all"` 时，必须等到空闲卡数 ≥ 请求卡数才原子分配（如 `[0, 1]`）。
  - 若队头存在合法的多卡请求（`1 < reqCount <= totalGpus`）但当前空闲卡不足，调度器立即建立 HoL 预约，后续 `gpus=1` 作业不得插队抢占剩余空闲卡。
- **双路 CPU/NUMA 调度与 GPU 亲和**：
  - Linux 自动从 `/sys/devices/system/node/node*/cpulist` 发现 NUMA 槽位（Windows/单路自动退化为 1 个槽位）。
  - 双路机器默认可并发运行 2 个 `numa=1` CPU 作业（各自获得独立 NUMA ID 与 `cpuList`），或 1 个 `numa=2`/`"all"` 整机作业（同样具备 HoL 防饥饿）。
  - GPU 作业分配卡号后，自动附带所分配 GPU 对应的亲和 `assignedNuma` 与 `assignedCpus`（例如 `dell97` 拿到 GPU 1 时，同时带出 `AME_ASSIGNED_NUMA=1`、`AME_ASSIGNED_CPUS=26-51,78-103`）。
- **陈旧/崩溃自愈**：`running` 作业每 30 秒续租心跳；超过 `leaseMs`（默认 10 分钟）无心跳则自动标记为 `failed` 并回收其占用的 GPU/NUMA 槽位。

## 5. 接口契约
- **MCP `mesh_run`**：
  - `resource: "none" | "gpu" | "cpu"`（默认 `"none"`）
  - `gpus`: 正整数（如 `1`、`2`）或 `"all"`（`resource="gpu"` 时默认 `1`）
  - `numa`: 正整数（如 `1`、`2`）或 `"all"`（`resource="cpu"` 时默认 `1`）
- **子进程自动注入环境变量**（仅在父环境未显式设置时注入）：
  - `CUDA_VISIBLE_DEVICES`：如 `"1"` 或 `"0,1"`
  - `AME_ASSIGNED_GPUS`：如 `"1"` 或 `"0,1"`
  - `AME_ASSIGNED_NUMA`：如 `"0"`、`"1"` 或 `"0,1"`
  - `AME_ASSIGNED_CPUS`：如 `"0-25,52-77"` 或 `"26-51,78-103"`
  - `OMP_NUM_THREADS`：单 NUMA CPU 作业按该 NUMA 节点估算物理核数自动设置（如 52 逻辑核 → `26`），防止跨路抖动
- **HTTP**：
  - `GET /api/mesh/queue` → `{ ok: true, jobs: [...], slots: { ... }, topology?: { gpus, numaNodes } }`
  - `POST /api/mesh/queue` → `{ op: 'cancel', jobId }` / `{ op: 'clear_done' }` / `{ op: 'set_slots', machine, gpu, cpu }`
