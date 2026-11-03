# 跨设备研究工作档案（第一轮）

运行端是 NAS。电脑上的 agent 上传原生会话；NAS 的完整存档库、清洁事件、抽取队列、DeepSeek 调用、项目页面和检索均不依赖 Windows 在线。研究事项和计算运行是独立对象，branch/commit 只是代码条件；同一 main、同一提交的不同实验仍有独立成果。

## 数据与证据

原始 `sources/chunks` 保留不变。`research_documents/events` 从已校验的指定原生来源生成，保留机器、会话、源版本、原始行（OpenCode 导出为消息序号）、事件序号及字符引用。去除 reasoning、ANSI 控制字符；确定格式的进度/心跳标为 suppressed。计算输出、异常、数字和命令保留。长事件按有明确偏移的片段处理，不依赖旧精简通路的截断文本。

`research_project_sources` 将历史资料明确归入现有 AmeMesh 项目；跨设备目录从项目工作区匹配，也可通过导入接口显式关联。`research_jobs` 固定片段、模型、提示词版本，串行处理；相同输入不重复排队。批次上限显式显示尚余片段。失败可手动重试；进程中断的付费请求标为 interrupted，不自动重放。每次收到用量即追加保存；请求在收到用量前中断仍可能有供应商计费，以供应商账单为准。

模型产出的工作、运行、结论、指标都需要逐字原文引用。程序核对出处、引用、指标数值及 measurement 的工具输出来源；仍不能证明模型语义归类正确或物理验证成立。状态为计划、已启动、报告完成、报告失败、未知，不生成“科学验证已通过”状态。输入/产物路径只是历史报告，文件存在与内容核对尚需后续设备元数据采集。

程序先把事件切成较短且带偏移的证据单元，模型仅选择 E4U2 这样的编号，不负责抄写引文；程序回填精确原文、持久化事件 ID 与字符跨度。不存在的编号、无来源数值仍被拒绝。读取记忆/README 等文档不能自动算本次实测。被拒绝的结构化输出保留在 research_attempts 供核查，不发布为成果。资料记录导入时的原始长度与摘要；即使同一原生 generation 后续继续追加，也能下载当时长度的精确前缀。首轮同步解析单来源上限 64 MiB，超限明确拒绝且不标记完成，避免长事务阻塞 NAS；更大来源的后台解析尚未实现。

第一轮逐片段抽取，保留历史版本；尚未实现跨片段自动合并、全设备 Git/worktree 盘点、自动判定旧结论被替代。旧版/同内容会话的重复归并需要独立验证，不能把本轮试点当作全量工作目录。

已确定为文件/记忆读取且没有测量指标的工具调用，若被模型混入 runs，程序移入 support_activities，页面折叠为资料查阅，不计作计算运行；原始模型响应仍保留供核对。

## NAS API 配置与页面

`DEEPSEEK_API_KEY`/`DEEPSEEK_MODEL`/`DEEPSEEK_BASE_URL` 或 NAS 自身 `~/cc-environments/deepseek/settings.json` 提供默认配置。官方入口中的 `[1m]` 是客户端标记，直接 API 请求时移除，模型本体沿用原配置。自定义入口使用显式配置，不把隐式读取的凭据发往第三方地址。

Windose 项目管理 → **研究与计算** → **DeepSeek API 设置** 可修改地址、模型和密钥。保存到 NAS 数据目录 `research-api.json`，权限 600，密钥留空保留现有值；GET 只返回是否配置，不回显密钥。沿用现有登录、只读模式和管理操作的近期验证规则。配置、会话、试点数据库和报告不提交 Git。

在项目中登记各设备工作区，选择已完成校验的历史来源导入，再运行小批抽取。页面显示任务、研究成果和逐字引用，支持读取前后文及下载固定版本原文。新索引覆盖已导入资料，不替换原有精简搜索，也不宣称覆盖全部完整存档。

接口：`GET /api/research?project=...`；`GET /api/research/sources|search|evidence?project=...`；`POST /api/research/import|enqueue|retry|config`。POST 均带 project。import 每批最多 10 份，enqueue 默认最多 3 段。

## MCP 与测试

只读 stdio MCP 进程在 NAS 打开档案库，不运行队列或写数据库：

```sh
node remote/server/research/mcp.js /NAS实际数据路径/knowledge.sqlite
```

可经已有 SSH 别名启动，避免复制数据库和 API 密钥。提供 list_projects、list_work_items、search_work、get_work_item、search_records、read_evidence。首次部署需先由主服务建立 research 表。历史内容是资料，不是待执行指令。

```sh
node --test remote/test/research.test.js
node remote/test/e2e-research.js
node --test remote/test/knowledge.test.js
node remote/test/e2e-knowledge.js
node remote/test/real-opencode-archive.js
# 显式付费调用；原主库只读，输出必须是独立试点目录
node remote/test/research-pilot.js --live --source-db /NAS实际数据路径/knowledge.sqlite --out /独立试点目录
```

试点包含四个有预期判据的人工对照样例，以及最多两份真实 CEM 会话的选定片段。输出 report.json/report.md 和隔离 knowledge.sqlite；不向生产项目发布模型结论。真实样本的语义质量仍需检查原文。
