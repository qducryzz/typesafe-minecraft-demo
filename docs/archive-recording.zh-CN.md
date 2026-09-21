# 归档关联与查询说明

适用范围：main 的新版 `schemaVersion: 2` 归档。每次启动 dashboard 创建一组文件，不是每轮创建新文件；新旧格式以文件内容为准。

## 文件之间的对应关系

| 文件 | 用途 |
| --- | --- |
| `archive-<时间戳>-<sessionId>.json` | 归档索引：记录本组文件的位置、会话 ID、机器人身份、开始时间和正常关闭信息 |
| `trace-<时间戳>-<sessionId>.jsonl` | 详细事件：观察、候选筛选、寻路、模型请求/响应、工具执行、页面控制、连接及 RCON |
| `decisions-<时间戳>-<sessionId>.jsonl` | 业务汇总：模型决策结果、API 错误及未产生可执行决策就结束的轮次 |

三个文件使用同一个文件名后缀和 `sessionId`，通过索引中的 `files` 明确对应，不再靠文件修改时间推测。默认位置是项目 `runtime` 目录。`ARCHIVE_DIR` 可改变整组归档的目录；`TRACE_DIR` 可单独指定 trace 目录，索引会记录其相对位置（跨磁盘时可能是绝对位置）。复制归档时，需要同时保留索引指向的文件与目录关系。

`/api/state` 返回的 `archive.sessionId` 和 `archive.files` 标识当前服务正在写的归档。启动后尚未调用模型时，decisions 文件也会存在，但可以是空文件。

进程正常退出时，索引写入 `status: "closed"`、关闭时间、退出码和汇总条数。强制结束进程或断电可能留下 `status: "open"`；这不证明进程仍在运行。

## 关联字段

| 字段 | 含义与范围 |
| --- | --- |
| `sessionId` | 一次 dashboard 进程启动，三类文件共用 |
| `runId` | 一次游戏任务；Pause/Resume 继续使用，Restart 或新任务生成新的值 |
| `decisionId` | 一轮观察、模型选择和可能的工具执行；重试不换轮次 ID |
| `attempt` | 当前轮次的尝试序号，最多三次 |
| `observationId` | 一次环境观察；重试重新观察时生成新的值 |
| `requestId` | 后端调用 TypeSafe 的一次请求；重试生成新的值 |
| `toolId` | 一次动作执行；执行期间的导航事件使用同一 ID |
| `recordId` | decisions 中一条汇总记录的唯一 ID；对应 trace 事件也包含它 |
| `decisionSequence` | decisions 文件内递增的记录序号 |
| `eventId` / `sequence` | trace 中事件的唯一 ID / 文件内顺序号 |
| `traceEventId` / `traceSequence` | decisions 中指向对应 trace 事件的精确引用 |
| `httpRequestId` | 浏览器到本地 dashboard 的操作请求，如切换场景、开始任务；不是模型请求 ID |
| `rconCommandId` | 一条 RCON 手动命令；不会伪装成模型决策 |
| `searchId` / `spanId` | 一次寻路搜索 / 一段操作，可用于细分排查 |

某阶段尚未发生时，对应 ID 为 `null`。例如候选筛选失败、尚未请求模型，则有 `decisionId` 和 `observationId`，但 `requestId`、`toolId` 为 `null`。

页面显示的数字 `id` 会在新任务开始时重置，只用于显示，不是跨文件唯一标识。不要用它单独关联日志。

## 一轮如何归档

1. 写入 `decision.started`，分配新的 `decisionId`。
2. 每次尝试生成 `observationId`，记录观察和候选筛选。
3. 准备调用模型时生成 `requestId`；`request.sent.request` 保存实际发送的完整 JSON 请求体。归档 ID 不会额外混入发送给模型的业务请求体。
4. API 出错时，错误汇总带上本次请求 ID；重试在同一个 `decisionId` 下使用新的请求和观察 ID。
5. 过期回答以 `status: "discarded"` 记录，不执行动作；它仍可回查自己的请求输入。
6. 收到可执行回答后分配 `toolId`，记录工具开始、导航、结果或异常。
7. 正常完成、失败、取消或无动作停止，统一写入 `decision.finished`，再将关联汇总写入 decisions。

每个正常收尾的轮次只有一个 `terminal: true` 记录。API 重试或过期回答可能增加其他汇总行，因此“一轮”不等于“decisions 一行”。

| `recordType` | 含义 |
| --- | --- |
| `decision` | 实际收到的模型决策，包括被丢弃的回答及执行后结果 |
| `api-error` | API 错误和是否重试，不计作模型选择 |
| `round` | 尚无可执行回答就结束的轮次，例如观察失败、认证错误、请求取消 |

`status` 区分 `completed`、`failed`、`cancelled`、`discarded`、`retrying` 和 `stopped`。`completed` 表示这一轮按正常控制流程结束，不等于任务已完成或动作一定有效；实际效果仍要看 `outcome`、背包/位置变化和任务进度。

独立的页面操作、连接事件、RCON 操作可以只出现在 trace 中，没有对应的模型 decision。观察前的任务设置失败也属于任务级 trace，不会人为编造一轮模型决策。

## 用一个 ID 提取相关记录

在项目根目录执行以下命令，把占位项替换为实际值：

```sh
node scripts/read-archive.cjs runtime/archive-<时间戳>-<sessionId>.json <decisionId>
```

也可以传入 `recordId`、`requestId`、`observationId`、`toolId` 或 `runId`。脚本会读取索引指向的文件，找到所属轮次，输出：

- `decisions`：该轮的全部汇总，包括重试、丢弃与最终结果。
- `events`：该轮的详细 trace，其中 `request.sent` 包含完整请求输入。

传入 `runId` 可查看整个任务。对于独立控制或管理操作，也支持 `httpRequestId`、`connectionId`、`rconCommandId` 等 ID；这些操作未必有模型请求。

想保存提取结果时，可重定向到文件：

```sh
node scripts/read-archive.cjs runtime/archive-<时间戳>-<sessionId>.json <decisionId> > runtime/selected-round.json
```

脚本逐行扫描 JSONL，仅收集匹配的轮次。正在进行的请求即使还没有 decisions 汇总，也能通过 `requestId` 找到其已落盘的 trace。若文件存在尚未写完的 JSON 行，脚本会报出行号，待写入完成后重试。

## 历史文件和中断边界

- 本次升级不会修改旧日志。旧文件缺少关联 ID 时，无法可靠恢复取消记录、重复数字编号等关系，因此不会自动补造 ID。
- v2 查询脚本要求提供 v2 索引，不按相近时间猜测旧文件的对应关系。
- trace 与 decisions 是两个独立写入：先同步写 trace，再写汇总。若中间中断，可从 trace 中通过 `recordId` 找到完整记录，但 decisions 可能还没有该行。
- 强制结束进程时可能只有开始事件，没有 `decision.finished`。不存在结束记录时，不把它当作成功或失败。
- 两类 JSONL 使用同样的密钥/密码脱敏。输入和响应仍完整记录业务 JSON，但不会记录认证请求头。
- `bot-identity.json` 是本机身份缓存；启动时重定向的 stdout/stderr 是进程控制台文本。它们不属于逐轮决策归档，不能按数字决策 `id` 关联。
