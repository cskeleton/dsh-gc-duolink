# 新建会话初始选模（纯插件）Execution Plan

> **已实施：0.5.0，2026-10-13。** 下文是实施前冻结的方案；其中“仅规划／未实施”描述当时状态。本轮开发与验证已经完成，实际行为及限制见 [实施记录](PLUGIN_ONLY_EXECUTION.md)、[VERIFICATION](VERIFICATION.md) 和 [架构决定](docs/decisions/001-plugin-only-initial-model.md)。

日期：2026-10-13。
状态：**新规划，未实施、未回退；纯插件 bootstrap 仍须通过 Task 1 可行性门槛。**

## Goal

在**未修改的官方 DSH** 上，仅通过 `dsh-session-link` 插件，让发起会话创建一个独立顶层会话，并指定它的初始 provider/model/reasoning effort。新会话后续沿用该模型，目标用户仍可通过原生 UI 自行切换。

用户本轮已明确选择：**只做新建会话选模**。不再实现给已有会话的单次消息临时指定模型，也不实现插件代替用户切换已有会话。

本计划取代[原任务路由计划](<MODEL_ROUTING_PLAN.md>)及[宿主扩展修复计划](<MODEL_ROUTING_FIX_PLAN.md>)作为下一轮实现依据。旧审查报告是历史证据，不是本版必须照搬的功能需求。本文只规划；不授权自动提交、回退、删除宿主改动或替换运行中的 profile。

## Context

### 1. 当前代码与回退基线

- 当前插件 HEAD：`549a1d7`，Round 2 修复后的版本。
- **选模开发前正确基线：`42abec427c26ef1448728d49f720bf3139021292`（简称 `42abec4`）。** 它已经包含 UI 改进和双向 auto-wake；不要回到更早的 `fad710b`，那会丢失用户要保留的功能。
- `329f4f3..549a1d7` 共 19 个提交属于本次复杂模型路由开发及修复；对比 `42abec4`，44 个 tracked 文件变化，15,430 行新增、130 行删除。数字来自本轮只读 git 核对，不是缺陷数量。
- 大部分新增代码是 task-host capability、任务/attempt 状态机、CAS、outbox、task/session 双 scope、fallback、运行时 gate 和任务面板。它们不是本版必需组件。
- [后续迭代规划](<ITERATION_ROADMAP.md#L20-L30>)仍假定完整 tracked-task 功能已完成。它与本计划的范围冲突：其任务面板/get_task/resolve_task 相关工作暂停，不可用来重新引入旧系统。该文档本轮保持原样，后续另行对齐。

### 2. 已确认的官方 API 事实

核对的是已安装 npm SDK `0.2.0-rc.2`，不是修改后 checkout 的能力：

- `SessionController.modelCatalog()` 已存在，可用于目录校验，但目录不是实际请求成功的保证。
- `SessionController.create()` 接受 cwd/sessionId/agentPreset 等，不接受 provider/model。
- `selectModel()` 会额外保存应用默认模型；不能作为“不污染应用默认”的捷径。
- 原生控制器在首次安装选模 owner 时，从 `modelSelection.pending` 初始化；后续从原生 request header 恢复所用模型。参见[已发布 controller 实现](<node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/agent.js#L296-L342>)。
- 原生 `create({sessionId,cwd})` 对已经持久化的同 ID 普通会话会走 observe/resume，并安装原生 controller/preset。参见[已发布 adopt 路径](<node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/agent.js#L454-L511>)。
- 原生 `model/selection` 事件会进入 pending 投影。参见[已发布投影](<node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/model-selection-projection.js#L22-L40>)。
- 插件现有[安装测试](<tests/integration/installed-smoke.mjs#L58-L99>)已使用公开 Session persistence API 创建关闭态普通会话。但它并未验证本计划的初始选模路径，**不能拿旧 smoke 代替 Task 1**。
- `agent/created` 在 setup 后执行；不能假定在这个事件里 append 选择就能更新已经缓存选择的 controller。也不依赖 `session/created` 的监听顺序做初始化。

### 3. 回退还是当前版删减：裁决

| 方案 | 优点 | 主要风险 | 裁决 |
|---|---|---|---|
| 在当前版保留 tracked-task 架构，只关掉部分参数 | 看起来复用多 | 宿主依赖、旧状态机和 UI 语义仍在；易形成第三套选模逻辑 | 不采用 |
| 在当前版逐段删除宿主相关代码 | 保留所有新代码修复 | 要在 44 个文件中证明清除了每条 task/outbox/runtime 链，成本大、残留风险高 | 不作为默认路线 |
| **恢复到 `42abec4` 的功能基线，再选择性引入小型纯插件实现** | 架构清晰，保留原互联与 UI，容易证明无宿主依赖 | 需要重新挑选目录校验和部分测试，处理实验数据边界 | **推荐** |
| `git reset --hard 42abec4` / 整库清理 | 操作短 | 破坏当前工作状态和审计历史，容易误伤未跟踪规划/其他会话成果 | 禁止 |

这里的“回到基线”是**保留历史的前向源码调整**：若用户后续授权实施，逐文件恢复该 feature 的基线内容、移除仅属于旧 feature 的文件，再增加本版代码。可以形成普通新提交，但不能重写已存在的 19 个提交。当前 `549a1d7` 已是完整历史快照，不需要为了保存它另建分支/worktree。

**先做 Task 1 证明方案，再做基线恢复。** 不能先丢掉现有实现，才发现新方案仍依赖宿主改动。

## Constraints

1. 不改 DSH checkout、本体、Desktop、Web shell、安装包、node_modules；不重建或提交宿主扩展。不通过“额外 companion 插件”替换核心 controller/loop 来规避本条。
2. 不 monkey patch，不读取 controller 私有字段、不新建第二个 controller；不安装 request/assemble/notice 覆盖 owner，不暂改全局默认再恢复。
3. 只用宿主已公开的包导出、服务、Session 事件和持久化接口。生产模块不得 deep import `lib/types/agent.js` 或任何 checkout 绝对路径；前述路径仅是审查依据。
4. 仅初始化**本插件这次 spawn 新创建的普通顶层 Session**。不补写既有会话的模型选择，不重写已有事件，不伪造 request/header、assistant response、用户输入或工具执行。
5. 原生 controller 是唯一运行期模型选择 owner。插件只在激活之前写真实的初始配置，之后让原生机制负责 prompt、request、重启和人类改模。
6. 原四工具、互联授权、消息归因、FIFO、预算、取消边界、幂等、unlink 不复活、双向 wake 默认和 UI 槽位保持 `42abec4` 语义。
7. 新版不承诺 task scope、自动 fallback、失败后自动换模型、任务恢复、get_task/resolve_task、任务 outbox 或卸载后的任务门禁。
8. 新会话选模是**初始配置**，不是“执行成功才切换”。若模型实际请求失败，仍保留该初始模型，由目标用户手动处理；不偷偷改默认或用其他模型执行。
9. 目录校验与 resolveCallConfig 如使用，只允许无收费模型请求的元数据/配置解析。不把网络鉴权失败假装成可用。
10. 不增加后台扫描/自动修复/定时重试。创建失败的恢复由同一 tool call 的明确重放驱动。
11. 本轮仅规划。实施时无自动分支、worktree、reset、stash、clean 或整库 restore；任何删除先核对实际绝对路径。

## Public Contract

### 参数

为避免把旧版“默认 task scope”的顶层 provider/model 调用悄悄解释成永久会话选模，使用新的明确字段：

```ts
session_spawn_linked_session({
  cwd, task, title?, auto_awake?, wake_caller?,
  initial_model?: {
    provider: string,
    model: string,
    reasoning_effort?: string
  }
})
```

- `initial_model` 省略：严格走原 spawn 逻辑。
- 对象严格校验：provider/model 必填非空；effort 必须是该精确 route 支持的值；省略则使用模型自身默认，不继承发起会话 effort。
- 旧顶层 provider/model/reasoning_effort/model_scope/on_model_unavailable 明确拒绝并说明新版字段；不得静默忽略、自动迁移或默认为 session scope。
- `session_send_session_message` 不接受任何选模参数；保持原普通消息功能。
- 保留 `session_list_models`，精简为部署目录查询，明确目录非执行承诺；移除 taskHost/task routing 能力标记，替换为如 `initialModelSelection: true/false` 的准确能力标记（实际装配满足 Task 1 的公开服务才为 true）。
- 只提供上述新建入口，不增加 `session_set_model` 或任务决策工具。

### 返回与错误

- 成功保持原 `sessionId/linkId/messageId/status` 及首段文本形状，便于旧 spawn 卡兼容。
- 可选增加 `initialModel`（规范化 provider/model/effort）与清晰的第二段说明：这是该 Session 的初始配置，不是某次任务隔离覆盖，也不是已经执行成功。
- `queued/accepted` 仍只是投递状态；不返回 taskId/attemptId/turn_finished。
- 校验失败在创建前直接返回工具错误。能力缺失也在创建/派发前拒绝。
- 部分创建失败必须回报“是否已有 sessionId、是否已链接、是否已投递”，不能抛成一个含糊的“什么都没发生”。无可证明的选模初始化成功，不投递首任务。
- 新版应使用新版本号（建议 `0.5.0`），文档明确这是取代实验性 task-routing 的收缩契约；不覆盖发布原有 0.4.1 包的含义。

## Chosen Architecture

### 原生初始选择记录 → 原生会话激活

首选路线如下，**Task 1 未通过前不可宣称已验证可用**：

1. 验证 caller、参数、目录、effort，得到完整规范 route。
2. 在插件现有存储/串行化机制中保留此次 spawn 的创建意图与完整参数摘要，锁定 caller/callId、目标 ID、cwd、初始 route 及原授权参数。
3. 通过公开 Session 构造/持久化 API，为这一全新 ID 建立**未激活、无消息、无模型调用**的普通 Session；初始化 native `model/selection` 事件。优先使用 `sessions.prepare`/Session 的公共 append 来生成正确序列与时间，再通过公共 persistence handle 提交，不能手写 JSONL。
4. 执行 `append → flush → close`：append 成功不等于 crash-durable；只有 flush/close 成功并通过公共读取确认初始事件匹配，才认为初始化完成。释放独占写 handle 后，调用原生 `sessionController.create({sessionId,cwd})` adopt/resume。原生 owner 从 pending 读到初始 route，并负责 preset、UI 模型状态和运行。
5. 复用旧 `claimSpawnLink → rename → send`；模型初始化完成前不能 send，也不能产生首任务唤醒。
6. 后续普通消息无需插件选模；原生 UI 切换模型后，插件不再恢复或覆盖旧 route。原生 UI 改模自身可能保存应用默认，这是用户主动操作的宿主行为，不是插件 spawn 的副作用。

### 必须解决的初始化细节

- Session header 使用宿主常量/类型，普通顶层、非 fork、非 subagent；不把写入初始事件混同于 fork seed。保持 cwd、preset 与普通 create 一致。adopt 路径会跳过原生新建分支的 mkdir，插件必须在 seed 前通过正常公开文件系统接口验证/创建目标 cwd；不以写了 header 代替实际目录准备。
- `create → append → flush → close` 不是原子事务，可能留下可见的空/部分 Session。发生模糊失败时不自动删除、不 activate/send；恢复只可在确证同一插件创建意图、仍未激活/未执行、持有独占写权限且内容符合预期时补齐。出现其他事件或 live Agent 即停止并报冲突，不能因为“它是空会话”就盲目修补。
- 通过公开 preset registry 解析当前默认（如部署有该服务），持久记录并验证恢复后工具/提示词仍与普通 create 相同；不可依赖硬编码 standard，不能绕过原生 composition。
- 两次创建必须无跨污染，不能用一个全局“nextModel”变量；route 必须绑定精确 Session ID 和创建意图。
- 原生 persistence/create 的“ID 已存在/写锁被占”是冲突，不可直接打开并向已有会话 append 初始选择。只有能证实属于同一创建意图且完全匹配的已完成初始记录，才可 adopt。
- 不在 `agent/created` 回调等待本 Agent idle，不在全局 mailbox chain 中等待可能反过来调用该 chain 的 Session activation。
- 当宿主的公开 API 不能完成以上流程，**停止本方案并报告能力缺口**。不得回退到污染全局的 selectModel、私有控制器访问、复制宿主源码、替代服务或修改本体；需要用户另行决策。

## Implementation

### Task 1: 在官方未修改宿主证明初始选模路线

**Objective**

用最小零付费 fixture 证明上述路径可以在真正生产装配的 native controller 上运行；不改生产代码、不恢复基线。

**Relevant files**

- [安装测试框架](<tests/integration/installed-smoke.mjs>)、[包依赖](<package.json>)。
- 新增独立 proof 测试/fixture（实施时定名，如 `tests/integration/initial-model-proof.mjs`）；必须只加载官方安装包，不使用当前 patched checkout alias。

**Implementation**

- 先确认官方版本、包来源、完整 native services。mock 只替代 LLM adapter 的外部请求，不替代 SessionController/create/selection owner/persistence/preset 装配。
- 在隔离 DSH_HOME/profile 下挂测试 adapter 和最小测试插件；基线模型 BASE，新会话指定 A/B。
- 测试插件只执行公开 seed/adopt API；证明 public persistence/Session/preset services 的 inject 合法、导出可用和原生会话收录正常。
- 若当前工作区缺少测试所需官方包，只在隔离测试环境获取/装配；不把修改后 SDK 当替代，也不修改已安装文件。测试 fixture 与实现需使用同一 bootstrap API 顺序。

**Depends on**

无。

**Verification**

必须观察实际 adapter request 与 prompt 变量/内容，而不只检查参数或日志：

1. 首次请求、含工具的第二 step、随后普通 turn 均按指定 route/effort；prompt 与请求一致。
2. 两个并发 spawn A/B、另一个未指定模型的 spawn BASE，互不影响。
3. 应用默认配置/内存选择、发起会话、无关会话均保持原样；包括异步保存任务落定后。
4. 原生 UI/controller 明确选 C 后，下一请求 C，插件不回改 A。
5. 首请求前重启、首响应后重启，以及插件移除后原生 resume，初始模型按原生机制保留；不依赖插件 hook 恢复。
6. 身份是普通顶层，Session 列表/打开/工具/preset/CWD 与普通创建一致；不是子代理或隐藏 loop。
7. seed 失败、能力缺失和 ID 碰撞时首任务请求数为零。

**Done when**

产出可复跑命令与官方包版本证据，所有门槛通过。否则停在此处，不执行 Task 2；在新计划中记录确切阻塞，不重新开启改本体路线。

### Task 2: 保留历史，恢复选模开发前的插件功能基线

**Objective**

去掉不再需要的 tracked-task 系统，恢复小型、独立插件架构。

**Relevant files**

- 对 `42abec4..549a1d7` 的 44 个文件逐项生成变更清单。
- 原有核心：[tools](<src/tools.ts>)、[link](<src/link.ts>)、[spec](<src/spec.ts>)、[types](<src/types.ts>)、[入口](<src/index.ts>)。
- 构建：[package](<package.json>)、[patch](<cordis.patch.yml>)、[bundler](<tsdown.config.ts>)、[host suite runner](<scripts/test-host.mjs>)。
- 客户端：[状态](<src/client/state.ts>)、[面板](<src/client/components.tsx>)、[轨迹卡](<src/client/TurnCard.tsx>)及其配套 parser/RPC/locales/tests。

**Implementation**

- 实施前重新检查 git 状态和其他会话工作，新增的无关改动不得恢复掉。逐文件评审 `git diff 42abec4..HEAD -- <path>`，不从此刻清单推断之后仍无其他修改。
- 以 `42abec4` 恢复选模开发修改过的旧文件；仅删除确认属于旧 feature 的新增模块。保留所有历史提交和用户文档，不使用整库 reset/clean。
- 移除运行依赖：task-host lazy/capability、task-runtime、tasks/task-spec、service-tasks、task-notifications、任务 RPC/UI、tasks bundle 子插件、新三工具中 get_task/resolve_task。
- 旧 runtime/host 契约套件不再是新产品验收标准：从默认门禁移除被取消功能的测试，但保留审查历史与提交证据，不能改断言把任务能力伪装成“通过”。
- 从当前 model-policy 中**只挑选**目录读取、provider/model/effort 校验和纯测试；去掉 scope/fallback/default-sentinel/taskHost 依赖，不整块搬回 595 行策略模块。
- 其余可复用的是 full-payload hash、同 key 串行化的做法及回归场景；不要把 task CAS/outbox 状态机一并搬回。
- 原 UI/双向唤醒/原四工具保持 `42abec4` 水平。旧 task 状态卡属于取消功能；已记录历史正文仍可阅读，但本版不继续给它们活动状态。
- 新计划、旧计划、旧审查、迭代路线图和未知缓存均不因源码恢复而删除。

**Depends on**

Task 1 PASS，且用户明确授权开始实施。

**Verification**

基线旧功能测试、build/typecheck/contracts/client/安装 smoke；对比正确基线，不再以“359 不能少”为目标。报告哪些测试因取消产品范围退休，哪些迁移成新 grip。

**Done when**

默认构建与安装无需 task-host；旧功能无回归；生产入口不再引用旧任务系统。宿主 checkout 完全未动。

### Task 3: 实现小型原生 bootstrap 和 spawn 幂等

**Objective**

把 Task 1 已证明的路径接入原 spawn，不重新实现选模 owner。

**Relevant files**

- [tools](<src/tools.ts>)、[link](<src/link.ts>)、[spec](<src/spec.ts>)、[types](<src/types.ts>)。
- 计划新增 `src/initial-model.ts`：严格参数与目录校验。
- 计划新增 `src/model-spawn.ts`：新 Session 初始化编排；与目录校验可按实际大小合并，但不得扩张为调度框架。

**Implementation**

- 新参数和错误按 Public Contract；模型省略时直接旧路径，不强制引入新服务依赖。
- 为选模 spawn 增加最小创建意图记录，优先在现有 ledger 的 schema 中增加一个可选 map（如 `initialModelSpawns`），而不是新增 task domain。不要提前伪造一个已授权/已链接的 `spawns` 记录。
- 记录最少：caller/callId → 确切目标 ID、完整规范请求的 SHA-256 摘要、初始 route、cwd、preset/原 wake 参数、seed 确认事实。摘要覆盖**完整** task/title/cwd/route/grants，不能截断；不保存 credentials。
- 只有同摘要可以 replay；包括改模型、改正文后缀、原无模型调用重放加模型等都要冲突或明确拒绝，不 adopt/重选。旧无模型 replay 继续保持原兼容规则。
- 原 ledger chain 负责原子 reserve/adopt/conflict；编排用按 caller/callId 的单飞，确保同一请求只创建/初始化一次。不要持有全局 mailbox chain 跨越 create/resume/send，避免重入死锁；不要新增宿主 insertIfAbsent 依赖。
- durable seed 已存在时验证最初选模事实和身份，不把当前模型又设回初始值；人类后来选模必须保留。
- 写入/close/create/link/send 各阶段失败都能明确回报。崩溃后同 call 重放只补缺少且安全的创建步骤，不额外发第二条已投递消息。不能确认初始化状态时停住，保留数据供排查。
- 已有 ID 但不属于这个意图、被归档、被人类删 link、变成别的身份等均拒绝。不要因为用了确定性 ID 就假定所有同 ID 数据归插件所有。
- 校验初始 seed 持久成功之后再使用原生 create/adopt、原 link/rename/send 链；第一条任务的预算与 wake_caller 继续由原逻辑处理。
- 保持持久化 peer dependency 为可选能力或按插件子作用域 inject：缺服务仅禁用带 initial_model 的 spawn，不能拖垮原四工具。

**Depends on**

Tasks 1–2。

**Verification**

实际首/后续请求、并发 A/B、同 call 冲突、长正文尾部 hash、seed/close/activation/link/mailbox 写故障、崩溃重放、不复活 unlink、不增加预算、普通无模型兼容。

**Done when**

初始选模可用且 runtime 不装任何模型覆盖 listener；目录错误和 seed 不确定状态不派发任务。

### Task 4: 轻量呈现与旧参数明确退出

**Objective**

用户能知道新会话初始配置，而不是看到不存在的任务状态机。

**Relevant files**

- [工具输出](<src/tools.ts>)、[卡片 parser](<src/client/turn.ts>)、[卡片](<src/client/TurnCard.tsx>)、[locale](<src/client/locales.ts>)。
- [README](<README.md>)、[IMPLEMENTATION](<IMPLEMENTATION.md>)、[VERIFICATION](<VERIFICATION.md>)。

**Implementation**

- 原 spawn 第一段不变，新字段/第二段显示“初始会话模型”；不要标“当前模型”“已实际使用”，除非另有原生事实支撑。
- 不建立模型管理面板、不轮询任务、不加 fallback 决策控件。后续选模交给原生 UI。
- 工具描述清晰说明初始会话范围；send 不允许选模。对旧参数与 get_task/resolve_task 的退出给迁移说明，不无声吞参。
- 更新文档区分实现测试与安装测试，标明只支持经验证官方版本，不因 peerDependencies=* 宣称支持所有宿主。
- 路线图与旧审查只作历史引用；将任务面板路线移出这次发布目标，之后另行重写，不擅自混入本轮实现。

**Depends on**

Task 3。

**Verification**

卡片 backward compatibility、初始/实际模型文案、schema/旧参数拒绝、built exports、client bundle 仍仅使用现有允许的 React 运行依赖。

**Done when**

界面和工具不再承诺 task scope/fallback/任务决策；新老普通 spawn 卡兼容。

### Task 5: 官方宿主集成验收与发布前数据检查

**Objective**

证明这是能独立安装的纯插件，不是用修改过的宿主跑绿测试。

**Relevant files**

- [测试入口](<package.json>)、[SDK 配置](<scripts/configure-sdk.mjs>)、[host runner](<scripts/test-host.mjs>)、[安装 smoke](<tests/integration/installed-smoke.mjs>)。
- 新的官方宿主初始选模 suite 与隔离 mock adapter fixture。

**Implementation**

- 构建、声明检查、新增核心选模测试均清除 DSH_SOURCE_ROOT，不映射到当前 patched checkout。测试启动时输出官方版本/模块来源，并验证不需要 taskHost/createTaskHost 扩展。
- 旧 source-dependent host tests 可保留为辅助，但必须明确不是纯插件选模的发行证据。新选模 suite 注册进默认验收入口，不能再次遗漏。
- packed tarball 装入隔离官方 Web profile，调用真实工具执行新建选模，mock 仅限模型 adapter；记录实际 provider/model/effort、prompt 和默认配置前后对比。
- 后续 Desktop 相同官方版本的隔离 profile 做加载/新会话原生选模显示检查；不改 Desktop 源码，不替换用户运行实例。无法执行则明确 NOT_RUN，不把 Web 当 Desktop 证据。
- 保留请求次数分开计量：`mockModelCalls > 0`，`paidModelCalls = 0`；不能沿用旧 smoke 的 modelCalls=0 来宣称路由执行验证完成。

**Depends on**

Tasks 3–4。

**Verification**

见下节完整矩阵。

**Done when**

纯插件官方宿主正向链、原互联功能和新合同均通过；不存在必需未提交宿主 diff。若 Desktop smoke 未跑，发布范围与报告明确限定，不笼统宣称全平台完整验证。

## Data / Host Cleanup Boundary

### 代码回到基线不等于可以降级旧实验数据

- 不删除 `session_link_tasks` 域、原 Session 日志、task/turn-intent 事件或缓存来制造“兼容”。
- 本版默认针对原普通互联 profile，及新的隔离验证 profile。**曾使用宿主扩展执行过 tracked tasks 的 profile，暂不自动原地迁移/降级。**
- 发布/切换前，单独确认目标 profile 是否存在旧 tracked-task 持久化记录、未投递任务/状态 mail、宿主专属日志事件。只读检查需要准确的 profile 路径；不能由“官方宿主没能力”推断所有 profile 都没旧数据。
- 若存在此类实验数据，停止切换，保留原 runtime/profile，优先使用独立新 profile；迁移/收尾另行获得授权。不要让基线 mailbox recovery 把旧 managed task 当普通消息执行。
- 不承诺让不含本体扩展的宿主读取扩展写出的所有历史都安全；必须另测 native event/format 兼容。

### 宿主改动如何处理

- 本版不依赖它们，但本轮也不自动撤销它们。该 checkout 混有 Desktop 开发脚本、UI、早期 session-link 等无关工作。
- 需要清理时另立授权任务，精确区分本功能的 task-host 新目录，以及 agent/index/types/model-selection-projection/core model-selection/storage-domain 中的对应 hunks；不要整文件 restore，更不要 `git reset --hard`。
- 不去修改当前安装的 Desktop。纯插件验收应直接用未改官方安装，而不是清理整个 checkout 后推断成功。

## Integration / Final Verification

最低必测矩阵：

| 层次 | 必测结果 |
|---|---|
| 原功能 | 四工具、preset scope、UI、双向 wake、取消/预算/幂等/unlink 行为不回归 |
| 参数 | initial_model 成对、精确 effort、未知字段拒绝；旧 task 参数明确退出 |
| 执行 | 新 A/B 会话首请求、多步、下一 turn 实际模型正确；prompt 一致 |
| 隔离 | app default、caller、另一个 BASE 会话不变；并发不串模型 |
| 原生接管 | UI 改 C 后不回改 A；重启/插件移除后仍由 native owner 管理 |
| 故障 | seed/close/activate/link/send 任一失败诚实报告，无选模成功则不派发 |
| 重放 | 同 call 同参数 adopt，异参冲突，不重选、不重复执行、不扩大授权 |
| 安装 | packed plugin + 未修改官方宿主 + native controller/persistence，实际 mock 请求证据 |
| 依赖 | 无 taskHost factory/shouldYield/projection v4/insertIfAbsent 新扩展要求，无私有 import |
| 数据 | 实验 tracked profile 不自动降级，不删除记录、不默认消费旧任务 |

预期命令（新增 script 在实施时注册，规划本身不声称已存在）：

```bash
# 使用配置好的 Node/pnpm；不要依赖 patched checkout 的 SDK alias。
env -u DSH_SOURCE_ROOT pnpm run typecheck
env -u DSH_SOURCE_ROOT pnpm run build
env -u DSH_SOURCE_ROOT pnpm run test:client
env -u DSH_SOURCE_ROOT pnpm run test:contracts
env -u DSH_SOURCE_ROOT pnpm run test:initial-model
env -u DSH_SOURCE_ROOT pnpm run test:integration
# 原有 source host suite 是辅助，不替代上面的官方宿主正向验证。
git diff --check
```

## Acceptance Criteria

- 不修改、不依赖任何未发布 DSH/desktop 扩展即可给新建普通顶层会话指定初始模型。
- 新会话由原生 controller 运行，模型实际请求与初始选择一致；后续原生改模有效。
- spawn 不改变应用默认或其他 Session，且不通过“改后恢复”伪装无副作用。
- 模型省略时旧流程不变；旧 task 参数不被悄悄解释为会话永久设置。
- 无复杂 task engine、fallback/outbox、额外 runtime model owner；无后台自动重试。
- 保留 `42abec4` 的 UI/互联/wake 成果、完整 git 历史和用户文档。
- 验收依据是未改官方宿主的实际 native 执行，而不是旧 359 个测试的计数。
- 若 bootstrap 的 public API 不能满足门槛，在基线恢复之前停止；未获得新授权不修改宿主“补齐”。

## Handoff Notes

1. 这不是上一版任务系统的第三轮修复，而是用户明确收缩范围后的新产品合同。
2. 只读检查已完成，尚未跑 native seed/adopt 的正向模型执行；Task 1 是首要不确定性，不可跳过。
3. 优先方案是“同一原生 owner 的初始持久选择”，不是“插件强行覆盖每个请求”。这与先前提出的 request hook 探索相比更小，但仍需实证。
4. 若 Task 1 的 bootstrap 需要越来越多 controller/preset/格式实现拷贝，应视为门槛失败，不扩张成第二个宿主。
5. 当前 commit `549a1d7` 保留全部旧成果，选择性复用以单个函数/测试场景为单位，不因投入大就保留已经不需要的状态机。
6. 本计划只推荐前向基线恢复；实际执行需用户后续明确要求。当前没有恢复任何源码、移除文件、改分支、修改宿主或运行真实模型。
