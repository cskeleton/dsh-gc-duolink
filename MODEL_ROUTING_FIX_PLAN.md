# Model-Routing 审查缺陷修复 Implementation Plan

> **历史文档，已由 0.5.0 纯插件版本取代。** 下文保留原实验阶段的计划、结论和源码引用；被删除的任务模块、宿主扩展要求及任务面板不再属于当前产品。不要按本文启动开发或推断当前能力。当前依据：[README](README.md)、[IMPLEMENTATION](IMPLEMENTATION.md)、[历史处理决定](docs/decisions/001-plugin-only-initial-model.md)。

> **2026-10-13：历史修复计划，已由新范围取代。** 用户已确认只做新建会话初始选模，且不得修改宿主或 Desktop。后续以[纯插件新计划](<MODEL_ROUTING_PLUGIN_ONLY_PLAN.md>)为准；本文的宿主修改和任务系统实施指引不再适用于下一轮。历史正文保持原样，当前源码尚未回退。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复独立审查（CODE_REVIEW_MODEL_ROUTING.md，R01–R18 + 3 项待确认风险）确认的功能性缺陷，使任务级模型路由在真实装配宿主上可用、可信。

**Architecture:** 三层统一修复：(1) 统一选模 owner——宿主 task-host 扩展成为唯一任务路由权威，消除插件/控制器叠加 waterfall (R02/R07)，真实持久单调基线 revision (R06)，成功事实门控持久化 (R05)，宿主插件无关的 managed-input 执行硬门禁 (R04)，重启不污染 (R07→durable 分离)；(2) 统一任务执行门禁——取消即撤销/领取硬拒 (R03)、payload 本体 durable (R09/R16)、候选选择固化到 attempt (R10/R13)、新决策=新投递身份 (R08)、write-ahead 缺口对账 (R11)、首次写入原子 (R15)、输出实质跟踪 (R12)；(3) 修复通知身份/根链/pump 触发 (R14/R17/R18)；(4) 生产装配 (R01 raw-loader 子插件)；(5) 已确认语义测试门禁化。

**Tech Stack:** TypeScript, cordis, DSH checkout workspace (DSH_SOURCE_ROOT 别名), vitest, zod 4。

**Spec:** CODE_REVIEW_MODEL_ROUTING.md（审查报告，R 编号即需求）与 MODEL_ROUTING_PLAN.md（原产品契约；审查证据优先）。

## Global Constraints

- master 直做，不建分支/worktree（原计划约束 9 继续有效）。
- 插件内禁止叠加第二个 model-selection owner；宿主 `packages/api/session-controller/src/task-host/` 与 `core/agent` 的宿主改动保持**未提交、additive**，绝不修改 node_modules 或发布包。
- 不重写 task 协议存储域；`session_link` v1 / `session_link_tasks` v1 schema 演进必须向后兼容（旧行可读）。
- 每步先写失败测试（握把 = `tests/review-fixes.spec.ts` `R##` 前缀），修复后该用例必须转 PASS，原 317 套件不减不破。
- 复跑命令统一：`DSH_SOURCE_ROOT=/Users/gc/Dev/Opensource/deepseek-harness pnpm exec vitest run tests/review-fixes.spec.ts`（及根套件/各分裂套件）。
- 不隐瞒：修复中暴露的新缺口进报告与记忆，不静默。

### 测试基建事实（实施者必读）

- 审查者探针 harness 已导出可复用绑定（我已改好）：`artifacts/review/model-routing-probes.spec.ts` export `{ BASE, A, B, stack, spawn }`。`stack(adapter, available?, realController?, taskAssembly?)` 返回 `{ ctx, alice, bob, carol, links, tasks(经 escape)… }`；`spawn(s, callId, extraArgs)` 执行 tracked spawn。
- 错误注入：`import { HarnessError } from '@deepseek-ai/dsh-llm'`；`throw new HarnessError('down', 'PROVIDER_UNAVAILABLE')` 可在自定义 `LlmAdapter.stream` 中使用；部分输出后失败 = 先 `for (const c of rawPartial) yield c` 再 throw。
- 非 textResponse 裸片段须含（照抄审查者）：`{type:'block-start',index:0,blockType:'text'}` → `{type:'text-delta',index:0,text:'partial'}` → 然后 throw。MockAdapter 记录 `adapter.requests: GenerateOptions[]`（`.model`）。
- 审查者套件 `artifacts/review/**/*.spec.ts` 不被根 vitest（include=`tests/*.spec.{ts,tsx}`）或 test:host 执行——新握把持件放 `tests/review-fixes.spec.ts` 并注册。
- `tests/helpers/domains.ts` 现有 escape：`Object.defineProperty(ctx, '__sessionLinkTasks', { value: ctx.sessionLinkTasks })`（R01 挂接后删除）；`mountAgentLoopTestDependencies` 不装 ApiSessionAgentController。

---

### Task 1: R01 生产装配——raw-loader 任务服务子插件 + 真实注入

**Files:**
- Create: `src/service-tasks.ts`
- Modify: `cordis.patch.yml`、`src/index.ts`（命名导出 + inject 元数据）、`src/tools.ts:47`（inject 列表）、`src/tools.ts:155-175`（taskServiceOf 去 escape）
- Test: `tests/review-fixes.spec.ts`（首批 R01 用例）

**Interfaces:**
- Consumes: `SessionLinkTaskService`（tasks.ts，`static inject = ['storageDomain']`）、`TaskLinksProbe`（tasks.ts 类型：message/pairLinked 只读探针）。
- Produces: cordis patch 新 id `dsh-session-link/tasks`；`Context['sessionLinkTasks']` 生产可得（cordis 注入，非 defineProperty）。

- [ ] **Step 1: 读 cordis raw-loader 惯例（子插件导出形状）**。读现有被 loader 消费的命名子插件：`src/tools.ts:1-60`（`export const inject = [...]` + `export function apply(...)` 或 default）、`src/command.ts` 同位置。照抄导出协议：本子插件文件必须同样声明 `inject`（含 `sessionLinks`）并在挂载时把 probe 传给 `SessionLinkTaskService`。
- [ ] **Step 2: 写失败测试**（tests/review-fixes.spec.ts）。组装**无 escape**栈（复制 domains.ts 但去掉 defineProperty 与手工任务服务挂载；走 `ctx.plugin` 新子插件）：

```ts
import { stack, spawn, A, BASE } from '../artifacts/review/model-routing-probes.spec.ts'
it('R01: production assembly mounts the task service without test escape', async () => {
  const s = await stack(adapter, [BASE, A], /*real=*/false, /*assembly=*/'mounted')
  // mounted 模式 = 走新子插件，不再 defineProperty；tracked spawn 必须 admitted
  const result = await spawn(s, 'r01', { provider: 'mock', model: A })
  expect(result.outcome).toBe('admitted')
  expect(s.ctx.sessionLinkTasks).toBeDefined()  // cordis 注入可得
})
```

- [ ] **Step 3: 跑测试确认失败**（报 HOST_CAPABILITY_UNAVAILABLE / 服务未注入）。
- [ ] **Step 4: 实现** `src/service-tasks.ts`：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { SessionLinkTaskService } from './tasks.ts'
export const inject = ['storageDomain', 'sessionLinks']
export async function apply(ctx: Context): Promise<void> {
  const links = ctx.sessionLinks
  await ctx.plugin(SessionLinkTaskService, {
    links: {
      message: messageId => links.message(messageId),
      pairLinked: (linkId, first, second) =>
        links.list(first).some(l => l.id === linkId && l.memberIds.includes(second)),
    },
  })
}
```

`cordis.patch.yml` 追加 `{ id: tasks-session-link, name: dsh-session-link/tasks }` 并在 `src/index.ts` 命名导出该模块路径（与 tools/command 同款 loader 故事）。
- [ ] **Step 5: 去 escape**。tools.ts `taskServiceOf` 改为直接 cordis 读取（不再读 `__sessionLinkTasks`）；inject 加 `'sessionLinkTasks'`；`tests/helpers/domains.ts` 删 defineProperty 一行，改为 `await ctx.plugin`（或以 `import * as tasksPlugin` 插件形式）挂载新子插件——让所有现有 317 测试改走生产装配形状。
- [ ] **Step 6: 验证**：`tests/review-fixes.spec.ts` R01 PASS；根套件 317 全绿（装配分叉消除，无回归）。
- [ ] **Step 7: Commit** `fix: production task-service assembly via raw-loader sub-plugin (R01)`。

---

### Task 2: 宿主统一选模 owner（R02/R06/R07）+ 成功事实持久化（R05）+ 执行硬门禁（R04）+ 部分输出边界（R12 宿主部分）

**Files:**
- Modify: `<dsh>/packages/api/session-controller/src/task-host/index.ts`（重写 route/freezing/commit/guard 逻辑）、`<dsh>/packages/api/session-controller/src/task-host/types.ts`、`facts.ts`（新事件/projection/stateVersion bump）、`<dsh>/packages/api/session-controller/src/agent.ts`（controller 集成点，narrow + additive）、`<dsh>/packages/core/agent/src/model-selection.ts`（可禁用/让位语义，additive flag）
- Modify（插件去重权）: `src/task-runtime.ts:285-354`（删自有 request/assemble 重写）、`src/task-host-lazy.ts`
- Test: `tests/review-fixes.spec.ts`（R02/R04/R05/R06/R07/R12 用例）、现有 `tests/model-runtime.spec.ts`（宿主契约套件随语义演进更新，关键场景必须继续 PASS）

**Interfaces:**
- Consumes: cordis waterfall 顺序语义（外层=先注册）；session `model/selection` + `request/header` projection（model-selection-projection.ts）；`assistant-stream` 帧；`agent/inbox/claimed`/`pre-step`/`request` 事件（runtime-types.ts）。
- Produces（宿主能力新语义）: `readBaseline()` 返回 `{ effective, revision: number /*单调*/ , lastUsed }`；`commitTurn` 仅当 durable 成功响应事实存在且 CAS(revision) 通过才追加 `model/selection`；`installManagedInputGuard(session)` 使孤儿/撤销 intent 的消息在 pre-step 被拒；task scope 任务结束后 baseline 可从 durable 状态重建（无 RAM 依赖）。

**Step 0（先做，防误改）:** 重读宿主关键源——`core/agent/src/model-selection.ts`（waterfall 外层 overwrite 点 82-110）、`api/session-controller/src/agent.ts:283-324`（selectionFor/installModelSelection 调用处）、`agent.ts:295-308`（无 selection 时 header fallback）、`task-host/index.ts` 全文、`model-selection-projection.ts`。把 R02/R06/R07 三处复现对应的行号写进本任务报告。

- [ ] **Step 1: R02 失败测试**（真实控制器 owner 不得覆盖任务路由）：

```ts
it('R02: real controller installModelSelection never overrides the task route', async () => {
  const s = await stack(adapter, [BASE, A, B], /*realController=*/true) // 装真实 controller 选模 owner
  await spawn(s, 'r02', { provider: 'mock', model: A })
  await s.bob.whenIdle()
  expect(adapter.requests.map(r => r.model)).toEqual([A]) // 现复现为 ['base-model']
})
```

- [ ] **Step 2: 统一 owner 设计与实现（根因修复，非叠加）**。方案（锁定）：controller 创建 agent 时的 `installModelSelection` 增加**宿主级让位**——该 agent 存在 task-host 任务租约的 turn 期间，原选模 owner 的 request/prompt 重写不生效；task-host 的冻结成为唯一权威（宿主 side 单一注册点，插件 runtime 删除自己的 `agent/request`/`assemble` 重写，只保留策略/CAS/事件投影）。判别信号来自 durable task/turn-intent（非 RAM）。写宿主侧单测（checkout 内 `packages/api/session-controller/src/task-host/` 配套宿主测试）+ 插件侧 R02 用例。
- [ ] **Step 3: R06 失败测试**（已消费的人类新选择不得被旧任务 CAS 覆盖）：revision 改单调 version——`model/selection` projection 增加每次显式选择推进的 version（stateVersion bump + loader 迁移兼容旧行）；`commitTurn` CAS 比较 claim 时快照 version，不一致即 `persistent_selection_skipped: human_selection_changed`。复现 R06 ABA 剧本进测试。
- [ ] **Step 4: R07 失败测试**（重启后临时模型不得成为普通默认）：`request/header` 落临时 route 的事实必须与"长期基线选择"分离存放/标记；controller 无 pending selection 时的 header fallback 不得把 task-turn header 当作长期默认（用 durable 标记/独立字段，不 RAM）。重启重建剧本进测试。
- [ ] **Step 5: R05 失败测试**（失败 session-scope 不得持久化失败模型）：`commitTurn` 的 persist 触发条件 = durable 存在该租约的**成功响应提交事实**（assistant/message commit 与 route 一致），否则只 finish 不追加 `model/selection`；提交时机改首次成功响应事实落点时（非 turn/end 兜底）。R05 当前复现（`model/selection(model-a)` 出现）必须消失。
- [ ] **Step 6: R04 失败测试**（managed-input 宿主硬门禁）：宿主在 session create/resume 全域安装 managed-input guard（不依赖插件存在）——`agent/pre-step` 拒绝无 live claim / 已撤销的 task/turn-intent 绑定消息，消息退回 pending 而非普通执行；卸载插件/旧插件/孤儿重启剧本进测试（当前 R04 复现 orphan 仍 enter 必须变为 reject）。
- [ ] **Step 7: R12 失败测试**（部分流式输出后禁止自动 fallback）：宿主/regulator 跟踪 `outputObserved`（任何 chunk）/`responseCommitted`（commit）/`toolDispatched`：任一为真即禁自动 fallback 与 from-scratch retry，报告 partial/unknown（计划 clause 5 的精确语义）。当前 `[A,B]` 复现必须变为 `[A]`。
- [ ] **Step 8: 跑全部新用例至 PASS + 宿主 task-host 自测 + model-runtime 契约套件 + 根套件全绿。**
- [ ] **Step 9: Commit** 宿主 side 不提交（保持工作区 additive）；插件提交 `fix: unified host model owner, monotonic baseline revision, success-gated persist, managed-input guard (R02/R04/R05/R06/R07/R12)`。

---

### Task 3: 统一任务执行门禁（R03 取消 + R08 retry + R09/R16 payload + R10/R13 选择一致性 + R11 对账 + R15 原子）

**Files:**
- Modify: `src/task-runtime.ts`（activation claim 硬门禁、候选选择固化消费、output 协作）、`src/tools.ts`（reAdmitRetriedTask 重写、spawn-not-created retry 路径、消息本体）、`src/tasks.ts`（payload 域、digest 全体、saveTaskIntent 原子 insert-if-absent、reconcile 缺口纳入）、`src/link.ts`（取消撤销投递/新投递身份）、`src/task-spec.ts`（payload/digest/候选索引 schema 演进，向后兼容）、`src/model-policy.ts`（default sentinel 预检语义）
- Test: `tests/review-fixes.spec.ts` R03/R08×2/R09/R10/R11/R13/R15/R16 用例

**Interfaces:**
- Consumes: Task 2 宿主 guard/commit 语义；`mintTaskMessageId`、`reAdmitRetriedTask`（tools.ts）、`saveTaskIntent/attachBinding/reconcile`（tasks.ts）、mailbox `send` 幂等（link.ts:910-912 附近）。
- Produces: `task.payloadText`（durable 完整正文）；`requestDigest` 覆盖完整正文；新 attempt 的新 `messageId`（在保留任务/taskId/通知根预算的前提下）；取消立即撤销未消费投递与宿主 intent；reconcile 把"绑定无 message"纳入 repair/admitted 重放校验。

- [ ] **Step 1: R03 失败 -> 修复**：cancel 决策必须同时 (a) 撤销目标 mailbox 中该任务投递（未消费）与 (b) 取消宿主 turn-intent；activation/pre-step 遇 cancelled 硬拒（不只状态早退）。当前复现 `[base, model-a]` → 必须 `[base-model]`（无 model-a）。测试沿用审查者取消-唤醒剧本。
- [ ] **Step 2: R09+R16 失败 -> 修复**：spawn/send tracked intent 保存**完整正文**（durable，非 160 摘要）；`requestDigest` 对完整正文哈希；retry 重派用本体。R09 203-字符剧本后缀必须到达 mailbox；R16 尾部变更必须触发参数冲突。
- [ ] **Step 3: R08 两种情形失败 -> 修复**：(1) 已领取失败任务的 retry = **新投递身份**（新 messageId；taskId 与通知根预算不变）+ 新 precheck + 新 host intent，执行真实新模型请求；不得复用已 consumed 的 mailbox 身份装作重派。(2) 预检失败未创建 Session 的 spawn retry = 走完整幂等 create/link/rename/admit（原 callKey 派生同一 Session id）。两测试断言真实 adapter 请求数>0、目标 Session 存在、模型为新选择。
- [ ] **Step 4: R10+R13 失败 -> 修复**：precheck 通过的**候选索引/选择结果固化到 attempt 行**；activation 从该事实出发再校验（catalog 复查），不无条件回 candidates[0]；R10 selectedModel=B → 实际请求=[B]。`session_default` sentinel 在预检不被当"不可用"——可按计划快照/激活边界解析的路径进入 activation（R13 default-only 复现 admitted，实际用基线路由）。
- [ ] **Step 5: R11 失败 -> 修复**：reconcile 对"有绑定但 mailbox 无对应 message"判 repair（重 admission 或 needs_decision，诚实）；replay 同 callId 不得对实际缺失的投递返回 admitted/queued（重新走 admission 或报 repair）。
- [ ] **Step 6: R15 失败 -> 修复**：saveTaskIntent 首次创建走存储原子 insert-if-absent（或域表 CAS upsert）；并发首次同 caller/callId 不同正文 → 其一 adopt/参数冲突，不得互相覆盖。
- [ ] **Step 7: 全部新用例 PASS + 根套件全绿 + test:host。**
- [ ] **Step 8: Commit** `fix: task execution gate — cancel revocation, full payload, attempt-fixed selection, new-attempt delivery identity, atomic intent (R03/R08/R09/R10/R11/R13/R15/R16)`。

---

### Task 4: 通知身份、根链与 pump 触发（R17/R18/R14）

**Files:**
- Modify: `src/link.ts:1244-1275`（无碰撞通知 messageId 派生 + 冲突验证）、`src/tasks.ts:628,758-760`（首次 intent 即建通知根）、`src/task-notifications.ts`（可重试条件订阅/触发）
- Test: `tests/review-fixes.spec.ts` R17/R18/R14 用例

**Interfaces:**
- Consumes: mailbox eventId/messageId 存储与不冲突查找；wake 预算 ledger（chain/daily/per-message）；pump 的 schedule/drain。
- Produces: `notificationMessageId(eventId)`（无碰撞编码或哈希 + 完整 key 冲突校验）；任务首个 intent 持有的稳定 `notificationRoot`；对 mailbox 容量/接收者活动/授权变化的事件驱动 pump 触发（无 timer/忙轮询/自触发循环）。

- [ ] **Step 1: R17 失败 -> 修复**：完整 eventId 稳定哈希/无碰撞编码派生 messageId，put 前冲突校验（同 id 异 eventId 判错不覆盖）。审查者 `review/a` vs `review_a` 碰撞复现必须消失。
- [ ] **Step 2: R18 失败 -> 修复**：通知根在**首次 intent admission**建立（不等 binding）；decision/retry 通知沿用同一根链；`maxAutoWakesPerChain=1` 下同任务 3 事件仅消费 1 次 wake（wakesUsed 不得 [1,1,0]）。
- [ ] **Step 3: R14 失败 -> 修复**：订阅/监听真实可重试条件——mailbox 容量释放、接收者活动、授权变化（用现有 link.ts 286-301 恢复监听与事件，不加 timer）；接收者消费腾空后 outbox 自动重投。审查者 `maxPendingPerTarget=2` 剧本必须变为通知最终入 mailbox。
- [ ] **Step 4: 新用例 PASS + 根套件全绿。**
- [ ] **Step 5: Commit** `fix: notification identity, budget root chain, retry-condition pump triggers (R14/R17/R18)`。

---

### Task 5: 已确认语义门禁化（R12 插件侧收尾）、三个已标注问题、审查 A 套件纳入、VERIFICATION 与回归

**Files:**
- Modify: `src/task-runtime.ts`（若 Task 2 后仍有插件侧 output 协作残余）、`tests/review-fixes.spec.ts`（新增终态 revision、marker-cascade 用例）、`package.json`（test:host 注册 review-fixes）、`VERIFICATION.md`（审查缺陷修复记录 + 状态更正）
- Create（搬入确认语义）: 将 `artifacts/review/model-routing-probes.spec.ts` 中 8 项 A 反例改写为持久 fixtures（迁入 `tests/review-fixes.spec.ts` 或独立 `tests/review-acceptance.spec.ts`，每例前缀 R##），使其进 test:host；审查者 raw `artifacts/review/*` 保留为历史材料不动。

**Interfaces:**
- Consumes: Task 2/3/4 全部接口。
- Produces: 更新后的 VERIFICATION.md（317→新计数、原"完成"声明更正为审查后状态、R01–R18 修复映射表、真实装配宿主仍 NOT_RUN 明确标注）。

- [ ] **Step 1: 终态 revision/marker 竞争**：失败测试（确定性调度：终态投影与 outbox marker 共 revision 竞争不得误判/吞错）-> 修复（投影与 marker 写入的确定性序列/错误分类）。
- [ ] **Step 2: marker 写失败 cascade**：失败测试（outbox marker 持久写失败时 pump 不得无退避反复重入）-> 修复（单飞 + 退避/失败计数边界）。
- [ ] **Step 3: retry scope 语义**：resolve schema 增补 `scope` 语义裁决——显式字段或文档化"换路由保留原 scope 授权"；测试锁定选定语义（不得再实测静默变 task）。
- [ ] **Step 4: 并发 decision replay**：同 decisionCallId 并发 replay 的原子性失败测试 -> 修复（若缺防线）。
- [ ] **Step 5: 审查 8 例迁移**为持久 `tests/review-fixes.spec.ts` 用例（全部 PASS）；`package.json` test:host 增加该文件；跑根套件/全分裂。
- [ ] **Step 6: VERIFICATION.md 重写**：矩阵标注 R01–R18 修复证据（测试名）、原"7 任务完成可用"声明更正、真实装配宿主/物理降级/真实 compaction 仍 NOT_RUN 如实列出、计数更新。
- [ ] **Step 7: 最终回归**：typecheck/build/contracts/client/policy/test:host/根套件（期望 317+X）/installed-smoke 全绿；.Commit `test+docs: review-fixes gate, issues 1-3, VERIFICATION 审查后真实状态`。

---

## Self-Review 结果

- **Spec 覆盖**：R01→Task1；R02/R04/R05/R06/R07/R12→Task2；R03/R08/R09/R10/R11/R13/R15/R16→Task3；R14/R17/R18→Task4；待确认 3 项 + 审查 8 例门禁化 + VERIFICATION→Task5。无遗漏。
- **宿主统一 owner（R02）与门禁（R04）是同一次宿主重写的两面**，放同一任务是刻意的——拆掉一半会留下半成品 waterfall。
- **无占位符**：每个测试给了可编译骨架与精确复现断言值（均来自我实跑的反例输出）。
- **类型一致**：`stack/spawn` 签名、`SessionLinkTaskService.links` probe、`inject` 形状、`HarnessError` 用法与现存代码逐项核对过。
- **已知风险**：Task 2 宿主改动最大且未提交；必须保持 additive + 宿主自测，执行时先落宿主测试再改行为。
