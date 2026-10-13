# Session Link 任务级模型路由与决策回报 Execution Plan

> **历史文档，已由 0.5.0 纯插件版本取代。** 下文保留原实验阶段的计划、结论和源码引用；被删除的任务模块、宿主扩展要求及任务面板不再属于当前产品。不要按本文启动开发或推断当前能力。当前依据：[README](README.md)、[IMPLEMENTATION](IMPLEMENTATION.md)、[历史处理决定](docs/decisions/001-plugin-only-initial-model.md)。

> **2026-10-13：已被替代，仅保留历史。** 用户已将范围收缩为“纯插件、新建会话初始选模”，下一轮以[纯插件新计划](<MODEL_ROUTING_PLUGIN_ONLY_PLAN.md>)为准。不再按本文继续开发宿主扩展、task scope、fallback 或任务状态机。当前源码尚未回退；历史正文保持原样。

## Goal

让一个普通顶层 Session 为另一个互联 Session 指定可用模型执行任务，尤其支持新建顶层 Session 时选模：

- 默认仅本次任务使用，显式 `model_scope: "session"` 可持续切换目标会话。
- 模型不可用时执行用户授权的有序 fallback；没有策略或候选耗尽则通知发起 Session 决策。
- 模型与任务绑定，排队、并发、失败、取消和重启后不串模型、不静默降级、不重复执行已发生的工具副作用。
- 保留独立顶层会话、双向互联、非人类消息归因、预算和投递幂等语义。

本文件是实施计划，不是已实现功能说明。当前仅做源码/已安装 SDK 检查，未运行新增功能测试或修改运行中的插件。

## Context

### 已确认的实现事实

- [src/tools.ts](src/tools.ts)：四个 Agent-scoped 工具；`requireCaller` 校验精确 live caller。spawn 先查询 `spawnReplay`，用 caller/callId 派生 Session ID，create → claimSpawnLink → rename → send。
- [src/link.ts](src/link.ts)：`admission`、`deliverTarget`、`inputFor`、`confirmDurable` 实现持久化 mailbox、顺序投递、唤醒预算和收据；`tail` 串行化 admission，不是任务执行调度器。
- [src/types.ts](src/types.ts)、[src/spec.ts](src/spec.ts)：`queued/accepted` 是投递结果；`delivered` 只表示目标已持久化，不等于任务成功。现有 `attempts` 是冷目标恢复尝试次数，不能复用为模型候选尝试次数。
- [src/client/turn.ts](src/client/turn.ts)：spawn 卡片严格解析第一段结果文本。扩充输出不能无意破坏旧卡片和旧日志回放。
- [IMPLEMENTATION.md](IMPLEMENTATION.md)：当前独立插件约束包括不修改 DSH、保留 `session_link` v1、客户端 React-only 运行时导入。
- 已检查安装的 SDK `0.2.0-rc.2`：`SessionController.modelCatalog()` 可读模型目录；`create()` 没有模型参数；`selectModel()` 调用会更新应用默认模型。
- SDK 的 API Session model-selection 控制器在没有待消费选择时，会回退到最近 request header。仅覆写一次 `agent/request` 可能让临时模型成为后续事实默认。
- SDK 提供 `agent/inbox/claimed`、`agent/pre-step`、`agent/request`、`agent/request-error` 和 `installModelSelection` 等扩展点，但尚未证明它们组合后能提供独立的长期模型基线、可恢复任务暂停、准确的选择优先级和卸载安全。
- [scripts/test-host.mjs](scripts/test-host.mjs) 要求 `DSH_SOURCE_ROOT`；普通 `pnpm test` 不覆盖 host suites。[VERIFICATION.md](VERIFICATION.md) 是旧版本验证结果，不是本功能的证据。

### 架构决定：宿主负责执行边界，插件负责任务协议

不以“发送前 selectModel、结束后切回来”、修改 Agent 私有字段、叠加第二个 model-selection owner 或 monkey patch 实现。

完整功能依赖一个**宿主拥有的任务执行/选模能力**：能将独立模型覆盖绑定到特定任务回合，保持会话长期基线，提供持久化暂停/恢复与执行事件。插件负责选模策略、任务记录、授权校验、fallback 决策和回报 outbox。

实施第一步是验证部署宿主是否已有满足这些契约的公共能力。当前检查的 SDK 尚无已确认满足全部要求的接口，因此完整交付有宿主能力依赖；不可把这一点埋进插件实现。

- 若宿主已有等价公共接口，使用它并做契约测试，不新增宿主框架。
- 否则先提供最小宿主 API 扩展及测试，再由插件接入。宿主源码修改/发布须单独确认执行位置与权限；本计划不授权修改安装包或运行中的 profile。
- 旧宿主继续运行原有四工具；新增 model 参数必须明确返回 `HOST_CAPABILITY_UNAVAILABLE`，不可默默按默认模型执行。
- 这使“插件仍可独立安装”保持成立，但完整新功能要求支持该能力的宿主版本；不能宣称旧 SDK 已完整兼容。

## Constraints

1. 不修改用户的应用默认模型。持久切换只影响目标 Session；目标用户后来的明确选模优先，使用 revision/CAS 防止旧任务覆盖新选择。
2. “本次任务”是一条任务消息触发的完整目标 turn，含多次模型调用、工具调用和该 turn 内的 steering；不包含后续新消息或新 turn。业务级多轮任务须逐次显式传策略。
3. 非指定模型的旧消息调用、权限和投递状态保持兼容；不要求把全部旧消息升级为任务。
4. 模型目录只是部署当前声明的候选，不是 API 调用一定成功的保证。不通过真实收费请求做预检。
5. 不共享凭据、不打印密钥/原始 provider 响应。跨 Session 状态是非人类输入，不能升级成人类指令。
6. 模型不可用、权限拒绝、取消、存储错误、普通工具失败是不同问题；后四者不能触发模型 fallback。
7. 不增加无限重试、后台忙轮询、隐式跨 turn 继续，或跨会话自动批准操作。
8. 不承诺工具副作用 exactly-once。状态/通知可去重；外部工具执行的未知结果须如实报告，禁止自动从头重放。
9. 不创建分支/工作树，不触碰现有未跟踪的 prototypes 目录；修改旧文件前重新读取。

## Public Contract

以下为确定的产品契约；宿主接口的实际符号名在 Task 1 中映射，不假定当前 SDK 已存在。

### 1. 工具参数

`session_spawn_linked_session` 与 `session_send_session_message` 追加：

```ts
provider?: string
model?: string
reasoning_effort?: string
model_scope?: "task" | "session" // 选模时默认 task
on_model_unavailable?: {
  fallbacks: Array<
    | { provider: string; model: string; reasoning_effort?: string }
    | { use: "session_default" }
  >
  if_exhausted?: "notify_sender" // 本期唯一终止策略，也是默认值
}
```

- provider/model 必须成对；不猜 provider，不允许孤立 effort。`model_scope` 和 fallback 策略要求同时指定主模型。
- 全部省略保持旧行为；指定模型即进入 tracked-task 路径。
- 省略 effort 使用所选模型的 adapter 默认，不跨模型继承旧 effort。
- fallback 最多 4 个，加主模型最多 5 个候选；重复候选/重复 default 拒绝，严格校验空字符串和未知字段。
- `session_default` 在任务首次 activation 时解析为目标会话的长期基线，并将具体 route 固化到该 decision attempt；不是发起者模型。新建会话在创建时快照宿主默认作为自身基线，不能让首次临时请求变成基线。
- 首次 spawn 预检 default 候选可使用计划创建基线的快照；重放不得重新采样。已有会话的 default 在执行边界解析，预检不得保证未来可用。
- `session` 模式下，将**最终成功使用的 route**作为长期选择；不是失败的主模型。提交点为首次成功模型响应持久化时，与成功 route 的执行事实绑定。不成功不修改基线。
- 基线提交必须 CAS：任务 activation 后用户已经修改长期选择，则不覆盖；任务继续使用自己的 route，并回报 `persistent_selection_skipped: human_selection_changed`。
- 在 task 模式中，用户修改长期基线只影响后续任务；当前任务路由保持绑定。UI 必须区分本次实际 route 与长期基线。

### 2. 新工具

- `session_list_models(provider?, model?)`：部署可用目录、effort/default、provider 级查询失败及能力标记；不复用含义不同的 subagent 目录。精确 model 过滤必须带 provider。不得输出凭据。
- `session_get_task(task_id)`：原始发起者或目标 Session 可查；返回 task 状态、revision、投递关联、已使用 route、fallback 尝试及最近问题。原始双方在 unlink 后仍可读自身任务，不授予第三方权限。
- `session_resolve_task(task_id, expected_revision, action, …)`：仅原始发起 Session可作跨会话决策；`action` 为 `retry | continue | cancel`。retry/continue 可给新主模型与 fallback 策略；省略则沿用原策略。工具 callId 同时作为决策幂等键。
  - retry：仅确定尚无成功模型响应、无工具派发的 `not_started` 任务。
  - continue：仅有宿主可恢复 checkpoint 的部分执行任务；从边界继续，不重发旧任务正文、不重放已完成工具。
  - cancel：关闭未运行/暂停任务，不能撤销副作用；运行中的取消仍由目标已有的人类/宿主控制路径处理，本工具返回 `TASK_RUNNING`。
  - stale revision 返回当前状态，不执行覆盖；取消可在撤销互联后关闭发起方自己的暂停意图，但 retry/continue 必须重新验证仍有互联授权且目标未归档。

本期不新增“单独立即切换正在运行 Session”的工具；持续切换通过一次任务的 `model_scope: session` 表达，并从该任务开始。

### 3. 返回值与通知

旧调用维持现有字段和第一段文本。tracked-task 返回使用辨别字段：

```ts
// 成功持久化/派发；不等于执行成功
{ outcome: "admitted", taskId, taskRevision, messageId, status: "queued" | "accepted",
  sessionId?, linkId?, taskState, requestedModel, selectedModel? }
// 同步预检失败：任务意图已保存，但可能尚无 Session / mailbox message
{ outcome: "needs_decision", taskId, taskRevision, taskState: "waiting_decision",
  executionState: "not_started", reason, attempts, sessionId?, linkId? }
```

宿主能力缺失、无授权、参数错误属于明确工具错误，不创建任务。可修复的模型不可用返回 `needs_decision` 结构，不伪造 `queued/accepted`。不为这次同步结果再发重复回报。

异步回报由宿主事实产生、插件封装，至少包含：`eventId, taskId, revision, senderSessionId, targetSessionId, kind, requestedModel, actualModel?, executionState, reason?, attempts, decisionRequired, resumable`。

kind 至少覆盖 `model_fallback_selected | model_unavailable | turn_finished | interrupted | cancelled`。`turn_finished` 仅表示执行回合结束，不证明业务目标已验证完成。任务进展详情通过 get_task 查询，避免每个 token/step 都发送通知。

## State and Failure Semantics

### 状态与持久化归属

- mailbox 的 `pending/delivered/cancelled/failed/revoked` 原义不改。
- 独立 task：`preparing → queued → running → turn_finished`；可进入 `waiting_decision`、`interrupted`、`cancelled`、`failed`。
- `waiting_decision` 带 `executionState: not_started | partial | unknown`；仅前者允许 retry。只有宿主确认 checkpoint 可恢复的 partial 才允许 continue。unknown 永不自动恢复。
- 状态发生在真实任务/turn 事件，而不是 `agent/status: idle`（一个 Agent 可以连续处理多个任务）。
- 插件 task 记录是策略/意图与投影；目标 Session 的执行 journal 是实际执行事实。重启时按 taskId/attemptId 对账，不以易失 WeakMap 为唯一状态源。
- taskId 由 caller + 首次 callId 稳定派生；原始请求和策略保存摘要。相同 key 重放返回已有任务，不能改变目标、策略或创建第二个 Session；不同参数要求 resolve_task，不借重放替换。
- 每次人工/发起方新决策生成递增 attemptId；本轮候选及尝试结果不可变地追加，不能通过重启重置预算。

### 自动 fallback 的精确边界

1. admission 做轻量预检，实际 activation 和准备 request 时重新验证。目录失败返回 `catalog_unavailable`，不误报模型不存在。
2. 自动 fallback 只在本 attempt 尚无成功模型响应、工具派发、已展示部分输出或未知外部结果时允许。选择下一模型必须重新组装该 step 的 prompt 和 request config。
3. 可 fallback 的错误限于归一化的路由/模型不可用、模型能力/effort 不支持、provider unavailable、鉴权/额度/限流导致该 route 当前不可服务；必须来自宿主 adapter 的明确分类。沿用宿主既有有限 transient retry 后才进入 fallback，不叠加无限循环。
4. 安全/权限拒绝、内容拒绝、用户取消、工具错误、存储失败不是模型不可用，不换模型绕过。未知错误保守报错并交回决策。
5. 一旦产生响应/副作用或不确定是否执行，停止自动 fallback，保留 checkpoint 并报告 partial/unknown。本期不提供“任务进行一半自动换模型”选项；发起者可显式 continue。
6. 候选耗尽进入 waiting_decision；停止该任务，不阻塞目标后续独立 turn。checkpoint 必须显式处理其与后续会话事件的关系，不允许偷偷回滚 transcript；宿主不支持这种恢复时标记不可继续，发起者另建补救任务。
7. 不自动原地重试已失败候选；新一轮 retry 由明确决策触发。没有时间调度器，本期“稍后重试”由发起者后续调用完成。

### 通知与权限

- 回报归因是 plugin/host 的 task-status，记录真实 target 和 taskId；不是伪造目标 Agent 发言，不把失败文本当指令。
- 使用独立持久化 outbox，通过现有 mailbox 投递/flush/去重基础设施送达，复用唤醒预算；内部入口只收受信任 task 事件，不开放任意 senderId。
- `eventId = taskId + revision + kind`；task 状态与待发送事件在同一记录写入或使用可重放 intent 协议，不能先更新状态再凭内存发通知。
- 原始任务是通知/决策链的根，通知与 retry/continue 不得靠换 messageId 重置 chain wake 上限。通知不自动触发通知，防止 ping-pong。
- 发送回报时重新验证原关联 link。unlink 后不再跨会话投递，不通过别的 link 暗中恢复通道；保留事件及 `notificationBlocked`，供双方查询。
- 发起 Session 不存在/归档/未授权 auto-wake 或预算耗尽时，不强制运行。未授权/预算不足则通知保持 queued；归档/删除按现有策略处理并暴露投递状态。
- spawn 的 `auto_awake` 仍只控制新目标后续唤醒；失败回报不会因此获得唤醒原发起者的权限。初版不添加隐式反向 auto-wake。

## Implementation

### Task 1: 宿主能力契约与最小可运行验证（阻塞后续执行集成）

**Objective**

证明任务级路由可安全实现，并明确需要的最低宿主版本；不把 SDK 假设带进实现。

**Relevant files**

- [package.json](package.json)、[vitest.config.ts](vitest.config.ts)、[scripts/test-host.mjs](scripts/test-host.mjs)
- 已安装 `@deepseek-ai/dsh-agent` 的 runtime-types/model-selection、`@deepseek-ai/dsh-api-session-controller` 的 agent/commands/model-selection-projection 实现。
- 新增宿主契约测试模块（建议 `tests/model-runtime.spec.ts`）；真实宿主源码文件位置在确认可编辑 checkout 后记录到本计划，不修改 node_modules 或安装包作为交付。

**Implementation**

定义一个窄的宿主 task-execution capability，至少覆盖：

- 读长期 model baseline + revision，与 last-used route 分离。
- 将 taskId/attemptId/模型策略关联到唯一 inbox item；领取时生成绑定 turn 的路由租约，在整个 turn 的 prompt assembly 和请求冻结中使用同一选择。
- 选择/替换 route 的安全边界，first-response baseline CAS 提交，不触发全局默认保存。
- 持久化 started/request-used/response-committed/paused/finished/cancelled 事实，可查询、去重和订阅；失败来自实际 adapter，不靠模型自己描述。
- 显式暂停与可选 checkpoint continuation；恢复未知结果时 fail closed；插件卸载后未消费的 model-bound 任务不能变成普通默认模型消息。
- 与图像/能力检查、用户选模、历史回放、compaction、fork 隔离一致。fork 不复制未完成任务执行权，taskId 必须匹配 owner Session。

先写独立契约 fixture，复用真实 AgentLoop/mock adapter，不靠两个互相叠加的选模 waterfall 假装通过。若需要宿主改动，提交最小 API 设计和宿主测试，确认源码目录/权限后再实现；插件任务可先写纯函数和协议测试，但不能发布完整功能。

**Depends on** 无。

**Verification**

A(临时模型)/B(另一模型)/普通人类 turn 的实际 request route；任务中途修改基线；错误/取消/重启/卸载后基线不污染；无全局默认写入；prompt 展示 route 与 request header 一致。

**Done when** 有可调用、可恢复的公共能力及上述真实循环测试证据；否则明确阻塞完整交付，不降级实现语义。

### Task 2: 模型目录、参数规范化与候选策略

**Objective** 提供可发现且可测试的模型选择协议。

**Relevant files**

- [src/tools.ts](src/tools.ts)、[src/types.ts](src/types.ts)、[src/index.ts](src/index.ts)
- 新增 `src/model-policy.ts` 和 `tests/model-policy.spec.ts`。

**Implementation**

实现公共参数 schema、候选规范化、去重/上限、effort 校验、目录失败分类和 session_default 的快照规则。模型目录读使用 `sessionController.modelCatalog()`；执行时使用宿主 route resolver 再校验。目录输出仅是可用目录，不导出任意账户秘密。

注册 `session_list_models`，沿用 per-preset/top-level Agent scope。将 capability 支持情况显式暴露，避免 LLM 猜是否可用。

**Depends on** 公共契约已固定；纯策略测试可与 Task 1 并行。

**Verification** 主 route 成对校验、effort 不继承、catalog failure ≠ 空目录、主模型失效后有序候选、default 晚绑定/快照、错误分类不误触发 fallback、候选次数有界。

**Done when** 目录和策略有独立测试，不会产生真实模型请求或修改 Session。

### Task 3: 持久化任务、状态转换及决策幂等

**Objective** 在不改变既有 mailbox 状态含义的前提下增加 task 协议。

**Relevant files**

- [src/types.ts](src/types.ts)、[src/spec.ts](src/spec.ts)、[src/link.ts](src/link.ts)
- 新增 `src/tasks.ts`、`src/task-spec.ts`、`tests/tasks.spec.ts`。

**Implementation**

使用新的独立 storage domain `session_link_tasks` v1，不改变 `session_link` v1 schema；旧域仅复用已有 message/link identity。以 task 行承载原始请求、spawn intent、attempt history、revision、执行投影、待发 outbox 事件和决策幂等记录。

由于两域/目标 Session 之间没有已确认的跨域事务，使用 write-ahead intent + stable IDs + replay reconciliation：先保存 task intent，再创建/采用 Session、链接、admit mailbox；执行绑定由宿主 durably 关联唯一消息，任何一半写入都可对账。模型绑定 durable 前禁止唤醒/领取该任务。不能仅凭内存 messageId→taskId 表保证执行。

Task 状态按每个 task 串行/CAS；不在全局 mailbox tail 内等模型目录网络调用或任务完成。状态回调也不能等待其自身依赖的 delivery chain。

同步预检模型失败保存 waiting_decision intent，但不创建新 Session、不写伪造 mailbox message。retry 后沿用原始 taskId 与 spawn 的原始 callKey，从而创建同一 Session；参数错误/无权限不留 task。

**Depends on** Task 2；执行关联依赖 Task 1。

**Verification** 逐个写入边界故障注入、崩溃重启、并发 resolve 的 CAS、重放参数冲突、旧数据加载、任务表写失败不派发默认模型、恢复不重复创建/唤醒。

**Done when** intent 与实际执行可对账；任何半写状态都不会创建第二任务或偷偷执行。

### Task 4: spawn/send 集成与任务运行时

**Objective** 将模型参数绑定到真正开始执行的目标任务。

**Relevant files**

- [src/tools.ts](src/tools.ts)、[src/link.ts](src/link.ts)、[src/scope.ts](src/scope.ts)
- Task 3 的 task 服务；新增 `src/task-runtime.ts`。
- [tests/tool-session-link.spec.ts](tests/tool-session-link.spec.ts)、[tests/link.spec.ts](tests/link.spec.ts)、Task 1 的运行时测试。

**Implementation**

先查询重放，再进行预检，禁止重放因当前 catalog 改变而产生不同任务。旧无模型调用走旧路径；tracked 调用先 durable intent/预检，再 create/link/rename（spawn）和 mailbox admission。

预检主模型失败时沿用户授权策略检查后续候选；全部不可用返回 needs_decision。execution activation 再校验；路由选择、重组 prompt、fallback/暂停由宿主能力执行，插件只做策略决策及事件投影。

activation 时检查 task-owner、attempt、未取消/撤销等；未启动的 tracked task 在 unlink 后不获得新的执行许可。已运行任务不强行打断，已提交的长期设置不因 unlink 撤销。该规则仅针对新 tracked task，不回写旧消息的 delivered 状态。

取消/错误不能用 whenIdle 作为某任务完成证据。应用 session-scope 基线变更与成功响应事实一起对账，复原后不能漏提交或重复覆盖用户选择。

**Depends on** Tasks 1–3。

**Verification** busy target 不被中途换模；多条指定不同模型任务按顺序执行；spawn 首次请求即指定模型；多 step/工具回合模型一致；fallback first-request/partial 两条分支；长期 CAS；用户消息不受影响。

**Done when** 真实 AgentLoop 请求记录证明端到端路由正确，旧四工具行为测试仍通过。

### Task 5: 任务回报 outbox 与发起者决策

**Objective** 发起者可靠收到需要决策的事实，并能安全采取一次动作。

**Relevant files**

- [src/link.ts](src/link.ts)、[src/tools.ts](src/tools.ts)、[src/types.ts](src/types.ts)
- task 服务/runtime；新增 `src/task-notifications.ts`、`tests/task-notifications.spec.ts`。

**Implementation**

增加受信任的内部 task-status 发送入口，复用 mailbox 预算/顺序/flush 逻辑；不得伪造一个 live Agent 绕过 send 的 caller 校验。source 明确声明 host-generated 状态以及原 task。

实现 outbox 恢复、deterministic eventId 去重、通知根链预算、不会产生回报循环；get_task 中显示事件持久化、queued/accepted/blocked，而不是把“已入 outbox”说成“发起者已收到”。

实现 get_task/resolve_task。retry 使用新 attempt 但保留 taskId；continue 使用 checkpoint，若能力不支持返回 `TASK_NOT_RESUMABLE`；不自动转换成从头 retry。同步 needs_decision 不重复通知，异步 fallback 成功也记录并告知 actual route。

**Depends on** Tasks 3–4。

**Verification** 发起者 running/idle/cold/archived/unlinked、无反向 wake 授权、日预算/链预算耗尽；outbox 写/投递/flush 失败后重启；重复事件和重复决策只生效一次；第三方无法查看/控制任务。

**Done when** 不可用事件可经真实投递路径被发起者读取并触发一次安全 retry/continue/cancel，且从不绕过预算。

### Task 6: 输出、UI 与用户说明

**Objective** 用户和模型可看清 requested/actual/baseline、等待决策和投递区别。

**Relevant files**

- [src/client/turn.ts](src/client/turn.ts)、[src/client/TurnCard.tsx](src/client/TurnCard.tsx)
- [src/client/rpc.ts](src/client/rpc.ts)、[src/client/locales.ts](src/client/locales.ts)、[src/client/components.tsx](src/client/components.tsx)
- [tests/client-turn.spec.tsx](tests/client-turn.spec.tsx)、[tests/built-contract.test.mjs](tests/built-contract.test.mjs)
- [README.md](README.md)、[IMPLEMENTATION.md](IMPLEMENTATION.md)、[VERIFICATION.md](VERIFICATION.md)。

**Implementation**

旧 spawn 成功的第一段文本保持完全相同；新信息放后续结构化/文本块。扩展卡片时兼容旧日志。needs_decision 且未创建 Session 时不能渲染虚假会话跳转。卡片增加 task 状态与 actual route/临时或持续标签；只读状态优先，不新增复杂可视化流程编辑器。

使用已有 RPC/polling 模式查询 task 状态，关联当前有权查看的 Session；不引入生成 Remote 元数据依赖。RPC 参数保持 `request` 命名与 signal 位置，更新 built-contract 预期。

文档说明：fallback 顺序、默认通知但不保证唤醒、完整 turn 的任务边界、session 模式实际 fallback route 的持久化、partial 不从头重跑、最低宿主能力和旧宿主拒绝行为。

**Depends on** Tasks 4–5 的输出协议。

**Verification** 旧卡片回放、新成功/待决策/partial 卡片、深浅主题、轮询失败不抹掉已有数据、浏览器 React-only import contract、通知文本不冒充人类。

**Done when** 界面不会将 accepted 误报完成、将 requested 误报 actual，且没有 Session 的失败不显示虚假卡片。

### Task 7: 集成验证、故障矩阵与发布边界

**Objective** 在隔离环境证明功能，不切换用户 live profile。

**Relevant files**

- [scripts/test-host.mjs](scripts/test-host.mjs)、[vitest.config.ts](vitest.config.ts)、[package.json](package.json)
- [tests/integration/installed-smoke.mjs](tests/integration/installed-smoke.mjs)、[tests/integration/RESULTS.md](tests/integration/RESULTS.md)
- 所有新增 suites、[VERIFICATION.md](VERIFICATION.md)。

**Implementation**

将新 host suites 显式加入 test:host（当前脚本固定列四个测试文件）；纯策略 suite 加入明确的独立 script，不能依赖 test:client 偶然匹配。修正/确认当前 test:client 的路径匹配能覆盖客户端 suites。

发布记录包含宿主版本/能力版本、插件版本、schema 兼容策略和卸载行为。旧宿主拒绝 model 参数但原路径可用；旧插件降级不允许消费已写入的 model-bound 任务。宿主必须识别这些 pending 输入为受管理任务，缺失处理能力时停住并报告，而不是当普通消息执行。

**Depends on** Tasks 1–6。

**Verification / Done when** 满足下方全矩阵，记录 PASS/FAIL/NOT_RUN 和复现指令，不用旧版本测试结果替代本次证据。

## Integration / Final Verification

### 自动化矩阵

| 场景 | 必须证明 |
| --- | --- |
| 无模型参数旧调用 | 四工具、非人类归因、顺序、幂等、预算不变 |
| 指定模型 spawn | 首次及后续 step 使用指定 route；任务后普通 turn 回到基线 |
| 已有会话 busy + A/B 两任务 | 当前请求不变，A/B 各自独立，任务不会合并或串模 |
| session scope + fallback | 仅最终成功 route 持久生效，应用默认完全不变 |
| 手动改模竞争 | 任务临时覆盖不篡改基线，持久提交不覆盖较新用户选择 |
| admission 不可用 | needs_decision；无新 Session/模型调用，重放返回同一 task |
| 排队后失效 | 真实 activation 重新验证；候选耗尽后异步回报 |
| first request 不可用 | 安全错误分类下有限 fallback、重新组装 prompt |
| 部分输出/工具后失败 | 不自动 fallback 或重发正文；partial/unknown + checkpoint 明确 |
| retry/continue/cancel 竞争 | revision 和 callId 幂等；不执行旧决策 |
| 重启/崩溃 | intent、route、checkpoint、基线提交、outbox 全部可对账 |
| unlink/归档/未授权 caller | 不偷偷恢复 link、唤醒目标或修改模型 |
| 通知无唤醒权限/超预算 | 持久化 queued/blocked，不谎报已处理；链计数不重置 |
| 存储/flush 故障 | 不产生第二任务/通知，不将目标已持有的消息错误终结 |
| 旧宿主/插件移除/降级 | model-bound 未完成任务 fail closed，普通会话仍可使用 |
| fork/compact/resume | fork 不获得旧任务执行权；compact 保留必要 checkpoint/route 事实 |
| UI/构建合约 | 旧日志可回放，输出/声明/依赖/RPC 参数兼容 |

### 命令与环境

先使用环境已有的 Node/pnpm 或加载工作区依赖工具提供的路径，不安装替代运行时。以下是实施后的验证指令，不代表本轮已执行：

```bash
pnpm run typecheck
pnpm run build
pnpm run test:contracts
pnpm exec vitest run tests/client-turn.spec.tsx tests/client-panel.spec.tsx tests/client-state.spec.ts
# 添加 Task 2/3/5 的新 suites 后：
pnpm exec vitest run tests/model-policy.spec.ts tests/tasks.spec.ts tests/task-notifications.spec.ts
# 必须先确认这里是可用、版本匹配且已构建声明的源码 checkout：
DSH_SOURCE_ROOT=/absolute/path/to/verified-dsh-checkout pnpm run test:host
pnpm run test:integration
```

- 若某新 suite 引入宿主源码专用 testkit，则也必须在 DSH_SOURCE_ROOT 下运行并加入 test:host；纯策略 suite 应尽量不依赖此 testkit。
- 集成环境用隔离 profile + mock adapters 覆盖实际 request config/响应事件/通知链。真实付费模型测试仅在明确授权后进行，否则标 NOT_RUN。
- 本轮访问提示中的 macOS app.asar/dsh 路径得到 `Not a directory`；不要假定它是可直接用作 DSH_SOURCE_ROOT 的源码 checkout。历史 VERIFICATION 中的目录也须重新确认后使用。
- 验证现有 GUI 需要构建对应 artifacts 并刷新现有 URL；不启动替代服务器来冒充部署成功。

## Acceptance Criteria

- 发起 Session 可查询部署模型并在 spawn/send 中选模型及 effort；不接受半组 route 或静默纠正参数。
- task scope 默认仅影响完整目标 turn；session scope 显式生效且不会修改应用默认/覆盖更新的人类选择。
- 用户有 fallback 才自动按列表换模型；候选耗尽或没有策略时，发起者获得同步结构结果或持久化异步回报。
- 回报清晰包含 taskId/revision/实际 route/未开始或部分执行状态；发起者可显式作幂等决策。
- 不保证通知自动唤醒；没有授权/预算时仍可查询并稍后处理，不丢失决策依据。
- 已执行/未知副作用不自动重放；没有安全 checkpoint 明确拒绝 continue。
- 排队并发、重启、取消、撤销、归档和存储故障的测试通过；不存在模型覆盖泄漏和二次 spawn。
- 旧无模型调用和旧日志继续可用；新功能的最低宿主要求及降级限制明确。

## Handoff Notes

- 建议执行顺序：Task 1 宿主能力验证 → Tasks 2–3 协议与持久化 → Task 4 路由集成 → Task 5 决策闭环 → Tasks 6–7 展示与验证。
- 不要先给 spawn 加三个参数就宣称功能完成；关键是队列边界、基线分离和失败后的决策闭环。
- 若当前范围必须严格零宿主改动且 Task 1 无法通过，停止完整功能实施，向用户报告具体缺失能力。可交付目录/协议，但不能用不安全插件 hack 代替已约定语义。
- 不做通用多 Agent 调度平台、跨任务依赖图、自动价格优化、任意代码 workflow 或无限自动重试。
- 本期 partial 自动换模不开放；安全 checkpoint continuation 由发起者显式选择，宿主不支持时诚实拒绝。
- 执行过程中发现公共 SDK 行为不同，应先补契约证据并更新此计划，再调整实现；不要依赖本次聊天作为唯一记录。
