# 会话互联交互讨论稿与后续实施计划

## Goal

本目录保留先前 UI 讨论阶段的独立 HTML 和原始设计记录。原型浏览器直接打开 `session-link.html`，无服务端、网络请求或外部依赖，刷新恢复默认状态。

**后续批准的正式实现已进入当前工作区**：详见 [README](../README.md)、[实施记录](../IMPLEMENTATION.md) 和 [验证记录](../VERIFICATION.md)。本文件以下的「当前／后续／待确认」描述属于原型阶段，不是当前生产代码状态；现用 profile、旧授权与消息记录仍未修改。工具最终采用独立 `wake_caller` 参数，省略时跟随 `auto_awake`；UI 新组两个方向默认开并需显式确认。

## Context / 已核对事实

- 当前仓库版本 0.4.1。
- `src/scope.ts` 的默认名单是 standard / ptc / cordis，按 Agent 的 composedPreset 精确匹配，因此用户默认选择 coding 会漏挂工具与命令。
- SDK 0.2.0-rc.2 的 AgentPresetRegistry 暴露 config.selectedDefault 与 defaultId。实现前应核实 defaultId 的回退语义及默认选择变更的生命周期。
- SDK 的 SessionNodeItem 没有 onContextMenu，也没有整行右键注册接口；正式提供 `sidebar.workspaces.session.menu.item` 和 `sidebar.workspaces.session.row.action`。本稿选择 … 菜单，不劫持 DOM。
- 当前 leading 插槽只在空闲行渲染；宿主运行/待交互状态优先。插件的绿点表示唤醒授权，不是运行状态，视觉上易混淆。
- 当前 HeaderAction 点击仅打开右侧面板，本稿改为点击快速选择器，保留管理入口。
- 当前建链与 spawn 均只把对方加入 autoWakeSessionIds。成员关系本身双向，不需要反向建链。
- 当前 setAutoWakeFrom 拒绝 peerId === callerId，因此“唤醒我”不能仅改客户端；需要明确的宿主授权 API 变更。模型工具不能自行给已有关系扩权。

## Confirmed decisions / 已确认

1. 默认 standard / ptc / cordis 自动补 selectedDefault，minimal 仍排除；其他自定义 preset 由用户在 README 指引下手动添加。不扫描全部 preset，不改写 profile。
2. 最终选择右侧 hover 链条按钮，使用正式 `sidebar.workspaces.session.row.action` 插槽，不再使用 leading 插槽，左侧运行状态位完全交还宿主。已互联强调色、未互联普通色，悬浮提示互联数量，与 auto-wake 无关；点击管理被点击的会话。键盘聚焦同样可见，触屏保留入口；… 菜单继续保留。不修改宿主，不做常驻尾标或 DOM 劫持。
3. 顶栏提供快速连接已有会话的交互，先原型讨论。
4. 自动唤醒必须有可见文字，和“已互联”分开。

## Constraints

- 仍排除子代理，归档执行校验、预算、取消、持久化、幂等与重放语义不变。
- 读取菜单、候选列表不能激活所有会话。
- 列表菜单必须管理被点击会话，不能误用当前主视图 sessionId。
- 两方向开关对应组内接收成员授权；多人组中不是独立的 A→B 边，UI 需按真实成员语义表达。
- 不追溯扩权旧互联组；原有单向授权继续有效。
- 本原型仅双成员组、无异步 RPC，不证明生产宿主行为。

## Implementation

### Task 1: 默认 preset 适配（后续正式实施）

**Objective** 默认用户开箱可用，不覆盖高级用户明确选择。

**Relevant files** `src/scope.ts`、`src/tools.ts`、`src/command.ts`、`README.md`、宿主挂载测试。

**Implementation** 采用标准名单 + selectedDefault，去重并排除 minimal；选用 registry 正式 API，不读取或写入磁盘 profile。建议保留显式 presets 为精确白名单（包括空数组），自动补全只用于省略配置；这一细节需确认，且不能因 schema 先填默认数组而丢失“是否显式配置”信息。默认选择变化应在宿主正式生命周期中同步。

**Verification** coding 为 selectedDefault 时挂载；非默认自定义 preset 不挂载；minimal 默认不挂载；显式白名单/空数组不被自动扩展；子代理仍排除；工具和命令一致。

**Done when** 文档和回归测试明确覆盖这套语义。

### Task 2: UI 原型（本轮交付）

**Relevant files** `prototypes/session-link.html`、`prototypes/smoke.mjs`。

**Implementation** 顶栏点击展开非模态选择器；搜索、排除自身/已互联对象、选择候选、明确确认；支持两个方向的独立选项。列表 … 打开指定会话管理面板；右栏显示已互联、开关文字、回程关闭提醒、打开会话、解除确认。中间消息模拟器复现排队及人工启动行为。新建互联暂双向预选，并明确标为讨论项。

**Verification** 浏览器 smoke 覆盖建链、取消、搜索、排队/人工启动、双向设置、列表作用域、解除确认、响应式与控制台错误；无网络请求。

**Done when** HTML 可直接本地打开，交互可演示；不冒充实际 DSH GUI 更新。

### Task 3: 回程自动唤醒语义（待确认后实施）

**Objective** A 创建 B 后，B 的回复在 A 空闲时也能触发工作。

**Relevant files** `src/link.ts`、`src/tools.ts`、`src/types.ts`、`src/client/*`、`tests/link.spec.ts`、`tests/tool-session-link.spec.ts`。

**Recommendation** 新 spawn 在明确启用双向自动唤醒时，同时授权新会话和创建方；UI 同样让人分别选择两个方向。不能让 B 在发送回复时自行扩张 A 的授权。

**Open decision** 将 auto_awake=true 的新建语义改为双向，还是增加独立的“允许回复唤醒创建方”参数（更兼容、更精确）？原型先展示两个可见开关，不代表已决定工具参数。需要同步工具描述、返回值、README 与测试。auto_awake=false 的首任务首次唤醒特例仍保留，不能顺带授予永久回程。

**Verification** A idle 后 B 回复能唤醒；关闭回程时排队；running 时无需唤醒仍送达；旧组、重放、人类关闭、归档、预算用尽、取消均不能被重新扩权。链预算依然按实际 in_reply_to 链执行，不宣称无限往返。

## Evidence / 用户指定会话

只读核对本机 session_link 存储与两个会话的 projection cache（没有改动或调用模型）：

- A = session-5d6b520d-3f81-291d-85c0-eb9dcf70271b（互联测试3）。
- B = session-c717d54c-b114-ad20-2145-104d8e0ec848（auto-wake 测试会话）。
- 组 session-link-2f83a03c-8031-4605-b6b7-febe3046e722 包含 A/B，autoWakeSessionIds 只有 B；revision 1，未出现后续授权更新。
- 2026-10-11 02:08:09.325（Asia/Shanghai）：B→A 第一条回执创建，消息 6e0e68b0…，wakesUsed=0。
- A projection timeline：02:12:52.391 人工输入复制的结果；02:12:59.317 注入上述 peer 回执。说明回执在用户启动后的后续轮进入，而不是该回执自动唤醒了 A。
- A→B 第二次 ping（d2d7b8fe…）wakesUsed=1；B→A 第二次回执（41745189…）wakesUsed=0，在 A 后续轮出现。不能用第二次回复“最终出现了”来证明 A 的自动唤醒已开启。
- 存储当前状态 delivered 表示最终送达，不表示创建时就送达；没有独立 deliveredAt 字段，不能把 createdAt 当送达时间。以上注入时序来自 projection timeline。

## Integration / Final Verification

原型验证：`node prototypes/smoke.mjs`（默认本机 Brave，可用 BROWSER_EXECUTABLE_PATH 覆盖）。2026-10-11 实际运行：35 项检查通过、exit 0、无浏览器异常、无 HTTP 请求；检查了桌面快速建链、管理和 390px 窄屏截图。首次测试发现 resize 会关闭选择器，改成重新定位后完整重跑通过。正式插件之后再跑 typecheck、build、client/contracts tests、host regression 和安装 smoke。本轮不构建或替换实际 GUI。

## Acceptance Criteria

- 用户能亲自比较单向、双向自动唤醒，理解回复排队不是断联。
- 顶栏快速建链和列表菜单管理都可操作。
- prototype 不接真实宿主，不写真实数据。
- 将确认事项与仍待决定的权限语义明确分开。
