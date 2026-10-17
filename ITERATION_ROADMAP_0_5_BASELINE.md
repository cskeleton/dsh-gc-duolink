# Session Link 迭代规划修订：以 0.5.0 纯插件版本为基线

日期：2026-10-13，进度更新至 2026-10-14。基线提交：`dd67a2c`。状态：M1（Task 1、Task 2）已最终审查通过并提交于 `9b56e40`；M2（Task 3、Task 4）已在当前工作区实现并分别验证通过，交付版本更新为 0.5.2（避免覆盖同路径本地安装包），已本地打包，未提交、未发布。随后按用户确认完成默认额度调宽及当前回复链追加弹窗（见下方追加需求）；M3/M4 仍需实际反馈或性能证据。

本文取代[旧迭代规划](<ITERATION_ROADMAP.md>)作为后续开发依据；旧文档及其退役标记继续保留，不恢复实验性任务路由。产品边界遵循 [ADR-001](<docs/decisions/001-plugin-only-initial-model.md>)。

## Goal

保持“后台克制减熵、前端透明可控”的方向，但将近期目标限定为：**看清互联关系、消息投递与唤醒条件，提供与事实匹配的人工操作。**

不是建设任务执行监控平台。用户应该能够判断“消息在哪、对端是否在运行、为什么当前不能自动唤醒、是否还能撤回”，而不是依靠插件推断“任务完成了没有、实际用了哪个模型”。

## Context

### 0.5.0 已确认的产品变化

依据：[当前说明](<README.md#L22-L56>)、[初始选模实现](<src/model-spawn.ts>)、[模型目录与参数校验](<src/initial-model.ts>)、[轨迹卡](<src/client/TurnCard.tsx>)。

| 上一版规划假设 | 0.5.0 实际交付 | 本轮处理 |
|---|---|---|
| spawn/send 都能指定模型 | 仅 spawn 的严格 `initial_model` 对象；send 不选模 | 删除 send 选模与任务路由规划 |
| task/session scope、fallback、waiting_decision | 均已退出当前版本 | 不展示、不恢复、不新增替代协议 |
| taskView、任务状态机、宿主状态 outbox、决策工具 | 已移除 | 不再依赖任务域或任务 RPC |
| 展示请求/实际/持久化路由 | 轨迹卡只展示“初始会话模型” | 保持历史事实标签，不推断当前或实际模型 |
| 完整路由需要扩展宿主 | 官方 0.2.0-rc.2 公开接口即可运行 | 官方 SDK 与 packed 验证为主门禁 |
| 仅需考虑普通旧邮箱 | 另有已标记的遗留实验报告被阻止投递 | 观察与控制均须继承隔离边界 |

初始模型跨 turn 保留，之后由原生 Session Controller 管理，用户的后续选模优先。插件不持有运行时选模权，不覆盖原生选择，不修改应用默认。

0.5.0 基线时，`view()` 仅提供关系与会话目录，尚无邮件详情视图；轨迹卡已展示初始模型，但缺少新会话打开入口和首任务投递状态。上述增量已由 M1 完成，未重做选模或卡片。

[验证记录](VERIFICATION.md)分别记录 0.5.0、M1 与 M2 的官方 SDK/native/packed/Web smoke 证据；Electron、付费模型、旧实验 profile 迁移仍有明确未验证边界。

## Constraints

1. 保持纯插件和官方公开 API，不引入 task-host、第二模型 owner、任务域、fallback 或模型失败自动重跑。
2. 保留五工具；不新增任务管理工具。拟议的邮件视图/取消 RPC 仅供受信任人类 UI，不自动成为模型工具。
3. 显式互联、双向唤醒授权、next-turn、FIFO、幂等、预算、取消临界点和 unlink/replay 不扩权保持不变。
4. `accepted/delivered` 仅代表目标持久接收；目标 running 不是“正在处理这条消息”；收到回复也不是插件认证的业务完成。
5. “初始会话模型”既不是当前选择也不是实际请求证据。不要通过扫描模型请求日志或冷激活会话补出这些字段；需要确认时打开宿主原生会话。
6. 只读页面不唤醒、不 flush、不修复、不消费预算，不把查询变成调度入口。
7. 新增邮箱视图、取消入口不能使被标记的实验报告重新投递。未标记旧任务邮件无法可靠识别；面板不能承诺识别全部实验残留或提供原地迁移。
8. 延续 React/ReactDOM、既有插槽、Remote、轮询、共享写入闸门。暂不引入图形库、外部服务、实时事件总线或全局图画布。
9. 近期只做兼容性增量，不删除存储、不自动清理旧 profile、不修复初始选模的孤儿会话或 ownership 冲突。

## Implementation

顺序：**M1 最小只读面板 → M2 有界控制与发送意图 → M3 按反馈追溯 → M4 按证据治理**。每阶段可独立验收；达到目标后可以停止扩展。

### Task 1 / M1-A：按管理会话查询邮箱与唤醒摘要

**Status**：已实现，最终独立复审通过（2026-10-14），随后提交于 `9b56e40`；未发布。验收结论见 [M1 审查记录](<M1_REVIEW.md>) 文末，实施方验证记录见 [VERIFICATION.md](<VERIFICATION.md>)。

**Objective**：提供一个只读、分页、无副作用的观察接口，不恢复 taskView。

**Relevant files**：[服务](<src/link.ts>)、[类型](<src/types.ts>)、[客户端 RPC 校验](<src/client/rpc.ts>)、[查询状态](<src/client/state.ts>)、[客户端装配](<src/client/index.tsx>)、[服务测试](<tests/remote.spec.ts>)。

**Implementation**：

- 保留全局 `view()` 的轻量关系/候选目录。新增 `activityView({ sessionId, section, peerId?, cursor?, limit? })`，section 为 pending/recent，默认 20 条、最大 50，返回总数、nextCursor、sampledAt。
- 仅返回管理会话作为发送方或接收方的记录；当前 UI 已具备打开任意普通会话的宿主权限，不把客户端传来的 sessionId 当作模型身份凭证。断链后原始双方可查看历史，但不恢复发送权限。
- 条目包含 messageId、linkId、方向、sender/target、status、createdAt、seq、inReplyTo、受控短预览、固定安全错误摘要 lastError（不回显原始错误），以及派生 canCancel/禁用理由。正文最多 160 字符，纯文本转义；不简单删固定三行框架，不返回完整正文、请求 digest、敏感错误或任意历史任务载荷。
- 摘要包含每日唤醒已用/上限、UTC 日期及下一重置时间、入站/出站待投递数量、首任务唤醒例外提示、目标运行状态。每目标容量只对应入站待投递，不把所有收发总和除以 16。
- `blockingReasons` 表示当前已知条件，可同时存在：自动唤醒未授权、日/单消息/回复链额度不足、归档、冷目标未就绪、投递确认待核实；缺证据用 unknown。running 不构成邮箱 pending 的通用原因，历史 lastError 也不一定仍是当前阻塞原因。
- 从现有投递逻辑提取必要的无副作用判断，读写共用规则，不重复实现一套许可引擎。`inserted` 是投递前意图标记，不能单独证明已在目标内存或只差 flush；canCancel 是快照提示，不是最终授权。
- 对 `statusKind`/`taskStatus` 标记记录显示独立的“遗留实验报告：本版不投递”数量/诊断项，保留原记录；不把它们放入可操作普通邮件队列、不计入正常待投递容量、不展示恢复/重试/删除按钮。诊断不加载旧任务域，不承诺迁移安全。
- pending 显示顺序复用现有投递顺序；recent 按稳定的入队排序键倒序，明示是入队时间而非送达时间。纯旧/纯新/混合记录均需测试。若旧混合排序无法支持稳定游标，使用有界页快照/刷新失效游标方案，不借 UI 需求修改历史 FIFO。
- 原有 `error/attempts/createdAt` 不是模型失败、fallback 次数或完整事件历史。缺少准确证据的字段不新增。
- 本期不扩展全局目录模型字段；初始模型继续使用现有 spawn 卡，不为完整美观重建运行时模型跟踪。

**Depends on**：0.5.0 基线，无宿主扩展。

**Verification**：双方过滤、断链历史、分页/混合旧记录、UTC 跨日、跨组链预算、首任务例外、legacy 标记（含非字符串值）、空视图、脱敏。查询前后存储、预算、模型请求数和冷会话激活数不变。

**Done when**：接口能够诚实解释投递事实及当前条件，无任务域依赖，无执行副作用。

### Task 2 / M1-B：最小邮件面板与入口完善

**Status**：已实现，最终独立复审通过（2026-10-14），随后提交于 `9b56e40`；未发布。packed 浏览器场景已由实施方和审查者分别复跑 PASS（隔离 profile + packed tarball + Brave，0 次模型调用）。见 [M1 审查记录](<M1_REVIEW.md>) 与[最终独立 smoke 结果](<output/playwright-review-final/installed-smoke-result.json>)。

**Objective**：先解决“看不到消息/找不到对端/分不清状态”，不增加控制台复杂度。

**Relevant files**：[面板](<src/client/components.tsx>)、[装配](<src/client/index.tsx>)、[状态](<src/client/state.ts>)、[卡片](<src/client/TurnCard.tsx>)、[解析](<src/client/turn.ts>)、[样式](<src/client/styles.tsx>)、[文案](<src/client/locales.ts>)。

**Implementation**：

1. 顶部固定管理对象与打开入口，沿用互联对象及去程/回程开关。
2. 默认展示待投递消息和已知条件；最近通信折叠。正常排队不全标红，遗留实验报告用独立诊断提示。
3. 预算在摘要/折叠区展示：实际配置值、已用量与重置时间；不是 token/费用仪表盘。不要求用户常看内部 ID 或首任务台账字段。
4. 头栏弹窗先显示已互联对象快览，再提供搜索添加。
5. spawn 卡增加“打开会话”；在不改变第一段工具文本与 version 1 模型 sidecar 的前提下，解析 messageId 和 queued/accepted。历史状态标为“创建时投递状态”，不能在后续已送达时仍冒充实时状态；需要最新详情时打开面板。
6. 原有初始模型标签保留，不重复建设模型 UI。effort 省略时表示所选模型自身默认，不显示发起者 effort，不伪造具体运行值。
7. 详情源按实际 panel owner 而非可见主聊天绑定，只在订阅期间查询；快速切换、隐藏、断连、卸载时清理。全局列表与每张历史 TurnCard 不各自轮询邮箱；有陈旧数据时明确标记更新时间。
8. 遵循现有写入闸门、写后刷新；操作成功而刷新失败分开提示。支持键盘、长标题、窄栏和明暗主题，颜色不独占状态编码。

**Depends on**：Task 1。

**Verification**：[面板测试](<tests/client-panel.spec.tsx>)、[状态测试](<tests/client-state.spec.ts>)、[卡片测试](<tests/client-turn.spec.tsx>)、[注册测试](<tests/client-registration.spec.ts>)；覆盖管理非当前会话、晚到响应、旧日志/缺失或无效 sidecar、原生改模型后卡片仍仅标初始值。补 packed 浏览器场景。

**Done when**：用户不读日志即可区分排队/持久接收/投递异常，快速打开正确对端，且看不到虚构的任务执行或实际模型状态。

### Task 3 / M2-A：UI 取消普通待投递消息

**Status**：已实现并通过独立的取消阶段验收（2026-10-14），宿主 178 项、官方 native/packed 和 packed Web smoke 通过；最终与 M2-B 合并验证见 [M2 验证记录](VERIFICATION.md#m2-里程碑验证2026-10-14未发布工作区)。未提交、未发布。

**Objective**：先开放已存在的取消能力，再增加发送语义；尽量不改变调度规则。

**Relevant files**：[服务](<src/link.ts>)、[类型](<src/types.ts>)、[RPC](<src/client/rpc.ts>)、[面板](<src/client/components.tsx>)、[装配](<src/client/index.tsx>)、[服务测试](<tests/remote.spec.ts>)。

**Implementation**：

- 新增人类 RPC `cancelMessageFrom({ sessionId, messageId })`，限定原始发送方或接收方的普通邮件；legacy 标记记录保持诊断只读。可信边界沿用宿主人类 RPC，不把无身份 `cancel(undefined, id)` 直接暴露。
- 在现有串行临界区内重读归属、记录和可能已持有状态，复用取消逻辑；校验与写入不分成竞态的两个阶段，UI 不能只看 `!inserted` 就认定可取消。
- 返回明确 outcome：cancelled / already_terminal / too_late 及最新状态；不把当前内部 void/no-op 当作成功撤回。
- 断链后双方仍可取消可取消的普通 pending；已插入目标、可能已被持有或已送达则不撤回。对端正在执行时应打开原生会话使用宿主停止入口。
- 解绑确认说明它不停止已运行会话，也不撤回已交付内容；继续保留双向独立唤醒设置，不做全局急停或新执行取消协议。

**Depends on**：M1。

**Verification**：双方/第三方、取消与插入/flush/解绑竞争、重复点击/刷新失败、取消后重启/重放、legacy 标记不可操作；不能把取消界面用作实验 profile 迁移。

**Done when**：按钮承诺与实际取消边界一致，原有 mailbox/预算/幂等行为不变。

### Task 4 / M2-B：仅发送消息可选择不申请唤醒

**Status**：已实现并通过最终验收（2026-10-14）：客户端 91 项、初始模型单测 55 项、契约 3 项、宿主 209 项、官方 native/packed 与 Web smoke 全部通过，0 次付费调用。记录同上。未提交、未发布。

**Objective**：减少纯信息同步引起的多余自动唤醒，不恢复 QueueOnly/TriggerTurn 任务引擎。

**Relevant files**：[工具](<src/tools.ts>)、[服务](<src/link.ts>)、[类型](<src/types.ts>)、[schema](<src/spec.ts>)、[中英文说明](<README.md>) / [English](<README.en.md>)、[工具测试](<tests/tool-session-link.spec.ts>)、[邮箱测试](<tests/link.spec.ts>)。

**Implementation**：

- `session_send_session_message` 增加可选 `wake?: boolean`。省略/true 保持原行为；false 不申请唤醒空闲目标、不冷恢复、不扣唤醒额度，仍不能扩展授权。
- running 对端继续按既有 next-turn 交付，可能形成后续 turn；不宣传“零计算”或“永不触发回合”。其他合法唤醒或人类活动可以按 FIFO 顺带交付该消息。
- 将意图随消息持久化，旧缺字段按 true。同 key 重放用已记录值，不允许 false→true 提升；恢复读取同一字段。若明确拒绝异参重放，应统一说明，但不得靠新重试参数改写既有意图。
- spawn 不新增 wake 参数，首任务预算内启动及后续 auto_awake/wake_caller 保持。initial_model 引导顺序、摘要、single-flight、seedConfirmed 与原生 ownership 不改。
- 消息框架补一句“无需纯礼貌确认，有实质结果/问题/阻塞再回复；纯信息同步可选择不申请唤醒”。这是提示，不代替预算；新提示计入消息字节上限。旧已持久化正文不重写。
- 暂不做预算自动重置、放宽默认额度、通知分诊或拆工具。文档说明回退到不识别 wake 字段的旧插件可能丢失新语义；不要承诺跨降级仍保持发送端不唤醒保证。

**Depends on**：M1；建议在 Task 3 后独立交付和回归，不与 UI 初版同时改语义。

**Verification**：冷/热空闲/running × 省略/true/false × 新发/重放/重启/取消；FIFO 顺带投递、同 key 不提升、字节限额及原生初始模型 proof 不回归。旧顶层路由参数与 send.initial_model 继续严格拒绝。

**Done when**：纯信息同步可不主动唤醒空闲对端，且没有增添任务状态机或改变初始选模。

### 已确认追加需求：可配置唤醒默认值与当前回复链加额

**Status**：已实现并验证（2026-10-14），包含在当前未发布 0.5.1 工作区。用户确认后由 GPT-6.1-Sol / high 子代理按[专项计划](docs/plans/chain-wake-budget.md)执行，主代理完成集成验收。

已有配置的默认值改为链 8 / 会话每日 12 / 单消息 1，显式配置保留，首任务计数不变。用户从耗尽链的待投递消息主动打开弹窗，选择追加 4/8 或自定义 1–100 次，确认后持久追加并尝试继续原消息。追加收据幂等、并发陈旧确认需重新确认；每日/单消息预算、授权、wake:false、取消、归档、legacy 隔离及原生选模不扩权。默认测试与 host 合计 400 项、native/packed 和 Web smoke 全通过，0 次付费调用。

此项是用户明确追加的有界控制需求，不启动 M3 追溯浏览器或 M4 治理。

### Task 5 / M3：按实际使用反馈增加通信追溯

**Status**：本轮门禁结论为暂缓（2026-10-14）。用户明确反馈“暂时没有明显追溯痛点”，保留现有最近记录。指定历史 session 的四类协作案例仅证明通信发生，不能代替 M1/M2 实际使用后的痛点反馈；未来出现明确问题再启动此任务。

**Objective**：复盘一次交接，而非展示并不存在的业务任务全生命周期。

**Relevant files**：[服务](<src/link.ts>)、[面板](<src/client/components.tsx>)、[类型](<src/types.ts>)。

**Implementation**：按 messageId/inReplyTo 折叠消息链，跨页/缺失父记录显示引用，不按 taskId 聚合、不读旧任务域、不恢复宿主状态 outbox。只展示有证据的时间；createdAt 不冒充送达/完成时间。静态双向关系示意仅在列表难以解释方向时加入，不建全局画布。

先复盘 3–5 个真实场景：已有会话交接、跨目录协作、指定初始模型的独立调研、预算排队、取消错误消息。成功指标为减少查日志/人工搬运和状态误解，而非更多消息/唤醒。只做本地必要记录，不上传聊天遥测。

**Depends on**：M1/M2 已使用并有反馈。

**Verification**：断链历史、跨组回复链、旧记录/缺失父节点、分页和时间文案；不将对端回复认证为任务成功。

**Done when**：有明确追溯需求且轻量展示足以解决；否则保留 M1 最近记录即可。

### Task 6 / M4（条件性）：存储保留与性能治理

**Status**：本轮不启动（2026-10-14）。本地只读快照为 9 个互联组、38 条消息、120,786 字节，未收到或复现延迟/空间问题；这些计数不是性能测试，不据此宣称大规模性能合格。不开展合成规模基准、索引重构或 GC。

**Objective**：对真实规模问题做安全治理，不预排大重构。

**Relevant files**：[schema](<src/spec.ts>)、[服务](<src/link.ts>)、[初始选模](<src/model-spawn.ts>)。

**Implementation**：有界响应不等于扫描有界；实际出现延迟再测 100/1,000/10,000 条样本，按证据考虑只读索引或按目标隔离投递。GC 必须另写专项方案，保留幂等 key、链根/预算事实、首任务已兑现事实、spawn removed、initialModelSpawns 的 digest/ownership/seed 确认等恢复依据。旧实验残留不在自动清理范围，不绕过官方禁止原地迁移的边界。

**Depends on**：可复现的延迟/空间问题与安全审查。

**Verification**：归档前后重放/重启等价，旧调用不重新派发，原生人类选模不被覆盖，首任务和链预算不复活，取消/解绑不恢复。没有安全证明不发布 GC。

**Done when**：实际问题得到测量与解决；没有证据时不启动该阶段。

## Integration / Final Verification

以官方 0.5.0 的入口为准，不恢复实验版测试与扩展依赖：

```sh
env -u DSH_SOURCE_ROOT pnpm typecheck
env -u DSH_SOURCE_ROOT pnpm build
env -u DSH_SOURCE_ROOT pnpm test
BROWSER_EXECUTABLE_PATH=<browser> pnpm test:integration
DSH_SOURCE_ROOT=<checkout> pnpm test:host
git diff --check
```

- `pnpm test` 已含 client、initial-model 单测、native proof、packed 工具与构建契约；不以旧任务引擎测试数作为目标。
- source checkout 的 host suites 仅辅助原邮箱/Remote/工具/命令回归，不作为发行依赖或选模依据。新 RPC 的主要验收还需 packed 官方实例。
- 测试入口必须实际发现新增测试：当前客户端文件位于 tests 根目录，`tests/client` 是 Vitest 过滤条件而非必须存在的目录。
- M1/M2 的每轮修改都复跑 initial-model native/packed，确认初始模型、后续原生选模、卸载/恢复、default 不污染、重放摘要与严格 schema 保持。
- 补面板 visible/hidden、管理非当前会话、分页/陈旧响应、错误/遗留隔离、普通和选模 spawn、预算上限与取消竞态等 Web smoke；使用 mock adapter，不增加付费调用。
- Desktop Electron、真实收费模型与实验 profile 迁移仍需分别声明范围。若后续宣称 Desktop 已验证，必须补隔离的真实 Electron smoke；不能拿 Web 截图替代，也不擅自更新用户现用 profile。

## Acceptance Criteria

- M1 已完成；本轮在其基线上继续 M2 两项，取消与发送意图分别验收。M3/M4 不自动展开，不新增模型能力。
- 清晰区分关系授权、目标运行状态、消息投递状态和初始模型事实；未知不猜测。
- 消息视图有界、按 owner 过滤、无唤醒副作用，legacy 标记报告仍不投递且无恢复操作。
- M2 的普通取消与 wake:false 分开验收，均不改变原生模型 owner 与初始选模流程。
- 官方 SDK/native/packed 为发布门禁，运行环境与验证缺口如实记录。
- 首版无需微拓扑、业务执行状态、fallback、任务 outbox、GC 或并发重构。

## Handoff Notes

1. 这次是**重设技术基线并缩小范围**，不是重启旧任务路由。只有产品方向和邮箱相关建议延续。
2. 0.5.0 已有的初始模型卡片不重做；只补跳转和投递事实。必要时去宿主会话查看当前模型，不为前端透明度重新引入运行时模型追踪。
3. M1 API 已随 `9b56e40` 提交；M2 API/参数在当前未发布工作区实现。构建和隔离验证不等于已安装到用户 GUI。
4. 旧规划保留为历史；本文件为后续有效规划，不授权迁移、删除历史数据、自动修复会话或修改宿主。
5. 本次接续指定 session 的已提交 M1 状态，在当前分支直接实现 M2，不向其他 DSH session 派发任务；本轮验证证据见 VERIFICATION.md。M3/M4 的启动条件不变。
