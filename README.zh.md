[English](README.md) | 简体中文

# DuoLink · 会话互联

`dsh-gc-duolink`

DeepSeek Harness Desktop / Web 的会话互联与消息插件：建立互联、持久收发消息、管理唤醒预算、新建带初始模型的普通会话。使用官方 `0.2.0-rc.2` 公开接口，不修改宿主源码。

**预发布版本：[0.6.1-beta](https://github.com/cskeleton/dsh-gc-duolink/releases/tag/v0.6.1-beta)。** DuoLink 使用独立的配置、存储与协议标识，不读取或迁移旧 `dsh-session-link` 的配置、互联组、邮箱和账本。请先停用或卸载旧插件，再在 DuoLink 中重新建立互联与唤醒授权；旧存储文件可保留，请勿改名或复制到新存储域。详见 [命名空间隔离](docs/plans/duolink-isolation.md) 和 [验证记录](VERIFICATION.md)。

## 使用

复制会话 ID 使用 DSH 在会话列表 `…` 菜单中的内置入口，DuoLink 不再新增重复入口。「会话互联…」使用宿主菜单组件，字号和间距与原生菜单保持一致。

点击会话头栏「互联」，搜索已有会话、确认两个方向的自动唤醒，再点「建立互联」。右侧面板可打开对方会话、调整唤醒或确认解除。会话列表的右侧链条按钮和 `… → 会话互联…` 管理被点击的会话，不切换主对话。外侧链条按钮仅在会话已有互联关系时显示，解除最后一个互联后隐藏；与运行状态和唤醒开关无关。未互联时仍可从菜单进入。

界面语言跟随 DSH 的共享语言偏好，面板打开时切换语言也会同步更新。候选列表默认显示最近活跃的 3 个可互联会话，「展示更多」扩展到 8 个；搜索会先匹配全部可互联会话，再应用显示数量限制。

互联卡片可通过标题栏折叠，右侧提供「解除互联」并保留二次确认。双人卡片只在标题显示一次对端会话名，下方为 ID、状态及唤醒控制；多人组保留各接收成员的名称以区分授权。

双成员组按「我发消息 → 唤醒对方／对方发消息 → 唤醒我」显示；多人组按接收成员授权显示。同一成员的开关适用于该组全部发送方。新 UI 互联的两个开关默认开，需确认；旧组和人工关闭的开关不补授权。只有存在、未归档的普通顶层会话可以互联，重复会话对在串行队列内原子拒绝。

消息带非人类来源，接收方获得消息文本，不共享模型历史或权限。运行中的接收方通过 follow-up 接收；空闲且无唤醒授权时，消息留在持久邮箱，等待下一轮工作。自动唤醒受每日、单消息和回复链预算限制。

面板按被管理会话展示待投递与最近消息、当前已知阻塞条件及唤醒预算。普通待投递消息可由原始发送方或接收方点击「取消待投递消息」；按钮只是快照，最终结果区分已取消、已终结和已来不及。目标可能已持有、已持久接收的内容不能撤回；若目标正在运行，可打开原生会话使用宿主停止入口。解除互联同样不会停止已运行会话，也不撤回已交付内容。遗留实验报告仅显示诊断，不能通过该入口取消或恢复投递。

```text
/gc-duolink list
/gc-duolink add <peer-session-id> [wake]
/gc-duolink wake <peer-session-id> on|off
/gc-duolink revoke <link-id>
```

共五个供模型调用的工具：

- `gc_duolink_list_links`：查询互联。
- `gc_duolink_send_message`：发送或用 `in_reply_to` 回复；可选 `wake:false` 不申请唤醒空闲目标，不能给自己发送，不支持选模。
- `gc_duolink_cancel_message`：取消尚未插入对方会话的消息。
- `gc_duolink_spawn_session`：新建普通会话、互联并投递初始任务，可设置初始模型。
- `gc_duolink_list_models`：查询部署的 provider、model、effort 元数据，可按 `provider` 过滤。

工具和命令按 preset 挂载到顶层 Agent 的 `agent.ctx`，不进入全局工具层。省略 `presets` 时包含 `standard`、`ptc`、`cordis` 和公开 registry 的有效默认 preset；显式列表是精确白名单，空列表禁用挂载。`minimal` 与子代理始终排除，归档会话不能执行工具。资格随 Agent 创建和 preset 切换重新检查；仅改变默认 preset 不主动重挂存量 Agent。

纯信息同步可发送：

```json
{ "session_id": "session-对端ID", "message": "仅同步结论，无需确认。", "wake": false }
```

省略 `wake` 或传 `true` 保持原有行为，仍受互联授权和预算限制。`false` 不申请空闲唤醒、不冷恢复、不扣唤醒额度；运行中的对端仍接收 next-turn 输入，可能形成后续回合，其他合法唤醒或人类活动也可按 FIFO 顺带交付，因此不等于零计算。发送意图随消息持久化，旧记录缺字段按 `true`；同一幂等 key 重放使用原记录，不能用 `false → true` 提升唤醒。spawn 不接受 `wake`，首任务与双向授权规则不变。新消息框架提示只回复实质结果、问题或阻塞，不重写旧正文；提示也计入字节上限。**降级到不识别 `wake` 的旧插件可能丢失不唤醒语义。**

## 新会话的目录与工作区

`gc_duolink_spawn_session` 的 `cwd` 可省略：沿用当前会话的实际目录和 Workspace，在同一分组下创建并列的普通顶层会话。当前会话未分组时，新会话也保持未分组，不改变原会话。

显式传入绝对 `cwd` 时，插件创建或复用该目录的 Workspace，再关联新会话；目录不需要提前在 Desktop 中打开。不存在的目录由原生创建流程建立，新的 Workspace 和成员关系通过宿主同步显示到 Desktop/Web，不自动切换当前聊天。子目录使用独立 Workspace，不归入父目录；软链接和 `..` 按规范化真实路径复用已有分组，保留已有分组名称。

普通创建和 `initial_model` 创建使用相同规则。归类成功后才投递首任务；归类失败明确报告已创建的会话与互联组，首任务不入队，同一调用重试复用原会话并继续归类。已完成的归类不会因工具重放而恢复用户后来移除的成员或分组；待完成的归类若对应 Workspace 已被删除，明确报错而不重建。旧版已完成调用不会在重放时补迁移，已有未分组会话也不会自动搬动。缺少调用方目录且未传 `cwd` 时直接报错；显式空值、空字符串和相对路径不回退。

```json
{ "task": "在当前项目并行审查，完成后回报结果" }
```

## 新会话的初始模型

先调用 `gc_duolink_list_models` 查询目录，再给 spawn 传可选的严格对象：

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

`provider`、`model` 必填；`reasoning_effort` 可省略，省略时使用所选模型自身默认，不继承调用方 effort。对象不接受其它字段。未传 `initial_model` 时沿用原创建、建链和投递流程；所有 spawn 共用同调用并发锁，并发异参返回 `SPAWN_REPLAY_CONFLICT`，普通调用完成后的重放仍遵守既有调用的幂等约束。目录存在只证明部署元数据可用，不证明鉴权有效或执行成功。

初始选择通过原生 `model/selection` 事件写入新会话，在第一条任务激活前持久确认；之后的请求与恢复完全交给原生 Session Controller。选择跨 turn 保留，用户后来在宿主 UI 改选的模型优先。插件不覆盖运行时模型选择，不修改应用默认模型，不提供临时任务路由、fallback 或模型失败重跑。

spawn 的第一段工具文本保持旧格式；第二段携带 version 1 的 `gc-duolink/initial-model` 元数据。轨迹卡只标记**「初始会话模型」**，不把它当作当前模型或成功执行的证据。`queued` / `accepted` 仍只表示消息投递状态。

同一调用重放复用原会话、互联组和任务。选模 spawn 对完整请求计算摘要，模型、完整任务、目录、标题或授权变化均拒绝；不能在重放时添加或移除 `initial_model`。未确认且已有同 ID 的会话不自动认领、修复或激活。创建成功但 ownership 确认前崩溃可能留下空的孤儿会话；报错说明需人工检查，插件不会覆盖或删除它。解除后的组不会因重放恢复。

旧的顶层 `provider`、`model`、`reasoning_effort`、`model_scope`、`on_model_unavailable` 明确拒绝。发送工具也拒绝 `initial_model`。`session_get_task`、`session_resolve_task`、任务面板、任务卡和 `./tasks` 子导出已退出本版。

## 投递与唤醒

- `queued` 表示邮箱已持久保存；`accepted` 只在消息插入对方并 flush 成功后返回。两者都不表示对方已处理或完成任务。保存后投递失败保持 queued，重试投递同一条，不重复建任务。
- 发送报错表示消息没有保存、在插入对方前已取消，或属于被阻止重放的遗留报告，不会之后偷偷投递。插入后取消不再生效；flush 失败继续恢复确认。同一目标按持久入队顺序投递。
- 幂等 key 与消息同次写入；已取消、失败或撤销消息的 key 返回 `MESSAGE_UNDELIVERABLE`。`in_reply_to` 只能指向本会话已收到的消息；回复链预算跨组累计。
- spawn 首任务欠一次预算内唤醒，`auto_awake` 控制后续消息，默认 false；`wake_caller` 默认跟随 `auto_awake`，可独立设为 false 或 true。首任务不会额外授予回程唤醒。重放使用首次固化的授权，不扩权。
- UI / 命令创建 human grant，spawn 创建 session grant。解除阻止尚未投递的组内消息，已插入对方的消息不撤回。卸载先停止新操作、等待在途操作，再关闭存储。

## 安装

从预发布页面下载 [dsh-gc-duolink-0.6.1-beta.tgz](https://github.com/cskeleton/dsh-gc-duolink/releases/download/v0.6.1-beta/dsh-gc-duolink-0.6.1-beta.tgz)，在 DSH 插件安装器中选择该文件；同页提供校验和与交付清单。此前本地 0.6.1 安装包是测试快照。下方步骤用于源码开发安装。

先构建目录，开发安装使用 `link:`，不生成安装包。`dsh-agent-preset-registry` 和 `dsh-session-persistence` 是 optional peers，缺失时普通工具仍可挂载，带 `initial_model` 的调用明确拒绝。运行时 peers 从目标 DSH profile 解析；禁用自动安装 peers，避免拉入另一套宿主。

```sh
pnpm install --frozen-lockfile
env -u DSH_SOURCE_ROOT pnpm build
```

Web 等普通 profile：

```sh
dsh plugin --profile web add --ignore-scripts --config.auto-install-peers=false link:/absolute/path/dsh-gc-duolink
```

Desktop profile 由 Electron 独占管理。先打开一次 Desktop 初始化 profile，再完全退出，使用应用自带 CLI：

```sh
DESKTOP_DSH='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
"$DESKTOP_DSH" plugin --profile desktop add --ignore-scripts --config.auto-install-peers=false link:/absolute/path/dsh-gc-duolink
```

重新打开后生效。Desktop 运行时不要做包操作。应用内 Plugins 页面可查看和启停插件；最后一个安装参数也可换成构建好的目录 `link:/absolute/path/dsh-gc-duolink`。构建或隔离验证不会切换用户当前 profile。

### 独立安装

将 DuoLink 作为新插件配置，通过 UI 或 `/gc-duolink` 重新建立需要的互联和唤醒授权。旧插件数据不会被导入、重命名、复制或删除。只有下方的新配置行 ID 对 DuoLink 生效。profile 的共享 `cordis.patch.yml` 属于 DSH，本轮不会改动其文件名，旧插件配置行也不会覆盖 DuoLink。

默认 JSON 后端将数据写入 `$DSH_HOME/storages/gc_duolink.json`，不会回退读取 `session_link.json`。磁盘中保存插件身份标记；把旧版或其他非空存储复制到新路径会明确拒绝，不支持手动改名迁移。

`dsh-client-ui-copy-session-id` 的源码继续保留；DSH 已提供内置复制入口时，保持该独立插件停用，避免菜单重复。DuoLink 不再包含自己的复制实现。构建和验证不修改实际用户 profile。

卸载：Web 用 `dsh plugin --profile web remove dsh-gc-duolink`；Desktop 完全退出后用 `"$DESKTOP_DSH" plugin --profile desktop remove dsh-gc-duolink`。卸载保留 DuoLink 数据和会话历史。

## 本地目录与 GitHub

真实目录为 `/Users/gc/Dev/MyProject/dsh-plugin/dsh-gc-duolink`，原 `.git`、`master`、提交和未提交修改均保留。旧目录名的兼容软链接已移除；源码调整不会自动重写旧 profile 中的依赖路径。

GitHub 已将原仓库重命名为 [cskeleton/dsh-gc-duolink](https://github.com/cskeleton/dsh-gc-duolink)，沿用原有历史、issues、tags 和 releases；本地 `origin` 已同步为：

```text
https://github.com/cskeleton/dsh-gc-duolink.git
```

原仓库地址会重定向到新地址；不要重新占用旧仓库名。默认英文文档为 `README.md`，中文为 `README.zh.md`，首行可切换语言。详见 [GitHub 官方说明](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository)。

## 配置

插件自带配置文件为 `gc-duolink.patch.yml`，对外注册标识均为独立命名空间：

| 入口 | DuoLink 标识 |
|---|---|
| 服务／工具／命令配置行 | `gc-duolink` / `tool-gc-duolink` / `command-gc-duolink` |
| 存储域 | `gc_duolink` |
| 服务和 RPC | `gcDuolink` / `gcDuolink/*` |
| 命令 | `/gc-duolink` |
| 消息来源 | `gc-duolink-message` |
| 初始模型元数据 | `gc-duolink/initial-model` |

profile 的 `cordis.patch.yml` 可覆盖配置；补丁替换整行 config，需写全希望保留的自定义项。

```yaml
- id: gc-duolink
  config:
    uiPollIntervalMs: 30000
    maxLinkMembers: 8
    maxPendingPerTarget: 16
    maxMessageBytes: 16384
    maxAutoWakesPerSessionPerDay: 12
    maxAutoWakesPerMessage: 1
    maxAutoWakesPerChain: 8
    maxDeliveryAttempts: 3
```

默认每条回复链 8 次、每会话每个 UTC 日 12 次、单消息 1 次；都可通过上述已有参数覆盖，显式配置优先。参数在插件加载时读取，修改后重新加载插件生效。首任务继续计入链与每日额度，双方合计，链的历史已用次数不会按天清零。

链额度耗尽的普通待投递消息旁可点击「增加唤醒额度」，主动打开弹窗，选择追加 4 次、8 次或自定义 1–100 次。窗口显示当前已用/总额、追加后上限、接收方每日额度及其他已知限制，点击「追加并继续」才写入并尝试投递所选消息；取消不写入、不唤醒。不会自动弹窗。

追加仅属于该消息的回复链，跨组及双方共享，历史已用不清零；收据持久保存，重试不重复加额。并发操作发现旧额度已变时展示新额度，需再次确认。每日/单消息额度、双向授权、`wake:false`、归档和 legacy 隔离仍有效。新增额度不能让终态消息重发或恢复断链；合法唤醒仍可能按原 FIFO 顺带交付队列中其他消息。界面分别报告额度是否增加、消息是否持久接收或仍排队，不声称任务已执行完成。只有人类 UI 可追加，模型五工具不变。

降级到不识别追加收据的旧版本可能丢失新增额度和去重事实；本轮不提供降级迁移保证。设计和验收边界见 [追加额度开发计划](docs/plans/chain-wake-budget.md)。

非默认自定义 preset 可显式列出；工具与命令两行需同时调整：

```yaml
- id: tool-gc-duolink
  config:
    presets: [standard, ptc, cordis, coding, my-custom-preset]
- id: command-gc-duolink
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

`pnpm test` 包括客户端、初始模型单位测试、原生 proof、构建目录链接安装验收与构建契约，运行前先 build；默认验证不生成安装包。当前检查包括客户端 109 项、初始模型 56 项、构建契约 3 项，以及辅助 Host 回归 260 项。链接安装后的模型 proof 使用 46 次 mock 请求，无付费调用。浏览器 smoke 和准确验证边界见 [VERIFICATION.md](VERIFICATION.md)。

```sh
BROWSER_EXECUTABLE_PATH='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' pnpm test:workspace-installed
# 完整既有邮箱 UI 场景（本轮未重复运行）
BROWSER_EXECUTABLE_PATH='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' pnpm test:integration
```

这些安装验证使用一次性 home/profile，不修改用户运行实例。说明见 [tests/integration/README.md](tests/integration/README.md)。`DSH_SOURCE_ROOT=/absolute/path/deepseek-harness pnpm test:host` 运行六组辅助宿主回归（含 M1 独立审查回归）；含真实 Workspace 服务的归类回归；source declarations 可辅助开发，不能替代官方 SDK 构建和 构建目录链接安装验证。

## 隔离与限制

旧插件的配置行、RPC、命令、工具名、消息来源和存储路径均无兼容别名。五个工具统一使用 `gc_duolink_` 前缀。DuoLink 自身重启后继续读取自己的消息、创建事实和唤醒额度，这与兼容旧插件是两回事。危险实验任务报告的防执行检查仍保留，但不构成导入入口。初始模型选择仍由原生机制接管。

客户端运行时只加载冻结模块表中的 React、JSX runtime 和 ReactDOM；控件、样式、协议校验、状态与翻译在包内。Remote 由公开服务发现，不生成 `./typert` / `./remote` 或改宿主 allowlist。轨迹尾卡依赖可选 `uiConversation`，缺席时其它 UI 仍可用。

用户停止会清空 Agent inbox，因此已送达不等于模型已读；以对方回复为准。邮箱与台账不自动清理，长期大量使用需关注规模。卸载等待在途操作没有超时。Desktop Electron 本轮未测试；未来宿主版本需重新验证。

用户已反馈 0.5.0 初步测试通过；未提供具体环境及覆盖范围，不能据此扩大 Electron 或付费模型的验证结论。

旧模型路由计划、审查和路线图保留为历史证据，并明确标为已废弃。0.5.0 用前向源码修改取代实验版本，保留 Git 历史；DSH 仓库中的旧扩展不属于当前依赖，也不随本插件提交回退。详见 [架构与历史处理决定](docs/decisions/001-plugin-only-initial-model.md)。
