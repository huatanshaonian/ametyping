# 完整会话与三层记忆

NAS 上的 `data/knowledge.sqlite` 是主库。它与可重建的 `search.db` 不同，不能删除重建。服务端需要 Node 22.13+（支持内置 `node:sqlite`）；各机器保留自己的工具、账号、密钥和代理。

## 完整采集

agent 默认启用，可用 `agent.json` 的 `"fullArchive": false` 关闭。原先的精简记录仍用于看板的实时对话，不改变旧历史。新增的独立通路采集：

- Claude：`~/.claude/projects/**/*.jsonl`，含子代理和历史会话；同时保存其中 `tool-results` 与 `attachments` 目录的原始文件，补齐落在旁文件中的长工具输出。
- Codex：`$CODEX_HOME/sessions/**/*.jsonl` 和 `archived_sessions/**/*.jsonl`，含子线程；默认 `CODEX_HOME=~/.codex`。
- OpenCode v2：插件记录完整事件（含运行中的文本增量、工具事件、子会话）；agent 每分钟通过只读 SQLite 查询发现历史与子会话 ID，再通过正式 `session export` 导出会话，并采集 XDG 数据目录中 OpenCode 的 `tool-output` 旁文件。仅依赖内部表的 ID 和更新时间；结构不兼容会明确报错并重试，不伪称完成。

每个源文件按 512 KiB 分块，每块 SHA-256，数据库事务提交后才确认；重连先核对已保存尾块，续传后再校验整个文件。改写或截断生成新版本，旧版本保留。最近一次扫描结果每分钟更新，已有文件在下一轮传输时检测变化，不限历史天数、不截断长行。全部内容是源工具已经保存/导出的内容，不代表工具未公开的内部状态。

数据库中 `sources` 保存机器、会话、父会话、来源、工作目录、字节数和完整性；`chunks` 保存原始字节。看板「控制面板 → 记忆与存档 → 完整会话」显示采集进度、SHA-256 校验状态并支持原文下载。API 支持分页查询及按机器、会话过滤。原始记录可能包含会话中本就存在的敏感内容，接口沿用登录认证；不采集账号配置或私钥文件。

OpenCode 正式导出只包含已稳定的消息，运行中的细节由事件日志补充。事件日志用于追溯，不作为工具重放队列。内联附件随原生记录保存；仅以路径引用的外部文件、工作区、运行中的进程和模型未公开状态不属于原生会话文件，需要独立恢复。

## 记忆范围

| 范围 | 归属 | 导出位置 |
| --- | --- | --- |
| 共享全局 | 所有机器 | 各机器工具的全局入口 |
| 机器 | 指定的 agent 机器名 | 仅该机器的全局入口 |
| 项目 | 稳定项目 ID | 仅已登记机器与项目目录 |

同一项目可登记 Windows、Linux、macOS 不同的绝对路径。项目目录必须在 agent 已开放的文件范围内且不是只读目录。共享全局和机器记忆在全局入口组合；项目入口只附加本项目记忆。内容按范围标注、按名称排序，不通过模型擅自解决语义冲突。

工具入口：

- Claude：`~/.claude/CLAUDE.md`；项目根 `CLAUDE.md`。
- Codex：`$CODEX_HOME/AGENTS.override.md`（若存在），否则 `AGENTS.md`；项目根 `AGENTS.md`，若存在 `AGENTS.override.md` 也补入相同项目内容，避免 override 遮蔽。
- OpenCode v2：`$XDG_CONFIG_HOME/opencode/AGENTS.md`（默认 `~/.config`）；项目根 `AGENTS.md`。

正文超过 16 KB 时，入口生成目录索引，全文以 Markdown 保存在 `~/.ametyping/memory/exports/`，不截断正文；索引超过 24 KB 会报告错误，要求拆分范围，不静默丢弃。工具自身的指令长度上限仍适用，原文件已经很长时应在看板整理。

每份输出只替换 `<!-- ametyping-memory:start -->` 与 `<!-- ametyping-memory:end -->` 之间的内容，其余原文保留。写入前备份至 `~/.ametyping/memory/backups/`，使用临时文件原子替换。托管区块的本地修改、缺失、重复标记和符号链接会报告冲突。失败不会宣称已同步；同一目标可能部分文件已更新，修复冲突后重试。项目路径迁移、移除映射或 Codex override 入口变化时，会清理旧入口中仍然匹配的托管块并保留本地原文。正在运行的工具何时重读记忆由工具自身决定，新会话使用新内容。

## 来源与发布

各机器的全局说明、Claude 自动记忆、Codex `memories` Markdown，以及登记项目的说明和 Claude rules 会作为来源单独入库，保留每版正文与来源哈希。`memory.confirmedDir` 可指定已确认的 Markdown 发布快照目录；默认不扫描任意个人文档目录。

采集来源不会自动变成所有机器的指令。在「记忆来源」里查看、选择归属、编辑正文，再导入发布。可勾选「接管来源」：来源原文在哈希仍匹配且目标输出成功时先备份，再移入统一管理，避免本地旧规则和 NAS 新规则重复；已确认的发布快照永不改写。未勾选时保留原来源，便于分阶段迁移。

在「统一记忆」里可新增、编辑、停用和查看修订历史，选择历史版本后可编辑为新修订。保存有乐观并发控制，旧版本页面不能覆盖别人刚保存的新内容。每次发布立即下发到在线机器，离线机器重连后取得最新版本。只有允许控制的机器才写入；`"memory": false` 完全关闭本机记忆功能，`"memory": {"autoApply": false}` 可只采集、不自动写入。只采集模式的发布在看板保留为未应用状态，不会自动改变已有文件。

agent 无需轮询 NAS API，使用现有已认证的出站 WebSocket。「同步状态」查看每台机器的结果和冲突。「预览组合」显示该机器实际将收到的全局、机器和项目内容。NAS 本机可在服务端配置启用 `"knowledge": {"local": true}`，通过同一协议采集和应用，无需额外服务。

## 逐条记忆、对齐和智能整理

「统一记忆」按条显示范围、归属、正文预览、全文、来源和修订，支持搜索、范围筛选及启用/停用。一条记忆可以是一件独立事实；原来导入的长文可通过「拆成逐条记忆」生成拆分方案。

在统一记忆或记忆来源中勾选内容，进入「对齐与智能整理」：

1. 「核对所选原文」展示原文、行差异和重复/相似线索。相似度只用于找线索，不能判定两个事实是否相同或矛盾。可手动编辑合并正文并生成待审阅方案。
2. 「智能整理所选」将明确勾选的内容发送给所选模型，建议去重、核对冲突、调整范围或一事一条拆分。每次最多 30 条、180 KB，超过时要求分批，不截断或自动扩大发送范围。
3. 模型只生成方案，不直接改写记忆。每组列出原因及拟新增、修改、停用的内容，正文、名称和归属可审阅修改。选择完整分组后应用，拆分组内的新增和停用一起提交；任意操作失败会回滚整批。
4. 方案绑定原记忆修订和来源哈希。分析后任一所选来源改变时，旧方案不能覆盖新内容，需重新核对。每次应用保留最终编辑、所选分组、修订及 `memory-review:<id>` 来源；未选择分组不会自动应用。服务重启后未完成的分析明确标为失败，不重放操作。

默认「仅使用 API」：标准 Claude 模型使用「控制面板 → AI 模型 → Claude API」配置；NAS 的 API 别名可直接调用其 Anthropic 兼容 Messages 接口，沿用 NAS 本机的密钥、默认模型和网络。地址支持 `/anthropic` 等路径前缀。兼容接口明确拒绝结构化输出参数时，会使用纯 JSON 要求重试，响应仍须通过方案验证。该模式失败不会切换 CLI；接口仍需支持流式文本响应。可在「AI 模型 → 记忆智能整理」选择模型与强度。

关闭「仅使用 API」则沿用现有 AI 通道及后备策略，可能通过 API、Claude Code 或 Codex 执行。不会自动复制 Windows 或其他机器的 API 密钥到 NAS。测试使用隔离的本地模拟 API，不消耗真实模型额度。

智能整理的快照、方案、状态及实际应用记录存放在同一 SQLite 的 `memory_reviews` 和 `memory_review_applies` 表中，随数据库一致备份。

## OpenCode 接力导出

已校验的 Claude/Codex 原始记录可以下载为 OpenCode v2 的导入 JSON。普通用户/助手文本保留对应角色；工具、压缩及未知事件变成明确标注的历史材料，不假造待执行调用。每次导出创建新的会话 ID，记录源机器、会话、版本和原文摘要，避免冲突覆盖。

在目标电脑恢复相应项目文件后：

```sh
opencode session import opencode-session.json --directory /目标电脑的项目目录
opencode -s <导入后的会话ID>
```

OpenCode 的原生 JSON 直接通过相同命令导入。事件日志不是导入文件。此功能是历史接力，不是原工具进程快照，也不负责同步整个工作区或重建依赖。

## 备份与恢复

每日备份使用 SQLite 在线备份 API 先生成一致的 `knowledge-backup.sqlite`，tar 排除活动中的 `knowledge.sqlite`、WAL、SHM，纳入一致副本。不得在 SQLite 运行时只复制主文件。恢复时停止服务，将一致副本恢复为 `knowledge.sqlite`，保留待替换数据库与 WAL/SHM 的独立备份，再启动；agent 会从数据库确认的位置续传。

## 验证

```sh
node --test remote/test/knowledge.test.js
node --test remote/test/knowledge-review.test.js
node remote/test/e2e-knowledge.js
node remote/test/real-opencode-archive.js # 已安装 OpenCode 时：隔离数据目录，无模型请求
node remote/test/ui-control.js
```

官方格式依据：[Codex 指令](https://developers.openai.com/codex/guides/agents-md)、[Claude 记忆](https://code.claude.com/docs/en/memory)、[OpenCode v2 指令](https://opencode.ai/v2/docs/instructions/)、[OpenCode 导入导出](https://opencode.ai/v2/docs/cli/commands/)。
