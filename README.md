# dsh-session-link

[English](README.en.md) | 简体中文

独立的 DeepSeek Harness 会话互联插件。0.5.0 保留原有互联、邮箱、自动唤醒、命令和 UI，新增**新会话的初始模型选择**。使用官方 `0.2.0-rc.2` 的公开接口，不修改宿主源码。

## 使用

点击会话头栏「互联」，搜索已有会话、确认两个方向的自动唤醒，再点「建立互联」。右侧面板可打开对方会话、调整唤醒或确认解除。会话列表的右侧链条按钮和 `… → 会话互联…` 管理被点击的会话，不切换主对话。链条颜色只表示互联，与运行状态、唤醒开关无关。

双成员组按「我发消息 → 唤醒对方／对方发消息 → 唤醒我」显示；多人组按接收成员授权显示。同一成员的开关适用于该组全部发送方。新 UI 互联的两个开关默认开，需确认；旧组和人工关闭的开关不补授权。只有存在、未归档的普通顶层会话可以互联，重复会话对在串行队列内原子拒绝。

消息带非人类来源，接收方获得消息文本，不共享模型历史或权限。运行中的接收方通过 follow-up 接收；空闲且无唤醒授权时，消息留在持久邮箱，等待下一轮工作。自动唤醒受每日、单消息和回复链预算限制。

```text
/session-link list
/session-link add <peer-session-id> [wake]
/session-link wake <peer-session-id> on|off
/session-link revoke <link-id>
```

共五个供模型调用的工具：

- `session_list_links`：查询互联。
- `session_send_session_message`：发送或用 `in_reply_to` 回复，不能给自己发送；不支持选模。
- `session_cancel_session_message`：取消尚未插入对方会话的消息。
- `session_spawn_linked_session`：新建普通会话、互联并投递初始任务，可设置初始模型。
- `session_list_models`：查询部署的 provider、model、effort 元数据，可按 `provider` 过滤。

工具和命令按 preset 挂载到顶层 Agent 的 `agent.ctx`，不进入全局工具层。省略 `presets` 时包含 `standard`、`ptc`、`cordis` 和公开 registry 的有效默认 preset；显式列表是精确白名单，空列表禁用挂载。`minimal` 与子代理始终排除，归档会话不能执行工具。资格随 Agent 创建和 preset 切换重新检查；仅改变默认 preset 不主动重挂存量 Agent。

## 新会话的初始模型

先调用 `session_list_models` 查询目录，再给 spawn 传可选的严格对象：

```json
{
  "cwd": "/absolute/path/project",
  "task": "完整、自包含的任务描述",
  "initial_model": {
    "provider": "目录中的 provider ID",
    "model": "该 provider 下的 model ID",
    "reasoning_effort": "该模型支持的 effort ID"
  }
}
```

`provider`、`model` 必填；`reasoning_effort` 可省略，省略时使用所选模型自身默认，不继承调用方 effort。对象不接受其它字段。未传 `initial_model` 时沿用原创建、建链和投递流程；所有 spawn 共用同调用并发锁，并发异参返回 `SPAWN_REPLAY_CONFLICT`，普通调用完成后的重放仍保持原兼容规则。目录存在只证明部署元数据可用，不证明鉴权有效或执行成功。

初始选择通过原生 `model/selection` 事件写入新会话，在第一条任务激活前持久确认；之后的请求与恢复完全交给原生 Session Controller。选择跨 turn 保留，用户后来在宿主 UI 改选的模型优先。插件不覆盖运行时模型选择，不修改应用默认模型，不提供临时任务路由、fallback 或模型失败重跑。

spawn 的第一段工具文本保持旧格式；第二段携带 version 1 的 `session-link/initial-model` 元数据。轨迹卡只标记**「初始会话模型」**，不把它当作当前模型或成功执行的证据。`queued` / `accepted` 仍只表示消息投递状态。

同一调用重放复用原会话、互联组和任务。选模 spawn 对完整请求计算摘要，模型、完整任务、目录、标题或授权变化均拒绝；不能在重放时添加或移除 `initial_model`。未确认且已有同 ID 的会话不自动认领、修复或激活。创建成功但 ownership 确认前崩溃可能留下空的孤儿会话；报错说明需人工检查，插件不会覆盖或删除它。解除后的组不会因重放恢复。

旧的顶层 `provider`、`model`、`reasoning_effort`、`model_scope`、`on_model_unavailable` 明确拒绝。发送工具也拒绝 `initial_model`。`session_get_task`、`session_resolve_task`、任务面板、任务卡和 `./tasks` 子导出已退出本版。

## 投递与唤醒

- `queued` 表示邮箱已持久保存；`accepted` 只在消息插入对方并 flush 成功后返回。两者都不表示对方已处理或完成任务。保存后投递失败保持 queued，重试投递同一条，不重复建任务。
- 发送报错表示消息没有保存、在插入对方前已取消，或属于被阻止重放的遗留报告，不会之后偷偷投递。插入后取消不再生效；flush 失败继续恢复确认。同一目标按持久入队顺序投递。
- 幂等 key 与消息同次写入；已取消、失败或撤销消息的 key 返回 `MESSAGE_UNDELIVERABLE`。`in_reply_to` 只能指向本会话已收到的消息；回复链预算跨组累计。
- spawn 首任务欠一次预算内唤醒，`auto_awake` 控制后续消息，默认 false；`wake_caller` 默认跟随 `auto_awake`，可独立设为 false 或 true。首任务不会额外授予回程唤醒。重放使用首次固化的授权，不扩权。
- UI / 命令创建 human grant，spawn 创建 session grant。解除阻止尚未投递的组内消息，已插入对方的消息不撤回。卸载先停止新操作、等待在途操作，再关闭存储。

## 安装

先构建和打包。`dsh-agent-preset-registry` 和 `dsh-session-persistence` 是 optional peers，缺失时普通工具仍可挂载，带 `initial_model` 的调用明确拒绝。运行时 peers 从目标 DSH profile 解析；禁用自动安装 peers，避免拉入另一套宿主。

```sh
pnpm install --frozen-lockfile
env -u DSH_SOURCE_ROOT pnpm build
pnpm pack
```

Web 等普通 profile：

```sh
dsh plugin --profile web add --ignore-scripts --config.auto-install-peers=false /absolute/path/dsh-session-link-0.5.0.tgz
```

Desktop profile 由 Electron 独占管理。先打开一次 Desktop 初始化 profile，再完全退出，使用应用自带 CLI：

```sh
DESKTOP_DSH='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
"$DESKTOP_DSH" plugin --profile desktop add --ignore-scripts --config.auto-install-peers=false /absolute/path/dsh-session-link-0.5.0.tgz
```

重新打开后生效。Desktop 运行时不要做包操作。应用内 Plugins 页面可查看和启停插件；最后一个安装参数也可换成构建好的目录 `link:/absolute/path/dsh-session-link`。构建或隔离验证不会切换用户当前 profile。

### 从 0.4.1 升级

普通互联版 0.4.1 可用上述 `add` 命令覆盖安装同名包，无需先卸载；原互联关系和历史消息保留。Desktop 更新前完全退出应用，更新后重新打开。

实验性任务路由版也使用过 0.4.1 版本号，不能只按版本号判断兼容性。若使用过顶层选模参数、task scope、fallback 或 `session_get_task` / `session_resolve_task`，先检查该 profile 的实验数据；本版不自动迁移这类 profile。

fork 若已内置同名服务，切换时需先关闭旧服务、旧 UI 和各 preset 的旧工具／命令，使外置插件成为唯一实现。**已运行 tracked-task 实验版的 profile 不自动原地迁移或降级**；带 `statusKind` 或 `taskStatus` 标记的遗留状态报告会保留原记录，但不投递、不唤醒；显式重放返回 `LEGACY_TASK_MESSAGE_BLOCKED`。这不覆盖未标记的任务邮件或宿主专属事件，切换前仍必须人工检查这些数据；本版不迁移、不自动清理历史存储域。

卸载：Web 用 `dsh plugin --profile web remove dsh-session-link`；Desktop 退出后用 `"$DESKTOP_DSH" plugin --profile desktop remove dsh-session-link`。卸载保留已记录会话消息和 `session_link` 数据，不恢复旧模型、不回滚用户的原生选择。

## 配置

profile 的 `cordis.patch.yml` 可覆盖配置；补丁替换整行 config，需写全希望保留的自定义项。

```yaml
- id: session-link
  config:
    uiPollIntervalMs: 30000
    maxLinkMembers: 8
    maxPendingPerTarget: 16
    maxMessageBytes: 16384
    maxAutoWakesPerSessionPerDay: 6
    maxAutoWakesPerMessage: 1
    maxAutoWakesPerChain: 4
    maxDeliveryAttempts: 3
```

非默认自定义 preset 可显式列出；工具与命令两行需同时调整：

```yaml
- id: tool-session-link
  config:
    presets: [standard, ptc, cordis, coding, my-custom-preset]
- id: command-session-link
  config:
    presets: [standard, ptc, cordis, coding, my-custom-preset]
```

`uiPollIntervalMs` 范围 1000–2147483647。UI 共用宿主 view，在有订阅时轮询，写入确认或连接重置后刷新；失败保留最后读到的数据并显示重试。

## 开发与验证

默认使用 npm `0.2.0-rc.2` 开发 SDK，不要求 source checkout 或 task-host 扩展。

```sh
env -u DSH_SOURCE_ROOT pnpm typecheck
env -u DSH_SOURCE_ROOT pnpm build
env -u DSH_SOURCE_ROOT pnpm test
```

`pnpm test` 包括客户端、初始模型单位测试、原生 proof、packed 工具验收与构建契约；构建契约需要先 build。官方原生 proof 为 19 次 mock 请求，packed 工具验收为 30 次，均无付费调用。客户端 56 项、初始模型 55 项、契约 3 项，以及另行运行的辅助 host 回归 120 项通过。浏览器 smoke 和验证边界见 [VERIFICATION.md](VERIFICATION.md)。

```sh
BROWSER_EXECUTABLE_PATH='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' pnpm test:integration
```

这些安装验证使用一次性 home/profile，不修改用户运行实例。说明见 [tests/integration/README.md](tests/integration/README.md)。`DSH_SOURCE_ROOT=/absolute/path/deepseek-harness pnpm test:host` 仅运行原四组辅助宿主回归；source declarations 可辅助开发，不能替代官方 SDK 构建和 packed 验证。

## 兼容性与限制

保留 `session_link` version 1、三张表、`session-link-message` 来源及原邮箱语义；ledger 增加可选 `initialModelSpawns`，记录完整请求摘要、`headerCreated`、`seedConfirmed` 等创建事实。旧记录缺字段按空读，无新任务域或 Session 日志格式。模型初始化使用宿主已有事件，不引入新的运行时模型 owner。

客户端运行时只加载冻结模块表中的 React、JSX runtime 和 ReactDOM；控件、样式、协议校验、状态与翻译在包内。Remote 由公开服务发现，不生成 `./typert` / `./remote` 或改宿主 allowlist。轨迹尾卡依赖可选 `uiConversation`，缺席时其它 UI 仍可用。

用户停止会清空 Agent inbox，因此已送达不等于模型已读；以对方回复为准。邮箱与台账不自动清理，长期大量使用需关注规模。卸载等待在途操作没有超时。Desktop Electron 本轮未测试；未来宿主版本需重新验证。

用户已反馈 0.5.0 初步测试通过；未提供具体环境及覆盖范围，不能据此扩大 Electron 或付费模型的验证结论。

旧模型路由计划、审查和路线图保留为历史证据，并明确标为已废弃。0.5.0 用前向源码修改取代实验版本，保留 Git 历史；DSH 仓库中的旧扩展不属于当前依赖，也不随本插件提交回退。详见 [架构与历史处理决定](docs/decisions/001-plugin-only-initial-model.md)。
