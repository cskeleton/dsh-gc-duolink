# 可配置唤醒默认值与回复链追加额度执行计划

日期：2026-10-14。状态：已实施并通过主代理独立集成验收（400 项测试、官方 native/packed、隔离 Brave smoke）；未提交、未发布。基于当前 0.5.1 未提交工作区；不得覆盖已完成 M1/M2 改动或无关 doraemon-bicycle.html。

## Goal

默认链额度从 4 调至 8、每会话 UTC 日额度从 6 调至 12，沿用已有配置字段。用户从消息旁主动打开交互窗口，选择追加 4/8 次或自定义，确认后持久追加当前回复链额度并尝试继续投递选中消息。

## Context

- 当前 Config/DEFAULTS/types/README 已有 maxAutoWakesPerChain、maxAutoWakesPerSessionPerDay、maxAutoWakesPerMessage；不要另建默认值参数。
- 唤醒计数由 wakeBudgetExhausted/claimWake 管理，根消息由 inReplyTo 确定，链额度跨组、双向共享，首任务也计入；本轮不改计数口径。
- 人类 RPC、共享写入门控、activityView、原串行 chain、deliverTarget 已存在。模型五工具保持不变。
- 本次为用户明确新增的有界控制需求，不启动 M3 消息链浏览器或 M4 治理。

## Constraints

- 当前分支开发；不 commit/push/rebase/reset/worktree，不修改现用 profile，不向 DSH session 派发工作。
- 子代理统一 gpt-6.1-sol/high。本计划由主代理整合验证，不例行停下来请求批准。
- 首任务仍计入链与每日预算；单消息默认 1 不变。显式旧配置值优先，新默认不覆写用户配置。
- 追加不是清零；不重写历史 wakesUsed。每日与单消息额度、双向授权、归档、wake:false、legacy 隔离、取消/解绑不复活、native initial-model owner 保持。
- 仅人类 UI 可追加，不新增模型工具。读取预算绝不唤醒、flush、冷激活或写账本。
- 不自动弹窗；不自动补额度；不扩展所有会话额度；不按模型声明的“进展”判断追加。
- 保持 0.5.1（尚未发布），交付时刷新该版本包并说明内容，不再沿用 0.5.0 临时包。

## Shared contracts

在 src/types.ts 定义并通过 index.ts 导出：

```ts
interface SessionLinkWakeBudget {
  rootId: SessionLinkMessageId
  chain: { used: number; baseLimit: number; extra: number; limit: number; remaining: number }
  targetDay: { used: number; limit: number; day: string; resetsAt: string }
  message: { used: number; limit: number }
  canExtend: boolean
}
// SessionLinkActivityEntry 新增可选 wakeBudget?: SessionLinkWakeBudget。
// 无法可靠确定链（缺父、环、超深、跨参与者、legacy）时不返回预算，不提供追加入口。
interface SessionLinkExtendWakeRequest {
  sessionId: SessionId
  messageId: SessionLinkMessageId
  additional: number       // 正整数 1..100
  expectedExtra: number    // 打开/确认时所见已追加总额，非负安全整数
  requestId: string        // 单次确认的唯一 ID，重试原样使用，长度 1..128
}
interface SessionLinkExtendWakeResult {
  messageId: SessionLinkMessageId
  requestId: string
  outcome: 'applied' | 'replayed' | 'conflict'
  budget: SessionLinkWakeBudget
  continuation: 'accepted' | 'queued' | 'not_pending' | 'not_attempted'
  status: SessionLinkMessageStatus
  blockingReasons: readonly SessionLinkBlockingReason[]
}
```

人类 Remote：`extendChainWakeFrom(request)`。缺失/非原始参与者 MESSAGE_NOT_FOUND；legacy 拒绝；参数严格验证。已应用请求异参重用返回明确错误。并发不同 requestId 但 expectedExtra 陈旧，返回 conflict 和当前预算，零修改、零投递；用户查看新总额后再次确认。

## Implementation

### Task 1：服务端默认值、预算事实、持久追加与继续投递

**Relevant files**：src/link.ts、src/spec.ts、src/types.ts、src/index.ts，tests/link.spec.ts、tests/remote.spec.ts 及相关默认值测试。

**Implementation**：

1. 默认值改为链 8 / 每日 12 / 单消息 1；配置文档和类型注释同步，明确配置在插件加载时解析，修改后需重新加载插件。
2. 现有 ledgers singleton 增加 `chainWakeExtensions` 可选兼容字段（schema default {}）：requestId → {rootId, sessionId, messageId, additional, expectedExtra, createdAt}。一条持久记录既是追加事实又是重试凭据；每根 extra 由追加事实相加，不引入第二套可漂移总计、不删除收据。
3. 链的有效额度为当前配置 baseLimit + 持久 extra；实际投递和 UI 共用此计算。used 延续当前根聚合 wakesUsed，remaining=max(0,limit-used)。targetDay 必须指向该消息接收方，不能错用面板 owner 的日额度。
4. 对追加入口采用有界、无副作用的严格链解析：所有祖先存在、无环、最多 256 条、相同两端（允许反向、跨组），不能含 legacy 标记。异常旧链仍沿用原投递行为，但不可追加；不借机修改历史 FIFO 或修复记录。
5. 所有授权/最新记录/请求去重/expectedExtra 比较/追加写入位于同一原 chain 临界区。仅原始收发双方；首次追加要求选中记录所属组仍授权双方、双方非已知归档/非普通身份。selected 已终态可保留额度供后续消息，但不重发。不得恢复断链或扩大 autoWake。
6. 先持久保存追加，再针对选中且 pending 的普通消息尝试一次既有 deliverTarget；仍用原消息作为 wakeFor，不扫描后自动多方向唤醒。wake:false 不主动唤醒，既有投递规则不变；合法唤醒可能 FIFO 顺带交付其他邮件，文案应说明。
7. 相同 requestId 同参重试不再加额；可重试该选中消息的安全投递（持有/终态/单消息计数继续去重），覆盖写入成功但响应丢失或继续投递前重启。异参重用必须拒绝。新请求若 expectedExtra 不符仅返回 conflict。
8. 返回真实追加结果与当前投递事实；追加成功但投递失败/其他限制仍返回 applied + queued 和固定安全条件摘要，不假称业务完成，不回显原始内部异常。追加写失败必须失败，不能投递；单条追加 1..100，总额及 limit 保证安全整数。

**Verification**：默认/显式配置；双方/第三方；跨组同根共享、其他根不变；重复并发/陈旧比较/异参；write失败、追加后投递失败与重启重试；每日/单消息/wake:false/权限/归档/解绑/legacy/缺父/环/超深；读取无副作用；首任务与 initial-model 不变。调整旧默认限额用例时显式固定其测试边界，不删除既有回归。

**Done when**：额度可持久追加且不会重复授予或扩权，实际 delivery 与投影一致。

### Task 2：消息旁入口、追加弹窗与结果反馈

**Relevant files**：src/client/{components,index,rpc,locales,styles,state}，tests/client-*。

**Depends on**：Task 1 的上述固定合同；可并行编写，不修改后端所有文件。

**Implementation**：

1. 对含 wakeBudget 的普通 pending 消息显示当前链 used/limit 与“双方合计”；链额度耗尽且 canExtend 时显示“增加唤醒额度”按钮。没有可扩额信息不猜测。不得主动弹出或新增全局链浏览器。
2. 点击才打开模态窗口：标题“增加本条回复链的唤醒额度”；当前计数；4/8/自定义（1..100 整数）；追加后上限；目标日额度与其他当前阻塞条件；取消/“追加并继续”。默认 4。
3. 同时展示每日/单消息额度耗尽、未授权、归档等事实，不能说一定继续成功。追加只改变链额度，不变每日额度。提示可能唤醒对端、按现有 FIFO 处理目标队列。
4. 使用现有共享 gate + owner 绑定；确认时生成 requestId，网络异常重试保留完全相同 payload/ID；修改选择须开启新意图。成功或 conflict 后刷新全部已订阅邮箱。响应丢失不能悄悄换 ID 再加额。
5. conflict 保留窗口，展示新预算并要求再次点击确认（新 requestId/expectedExtra）；不自动累加。操作成功与刷新失败分开提示。返回 status/continuation 仅表示持久接收/排队，非任务完成。
6. owner切换/隐藏/卸载清理弹窗与本地反馈，迟到回复不污染其他 owner；请求已发出不意味着关闭窗口可撤销服务端动作。提交中禁用重复提交与取消关闭，owner卸载仍允许生命周期清理。
7. 沿用 React/ReactDOM 与本地样式，优先原生 dialog showModal/close + 语义 label、输入验证、焦点管理/Escape/回焦。无新依赖，明暗主题和窄栏可用。对 jsdom 缺失原生 dialog 的测试仅补模拟，真实行为通过浏览器验证。

**Verification**：显示/不显示入口、4/8/自定义/无效输入、取消无RPC、确认payload/owner、重复点击、网络重试ID、conflict二次确认、刷新失败、owner切换/卸载与焦点、阻塞事实显示、严格响应解析。不能禁用旧 cancel/wake 操作。

**Done when**：用户明确确认后才追加，并能分辨额度已增加与消息是否仍排队。

### Task 3：集成、文档与交付（主代理）

**Relevant files**：tests/integration/installed-smoke.mjs、initial-model-fixture.mjs、tests/built-contract.test.mjs、README 双语、VERIFICATION.md、有效 roadmap、package.json files（本计划供交付引用）。

**Implementation**：真实 packed RPC 验证新方法，隔离浏览器实际打开/取消/确认弹窗、读取新限额、重试/其他限制；packed mock proof 验证额度不足→追加→原消息持久接收且实际请求次数受控。无付费请求、无现用 profile 更改。生成当前 0.5.1 tarball 与校验和/manifest，保留旧历史包。

## Integration / Final Verification

```sh
env -u DSH_SOURCE_ROOT pnpm typecheck
env -u DSH_SOURCE_ROOT pnpm build
env -u DSH_SOURCE_ROOT npm_config_cache=/tmp/dsh-npm-cache pnpm test
DSH_SOURCE_ROOT=/Users/gc/Dev/Opensource/deepseek-harness pnpm test:host
BROWSER_EXECUTABLE_PATH='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' SMOKE_ARTIFACT_DIR=output/playwright-wake-extension pnpm test:integration
git diff --check
```

主代理独立检查 diff/产物与上述门禁输出，实际查看弹窗和窄栏截图；不把仅单测的状态称作真实界面验收。失败先定位根因再修复，避免机械重跑；所有功能修改完成后跑最终门禁。

## Acceptance Criteria

- 默认 8/12/1，文件配置可覆盖，旧显式设置保持。
- 入口→用户主动弹窗→确认追加→立即尝试投递形成完整闭环。
- 同根双方共享新增额度，历史已用不清零，重启和请求重试不重复授予。
- 所有原有权限、每日/单消息限制、wake:false、legacy、初始模型所有权不回归。
- 所有新增测试被现有入口发现，官方 native/packed 与隔离浏览器验证通过。
- 文档与 0.5.1 包包含当前实现，未提交、未发布、未安装现用 profile；Electron/付费模型不声称验证。

## Handoff Notes

后端与前端按上述文件边界并行，主代理负责集成/文档/最终构建，避免同时重建 lib。如果接口需要变动，先通知主代理与另一子代理，不自行双写类型。现有 M1/M2 改动和 tests/client-cancel.spec.tsx 都是当前正确基线，不得清理。

## 完成记录

GPT-6.1-Sol / high 子代理分别实施服务端与客户端，主代理核对 diff 并完成官方 SDK typecheck/build、client 105、initial-model 55、contracts 3、host 237，以及 native 19 / packed 39 次 mock 请求和真实浏览器验证，付费请求为 0。

集成复核修正：冷恢复耗尽次数后返回 not_pending/failed，避免将终态报成 queued；追加成功且刷新失败时使用原行引用更新预算，避免旧 8/8 按钮继续误导；弹窗显示实际失败原因并保留同请求重试；投递回执明确标注检查时状态；客户端拒绝 accepted/pending 等矛盾协议结果。所有相关回归纳入默认测试入口。

最终证据与范围见 ../../VERIFICATION.md 的「唤醒额度追加验收」。
