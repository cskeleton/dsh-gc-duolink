# 任务级模型路由独立代码审查 — 2026-10-12

> **历史文档，已由 0.5.0 纯插件版本取代。** 下文保留原实验阶段的计划、结论和源码引用；被删除的任务模块、宿主扩展要求及任务面板不再属于当前产品。不要按本文启动开发或推断当前能力。当前依据：[README](README.md)、[IMPLEMENTATION](IMPLEMENTATION.md)、[历史处理决定](docs/decisions/001-plugin-only-initial-model.md)。

## 结论

**暂不建议发布完整新功能。** 本次发现涉及生产装配、真实选模控制器共存、取消、长期模型保护、重试和恢复的功能性缺陷，不是单纯文档或测试计数问题。

审查基线为插件 `fde0942`，变化范围 `329f4f3^..fde0942`，以及宿主 checkout 中未提交的 task-host 扩展。没有修改生产实现、宿主代码、依赖、应用 profile，也没有提交/切换分支。新增本报告和独立复现材料。

## 验证事实与边界

- **原有根套件独立复跑：317/317，15 文件，exit 0。** 反例归档后再次复跑仍为 317/317；见[最终默认套件输出](<artifacts/review/baseline-output.txt#L20-L23>)。使用现有 Homebrew Node v26.8.2、bundled pnpm 和 DSH_SOURCE_ROOT 指向交接所述源码 checkout。
- bundled 签名 Node 首次启动 Vitest 失败，原因是 macOS 拒绝加载不同 Team ID 的 rolldown native module；这是运行时环境问题，不是功能断言失败。没有重装/重签依赖或关闭安全保护。
- **新增 8 个行为反例：8/8 未满足预期。** 包含生产装配的两个场景、真实选模控制器、排队取消、预检 fallback、默认 fallback、部分流式输出、失败的 session-scope 持久化。
- 复现材料：[model-routing-probes.spec.ts](<artifacts/review/model-routing-probes.spec.ts>)、[独立配置](<artifacts/review/vitest.config.ts>)、[完整输出](<artifacts/review/probe-output.txt>)。这些期望是正确行为，因此当前失败是缺陷证据；它们位于默认 suite 之外。
- 另有独立审查的源方法/内存状态机复现：真实 Cordis waterfall、真实宿主选模/投影代码、或 Vite 加载真实插件代码及 memory/mock fixture。下文标 B，**不把这些说成完整安装/browser 验证**。
- A = 本报告保留的 AgentLoop/mock adapter 反例；B = 独立审查已实跑的定向源方法/内存 fixture 反例，并经主审查核对对应代码。
- 不调用付费模型，不复跑 installed-smoke，不验证真实 compaction。本次不是全代码形式证明，也不保证列表穷尽所有缺陷。

### 重跑保留的反例

```bash
DSH_SOURCE_ROOT=/Users/gc/Dev/Opensource/deepseek-harness \
  /opt/homebrew/bin/node \
  /Users/gc/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs \
  exec vitest run --config artifacts/review/vitest.config.ts
```

反例使用当前机器的宿主源码绝对路径导入真实 ApiSessionAgentController；换机器先调整该 import 和 DSH_SOURCE_ROOT。typert 仅替换无关注册依赖，模型选择逻辑为真实 controller；Session Controller 的 create/catalog 等仍为 mock，不声称实际安装验证。

## P1 — 发布前应修复

### R01. 实际插件装配未挂载任务服务，tools 也未声明服务注入

**位置：** [cordis.patch.yml:1–7](<cordis.patch.yml#L1-L7>)、[index.ts:184](<src/index.ts#L184>)、[tools.ts:158–165](<src/tools.ts#L158-L165>)、[测试专用挂载/escape:79–86](<tests/helpers/domains.ts#L79-L86>)。

patch 只挂载 link service/tools/command，默认导出仍是 SessionLinkService；生产代码没有挂载 SessionLinkTaskService。tools 的 inject 也没有 sessionLinkTasks。测试手工挂载服务，并设置 `__sessionLinkTasks`，绕过了 Cordis 注入约束。

**复现 A：** 在具备宿主 factory 的 fixture 下，按实际装配不挂 task service，tracked spawn 返回 `HOST_CAPABILITY_UNAVAILABLE: the task service is not mounted`。即使手工挂载 task service，只去掉 test escape，结果仍相同。

**影响：** 支持 task-host 的宿主也不能通过当前插件装配使用新功能；“缺失能力”的错误掩盖了插件自身的服务装配缺陷。

**修复方向：** 通过正常 loader/service lifecycle 挂载任务服务、建立 probe 依赖，并声明真实注入/可选依赖。不能把测试 escape 作为发布接口。

### R02. 真实 API Session 模型选择 owner 覆盖任务模型

**位置：** [宿主原选模 waterfall:82–110](</Users/gc/Dev/Opensource/deepseek-harness/packages/core/agent/src/model-selection.ts#L82-L110>)、[controller 安装:283–324](</Users/gc/Dev/Opensource/deepseek-harness/packages/api/session-controller/src/agent.ts#L283-L324>)、[插件 freeze:285–354](<src/task-runtime.ts#L285-L354>)。

controller 先安装的 listener 是 Cordis waterfall 的外层。其 `await next()` 返回后，会再次写入自己的 provider/model；后安装的 task-host/runtime 覆盖被外层覆盖。

**复现 A + B：** 在真实 `ApiSessionAgentController.selectionFor` 已安装的 Agent 上派发 model-a，实际 adapter request 为 `base-model`。无此 controller 的旧测试通过。

**影响：** 核心选模功能在真实 API Session 中不成立，任务账本还可能报告请求模型而非实际执行模型。

**修复方向：** 单一权威选模 owner 接入任务覆盖，统一 prompt/请求/图像能力检查的选择优先级；不要再堆叠相互竞争的 waterfall。

### R03. 取消排队任务只改任务状态，后来仍执行

**位置：** [resolve_task:1868–1884](<src/tools.ts#L1868-L1884>)、[activation terminal 检查:677–679](<src/task-runtime.ts#L677-L679>)、[pre-step 继续进入:527–529](<src/task-runtime.ts#L527-L529>)。

cancel 没撤销 mailbox/host intent；activation 遇到 cancelled 返回，但 pre-step 仍进入后续执行。已预 claim 的宿主 intent 也仍能冻结 route。

**复现 A + B：** 无 auto-wake 的 tracked model-a 任务排队；resolve cancel 返回 cancelled；目标后来被人类消息唤醒。实际请求为 `[base-model, model-a]`，取消任务正文被执行，task 行仍是 cancelled。

**影响：** 用户取消后的任务仍可能调用工具、修改文件或消耗模型费用。

**修复方向：** cancelled 是执行 admission 的硬门禁；原子/可恢复撤销未消费 intent 与 delivery，领取时必须 fail closed，而不是只阻止任务状态转换。

### R04. orphan 检测不是执行门禁，移除插件后可默认模型执行受管理任务

**位置：** [host orphan 查询与 claim listener](</Users/gc/Dev/Opensource/deepseek-harness/packages/api/session-controller/src/task-host/index.ts#L308-L313>)、[host freeze/lifecycle:452–582](</Users/gc/Dev/Opensource/deepseek-harness/packages/api/session-controller/src/task-host/index.ts#L452-L582>)、[插件 lazy 安装:30–64](<src/task-host-lazy.ts#L30-L64>)。

宿主扩展只由插件 lazy 安装；真实 controller 的 compose/resume 未安装它。即使 factory 已安装，孤儿记录也只被列出：没有宿主 pre-step 拒绝门禁，无 live claim 就走普通请求。

**复现 B：** 从持久化 claimed intent 重建 host，`isManaged=true` 且 orphan count=1；领取后 pre-step 仍 enter，请求 baseline。

**影响：** 当前 `NOT_RUN` 的物理降级并非仅缺证据；源码已存在插件缺失时静默执行的路径。

**修复方向：** 宿主在所有 create/resume 下拥有不可依赖插件的 durable managed-input guard，并覆盖缺能力/旧插件/卸载路径。

### R05. session-scope 失败任务会把失败模型持久化

**位置：** [turn/end 路径:544–583](<src/task-runtime.ts#L544-L583>)、[closeHost:1019–1040](<src/task-runtime.ts#L1019-L1040>)、[host commit/finish:220–245](</Users/gc/Dev/Opensource/deepseek-harness/packages/api/session-controller/src/task-host/index.ts#L220-L245>)。

所有 turn/end 都调用 commitTurn，包含无成功响应的错误/取消；宿主 persistOnSuccess 只检查标志和 route，没有成功响应事实。

**复现 A + B：** model-a 首请求报 PROVIDER_UNAVAILABLE，零成功响应，task waiting_decision；却出现 model/selection(model-a)，长期 baseline 变成 model-a。

**影响：** 无效模型污染后续会话；“只持久化成功模型”的承诺不成立。当前提交时机也是 turn/end，而非首次成功响应。

**修复方向：** durable response-committed 事实是必要提交条件；失败/取消只 finish，不 commit successful selection；成功提交与实际 route 事实可恢复对账。

### R06. CAS token 使用 pending route/null，已消费的人类选择会被覆盖

**位置：** [host baseline:128–138](</Users/gc/Dev/Opensource/deepseek-harness/packages/api/session-controller/src/task-host/index.ts#L128-L138>)、[persist CAS:410–419](</Users/gc/Dev/Opensource/deepseek-harness/packages/api/session-controller/src/task-host/index.ts#L410-L419>)、[真实 pending consumption:39–55](</Users/gc/Dev/Opensource/deepseek-harness/packages/api/session-controller/src/model-selection-projection.ts#L39-L55>)。

revision 不是单调版本，而是 pending 选择值/null。人类修改后被 request/header 消费，又回到 null；ABA 同样无法检测。

**复现 B：** 任务记录时 revision=null；人类选 HUMAN_NEW 并产生对应 request，pending 再成 null；随后任务持久提交 CAS 通过，覆盖 HUMAN_NEW。

**修复方向：** 长期基线有独立、持久、单调 revision；只由明确长期选择事件推进，request consumption 不能重置 revision。

### R07. 临时基线恢复只保存在 RAM，重启后临时模型成为普通默认

**位置：** [host RAM 字段:101–115](</Users/gc/Dev/Opensource/deepseek-harness/packages/api/session-controller/src/task-host/index.ts#L101-L115>)、[turn/end 恢复:482–491](</Users/gc/Dev/Opensource/deepseek-harness/packages/api/session-controller/src/task-host/index.ts#L482-L491>)、[真实 controller header fallback:295–308](</Users/gc/Dev/Opensource/deepseek-harness/packages/api/session-controller/src/agent.ts#L295-L308>)。

request/header 会把临时 TASK 写为 lastUsed，原基线恢复只在 displacedBaseline/pinnedHumanBaseline 中。重启后的 controller/host 仍从临时 header 推导默认。

**复现 B：** BASE header → 临时 TASK header → turn/end → 按相同 events 重建 controller/host，下一普通请求为 TASK。

**影响：** task scope 的长期隔离在重启后失效。R02 修复后，本缺陷仍独立存在。

**修复方向：** 持久长期 baseline 与 last-used request 分离，不依赖结束时 RAM 补偿。

### R08. retry 没有真正重新执行已领取失败任务，也不能创建预检失败的 spawn

**位置：** [reAdmitRetriedTask:1994–2118](<src/tools.ts#L1994-L2118>)、[hostForTarget:1672–1675](<src/tools.ts#L1672-L1675>)、[mailbox 幂等:910–912](<src/link.ts#L910-L912>)。

两种可修复的 not_started 情形都断链：

1. 原模型首请求失败、原 mail 已 delivered：retry 新模型重用原 callId/messageId，mailbox 返回已有 delivered 收据，不产生新 turn。工具返回 applied，任务 queued，但新模型从未请求。
2. spawn 同步预检失败：尚无 target Session。retry 注释说重建，但没有 create/claimSpawnLink，只从 live registry 查询 derived ID，再拒绝 capability；永远不创建会话。

**复现 B：** 两种情形均实跑；第一种 B 请求数为零，第二种 creates.length=0、target 不存在。

**修复方向：** 原 tool-call replay 与用户新 decision attempt 必须区分。taskId 稳定；已消费 delivery 的新 attempt 使用新 delivery 身份，并保留原授权/根链预算。未创建 spawn 重走可幂等 create/link admission。

### R09. retry 使用 160 字符摘要作为任务正文

**位置：** [保存摘要:607](<src/tasks.ts#L607>)、[重派正文:2103–2105](<src/tools.ts#L2103-L2105>)。

完整任务意图没有保存；预检失败后 retry 将 textExcerpt 当正文，丢弃后续约束和要求。摘要不应成为执行 payload。

**复现 B：** 203 字符任务（160 个 X + 关键后缀）预检失败后选择可用模型重试，实际 mailbox 只有 160 个 X，关键后缀丢失，返回 applied。

**修复方向：** durable immutable payload 或可靠完整正文引用；保留必要 in_reply_to 等语义，不用展示摘要恢复执行。

### R10. 预检选中 B，activation 却重新使用已被拒绝的 A

**位置：** [预检选择:1299–1319](<src/tools.ts#L1299-L1319>)、[host intent 使用 selected:1439–1444](<src/tools.ts#L1439-L1444>)、[activation 候选选择:700–755](<src/task-runtime.ts#L700-L755>)。

admission 报告 selected B 并记录 host route B，但 activation 从 candidates[0] 重建 active route，忽略预检选择与拒绝历史。

**复现 A：** catalog 只有 base/B，没有 A；授权 A→B。工具 selectedModel=B，实际 adapter 请求仅 A。

**影响：** 报告与执行不一致，可能调用用户未预期的路由；实际 adapter 不支持 A 时又增加无意义失败。

**修复方向：** 将选择候选索引和预检结果固化到 attempt；activation 在该事实基础上重新校验，不无条件回到原候选。

### R11. 缺失 mailbox 写入未被恢复，重放返回虚假 admitted/queued

**位置：** [绑定先于 send:1460–1479](<src/tools.ts#L1460-L1479>)、[replay:1382–1387](<src/tools.ts#L1382-L1387>)、[reconcile:1345–1351](<src/tasks.ts#L1345-L1351>)。

mailbox 首次 put 失败后，task 已 queued/bound；reconcile 只检查存在但不匹配的 message，缺失 message 被忽略；相同 call replay 直接返回 admitted/queued，不重派。

**复现 B：** 注入 messages.put 首写失败，initial call error；message 不存在，reconcile repairCount=0；replay 仍 admitted/queued，message 仍不存在。

**修复方向：** write-ahead 对账必须把缺失 message 纳入 repair/re-admission；无实际 mailbox intent 不能返回已 admission。

## P2 — 功能与可靠性缺陷

### R12. 部分流式输出后仍自动 fallback

**位置：** [assistant-stream 仅看 end:532–542](<src/task-runtime.ts#L532-L542>)、[fallback 条件:606–633](<src/task-runtime.ts#L606-L633>)。

responseCommitted 只在完整 assistant/message commit 后设置，忽略已经展示的 chunks。

**复现 A：** A 发 text-delta 后报 PROVIDER_UNAVAILABLE，实际 requests `[A,B]`。按计划应停住并回报 partial/unknown，不自动换模型。

**修复方向：** 分别跟踪 outputObserved、responseCommitted、toolDispatched/unknownEffect；任一不满足无输出/无副作用保证，就禁止自动 fallback 和 from-scratch retry。

### R13. 仅配置 session_default 的 fallback 在预检被忽略

**位置：** [候选检查跳过 default:461–463](<src/model-policy.ts#L461-L463>)、[runPrecheck:1310–1319](<src/tools.ts#L1310-L1319>)。

sentinel 被留到 activation，但主模型不在 catalog 且没有后续具体 route 时，预检直接 exhausted，根本不进入 activation。

**复现 A：** A 不存在，base 可用，fallback=[session_default]；结果 needs_decision，无自动默认降级。

**修复方向：** 为仍可按授权解析的 default 保留 admission/activation 路径，按计划快照目标长期基线后校验；不能把“未解析”当“已不可用”。

### R14. outbox 因容量失败后，接收者活动没有再次触发 pump

**位置：** [异常后不重排:229–235](<src/task-notifications.ts#L229-L235>)、[pump wiring:517–559](<src/tools.ts#L517-L559>)、[mailbox 恢复监听:286–301](<src/link.ts#L286-L301>)。

注释承诺 sender later activity/human wake 会投递，但实际 pump 没订阅相关容量/活动变化。接收者排空 mailbox 后，没有新的 task mutation 就不重试 outbox。

**复现 B：** maxPendingPerTarget=2，发起者 mailbox 已满，回报 pending；人类唤醒并消费两个 mail 后，outbox 仍 pending，回报未入 mailbox。

**修复方向：** 订阅真实可重试条件变化，含 mailbox 容量/接收者活动/授权变化，明确 budget 次日恢复机制；维持单飞，不做无限自触发或忙轮询。

### R15. 首次 task intent 创建没有原子幂等，竞争请求可覆盖策略

**位置：** [saveTaskIntent:542–635](<src/tasks.ts#L542-L635>)。

get(existing) 与 await put 之间没有 per-task lock/insert-if-absent。两次并发首次写都通过 absent 检查，后写覆盖前写，digest replay 检查被绕过。

**复现 B：** 相同 caller/callId、不同 FIRST/SECOND 正文的 Promise.all，两次都 fulfill，最终 durable excerpt=SECOND。

**修复方向：** 按稳定 taskId 串行化首次 admission 或使用存储原子插入，竞争者只能 adopt/报参数冲突。

### R16. 参数摘要只 hash 前 2048 字符，尾部改动不触发 replay 冲突

**位置：** [requestDigest:302–314](<src/tasks.ts#L302-L314>)。

`input.text.slice(0,TASK_DIGEST_MAX_TEXT)` 使其后的关键修改必然碰撞，和哈希算法碰撞概率无关。

**复现 B：** 前 2048 字符相同但不同后缀，被当作完全相同请求接受。

**修复方向：** 对完整已限制大小的执行 payload 做 digest。限制展示摘要不等于限制执行身份摘要。

### R17. 通知 messageId 的字符替换导致确定性碰撞与覆盖

**位置：** [task-status messageId 与 put:1244–1275](<src/link.ts#L1244-L1275>)。

eventId 的非标识符字符全部替换为 `_`，不是无碰撞编码。`review/a` 与 `review_a` 会生成同一个 messageId；后者覆盖前者的 mailbox row。

**复现 B：** 两次不同 eventId 的 admitTaskStatus 返回同一 task-report-review_a，第二次覆写第一条。callId 是任意字符串，相同碰撞可进入真实 task eventId。

**影响：** 事件丢失/错误去重/marker 指向其他事件，不具备通知 exactly-once 的持久化身份条件。

**修复方向：** 以完整 eventId 的可靠哈希或无碰撞编码派生 messageId，并保留完整 key 作冲突验证。

### R18. 未绑定任务的多次通知没有共享根链，绕过 per-chain wake 上限

**位置：** [初始空 root:628](<src/tasks.ts#L628>)、[只有 binding 设置 root:758–760](<src/tasks.ts#L758-L760>)、[pump 传 root:215](<src/task-notifications.ts#L215>)、[通知新链规则:1225–1235](<src/link.ts#L1225-L1235>)。

同步模型预检失败的任务从未 attachBinding，root 一直为空。后续不可用模型 retry 的每个状态 event 被视为独立 message root，不共享同一 task 的链预算。

**复现 B：** maxAutoWakesPerChain=1、daily=6、反向 auto-wake 已授权；初次缺失模型加显式 retry 产生 3 个状态 message，root={}，wakesUsed=[1,1,0]。同一 task 总唤醒 2 次，超过 per-chain=1；daily/per-message 限制仍有效。

**修复方向：** 在首次 intent admission 建立稳定通知/预算根，而不是等原任务 mailbox binding；所有 decision/retry 的通知必须保留同一预算链。

## 为什么 317 个旧测试通过仍不够

1. [task-routing fixture](<tests/task-routing.spec.ts#L89-L170>) 绕过真实 ApiSessionAgentController，并手工挂载任务服务/escape。
2. [model-runtime fixture](<tests/model-runtime.spec.ts#L67-L89>) 直接创建 AgentLoop + task-host factory，不覆盖真实 owner 的监听器优先级。
3. [所谓 prompt/header 一致测试](<tests/model-runtime.spec.ts#L176-L194>) 比较的是 adapter/request header/assistant attribution，没有观察真正 prompt 的模型变量或渲染内容。
4. restart fixture 主要检查 orphan 元数据，未证明 recovered managed inbox 在卸载/降级/真实 controller 下被禁止执行。
5. 已有 fallback partial 测试是完整首响应后的第二请求失败；未覆盖首响应在流式输出途中失败。
6. 已有 cancel 测试是用户取消正在运行的 target turn；未覆盖发起者取消 queued tracked task 后的后续唤醒。
7. actual installed-smoke 使用无 task-host 的官方宿主，验证了旧路径和缺能力拒绝，而非新功能的实际安装成功链。

## 建议修复顺序

1. 正常生产 service assembly 与注入，去掉测试专用路径依赖。
2. 宿主单一 durable baseline/route owner，以及 create/resume 的 managed-input 硬门禁；一起解决控制器覆盖、取消、orphan、CAS、重启污染。
3. response/effect 的真实成功边界，修正失败持久化与部分输出 fallback。
4. attempt-scoped retry 状态机、完整 payload 与 write-ahead 对账；区分 tool replay 和新决策。
5. 候选选择与 default 解析一致性、首次写入幂等、完整 digest。
6. outbox 的可重试条件触发及无碰撞身份。
7. 在真正装配的宿主中执行零付费 mock 集成测试，再更新验证矩阵和发布门槛。

## 尚未计为已确认缺陷的风险

- terminal projection 与 outbox marker 共用 task revision。终态更新抓取 revision 后吞掉 CAS 异常，可能把纯 marker 竞争误当作另一个终态投影已完成；需要确定性调度测试，不在上面的已确认列表中。
- mailbox admission 成功但持久 outbox marker 一直写失败时，pump cascade 可能反复重入；需要受控故障测试，避免无退避的重复存储写。
- 原 policy.scope=session，retry 更换 provider/model 后 scope 实测变为 task。是否是 bug 取决于“替换路由”是否应保留原持久化授权；当前 resolve schema 无 scope 参数，需要明确语义，而非直接当作已确认需求违例。
- 相同 decisionCallId 的顺序 replay 已实测幂等成功，**没有将其报告为缺陷**；并发 replay 的原子性还需单独验证。

## 审查留下的文件状态

生产 tracked diff 为空，`git diff --check` 无问题。[报告](<CODE_REVIEW_MODEL_ROUTING.md>)为新增未跟踪文件；[复现目录](<artifacts/review/model-routing-probes.spec.ts>)在项目现有 artifacts ignore 下，不会被默认根套件自动执行。[原实施计划](<MODEL_ROUTING_PLAN.md>)保持原样。还观察到未跟踪 pnpm 缓存目录，来源未归因，没有擅自清理；不把工作区宣称为 clean。

这里不是要求用 prepend 或额外 restore listener 局部修补所有问题。现有实现的根问题是多套选模 owner 与投递/执行边界不一致；需要先统一权威状态和 admission gate，再做局部修复。
