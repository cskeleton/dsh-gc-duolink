# dsh-session-link

会话互联的独立 DeepSeek Harness 插件，支持 Desktop 和 Web。服务、四个模型工具、`/session-link` 命令和 UI 在同一个包里，通过 profile 安装，不需要修改 DSH 源码。

## 使用

打开普通会话，点击头栏的互联按钮，在右侧「会话互联」面板选择已有会话并添加。面板支持打开对方会话、切换对方的自动唤醒，以及解除互联；头栏弹层和会话列表标记使用同一份宿主查询。

建链时宿主同时校验发起方和对方：两者都必须存在、是普通顶层会话且未归档。同一对会话已在某个组中时，建链在串行队列内原子拒绝，并发请求只会成功一个。切换自动唤醒同样在串行队列内完成读取、修改和写入，不同窗口同时修改不同成员的开关不会互相覆盖。UI 在一次写入完成前忽略后续点击，头栏、面板和卡片共用一个写入闸门。

每个组内的普通顶层会话可以互发消息。消息携带独立的非人类来源，接收方获得消息文本，不共享模型历史或权限。运行中的接收方通过 follow-up 接收；空闲接收方没有自动唤醒授权时，消息留在持久邮箱，等它下一轮工作。自动唤醒受每天、每条消息和回复链预算限制。

投递遵循一套规则，发送工具、spawn、重试、取消、恢复和卸载都按它执行：

- 发送报错，表示这条消息永远不会投递：要么没有保存，要么在送入对方之前被取消。消息一旦保存，之后的投递失败只返回 `queued`，不会报错，重试会继续投递同一条。
- `accepted` 只在消息已插入对方会话、且对方会话 flush 成功之后报告；仅在内存中出现不算。flush 失败时消息保持待投递并记录错误，不会变成终态，恢复后只确认一次。消息交给对方之前先持久标记为已插入；带此标记的消息即使对方会话已冷却也不会被取消、撤销或判失败，等对方会话恢复后从其日志确认，若日志里没有（例如 flush 前崩溃）则重新投递。
- 同一目标的邮箱按入队顺序投递：每条消息带单调递增的入队序号（0.4.0 之前入队的消息按时间排序），不受时钟回拨和重启后加载顺序影响。新消息可以触发唤醒，但更早排队的消息先插入。
- 发送的取消信号在消息插入对方之前随时有效（包括保存消息和恢复冷会话期间），会把消息持久标记为 `cancelled`；插入之后取消不再生效。领取唤醒后才收到的取消会退还当日唤醒额度。
- 不能给自己发送 peer 消息。`in_reply_to` 只能指向本会话已收到（已送达）的消息。回复链的唤醒预算按链根统计，链换到另一个互联组后仍累计。
- 卸载时依次停止接收新操作、等待在途操作完成、再关闭存储域。

模型看到的消息正文带有发送方会话 ID、消息 ID 和回复方法（`session_send_session_message` 的 `session_id` 与 `in_reply_to`），这些框架文字计入 `maxMessageBytes`。

发送的 idempotency key 与消息记录在同一次写入中提交，重试按 key 找回原消息；原消息仍待投递时，重试会再尝试投递这一条，而不是另建一条。0.3.3 之前写在 ledgers 中的 key 仍可读取。`accepted` 表示目标已经持久记录消息；`queued` 表示邮箱已有记录。两者都不表示对方已经处理或完成任务。重试一个已取消、已失败或已撤销消息的 idempotency key 时报 `MESSAGE_UNDELIVERABLE`，不会重新投递，也不会再报告 `queued`。

```text
/session-link list
/session-link add <peer-session-id> [wake]
/session-link wake <peer-session-id> on|off
/session-link revoke <link-id>
```

模型工具为 `session_list_links`、`session_send_session_message`、`session_cancel_session_message` 和 `session_spawn_linked_session`。发送工具的 `in_reply_to` 支持回复。

工具和 `/session-link` 命令按 preset 挂载：只注册到 `presets` 配置所列 preset（默认 `standard`、`ptc`、`cordis`，与原 fork 一致）的顶层会话作用域，不进入全局工具层。`minimal` preset 和子代理看不到它们；会话在开始前切换 preset 时随之挂载或撤下。执行时仍拒绝子代理会话和归档会话。preset 行不是 Loader group，bundle 补丁无法把子行插入其 `config.plugins`，所以插件在每个符合条件的 Agent 的 `agent.ctx` 下挂一个子插件来完成注册。没有 `agentPresets` 服务的组合（如 headless）中，所有顶层会话都会获得它们。

`session_spawn_linked_session` 先创建会话并立即建链，再设置标题、投递初始任务。spawn 建的组欠新会话一次唤醒：发给它的首条消息会唤醒它（仍受每日唤醒预算约束，预算用尽时为 `queued`，这次唤醒继续保留给下一条消息）；一旦有消息送达或用掉过唤醒，这笔欠账结清。这一状态从邮箱记录推导，不新增存储字段。`auto_awake` 只决定之后的消息能否唤醒它。改名失败只记日志，会话仍保持互联并收到任务；任务已保存但暂时没能投递时，工具返回 `queued`，不报错，用同一调用重放会继续投递。只有任务没保存或在送达前被取消时工具才报错，并给出已互联的会话 ID，此时用 `session_send_session_message` 重发不会产生重复任务，且仍会唤醒新会话。同一 tool call 重放时，工具先查这次调用的记录，再决定是否创建或建链：任务已保存过（包括 0.3.0、0.3.1 留下的记录）就复用原会话、原组和原消息，不再创建会话或建链，并对仍在等待的这条任务再尝试投递一次；已送达、已取消、已失败或已撤销的任务不会重新执行；已建组但任务未投递就复用原会话和原组补投任务；原组已被人工解除时报错，既不重新建链也不重发任务。存储域每次只原子写一条记录，没有跨表事务，所以调用记录先于互联组提交（标记为意图），解除互联时先在调用记录上标记已解除、再删除组。任何一步写入失败留下的状态只会被读成“尚未建组”（重放时按记录的组 ID 补建）或“已解除”（不再重建），不会出现“有组、无记录”。调用记录保存在 `session_link` 域 ledgers 行的 `spawns` 字段中（旧行读作空，域版本仍为 1）。首次创建时会话 ID 由调用会话和 call ID 推导，崩溃后重放会认领同一个会话。会话控制器没有删除接口，建链本身失败时错误信息给出空会话 ID，交给人工处理。插件本身没有额外人工审批流程，调用仍受 profile 已配置的工具策略约束。UI 与命令添加的组记为 human grant；spawn 组记为调用会话的 session grant。

## 安装

先构建，再安装目录或交付的 `.tgz`。本项目使用运行时 peerDependencies，从安装目标的 DSH profile 解析宿主包；禁用自动安装 peers 可避免再拉入另一套 DSH。

```sh
pnpm install --frozen-lockfile
pnpm build
```

Web 或其它普通 profile 用 npm 安装的 `dsh`：

```sh
dsh plugin --profile web add --ignore-scripts --config.auto-install-peers=false /absolute/path/dsh-session-link-0.4.1.tgz
```

Desktop profile 归 Electron 应用独占管理，npm 安装的 `dsh` 会以 `profile "desktop" is managed exclusively by the Electron application` 拒绝。改用 Desktop 自带的命令：先至少打开过一次 Desktop 以初始化 profile，再**完全退出** Desktop，然后执行：

```sh
DESKTOP_DSH='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
"$DESKTOP_DSH" plugin --profile desktop add --ignore-scripts --config.auto-install-peers=false /absolute/path/dsh-session-link-0.4.1.tgz
```

重新打开 Desktop 后生效。Desktop 菜单 **Manage dsh Command…** 可把这个命令注册到 PATH。该命令拒绝未初始化的 Desktop profile，Desktop 运行时不要执行包操作。应用内的 Plugins 页面使用同一插件管理器，可用于查看和启停已安装插件。

最后一个参数也可以换为构建好的目录 `link:/absolute/path/dsh-session-link`。当前正在运行的 Desktop 和原 checkout 不会因为构建本目录而切换版本。

原 fork 已经内置同名服务，切换时必须让外置插件成为唯一实现：关闭旧 `@deepseek-ai/dsh-session-link`、旧 UI、以及各 preset 里的旧工具和命令行，再启用本包。原 fork 与本包同时启用会导致同名服务或工具冲突。建议先在官方 Desktop profile 安装；不要回退 Git 历史或清空原工作区来完成切换。

卸载：Web 用 `dsh plugin --profile web remove dsh-session-link`；Desktop 在退出应用后用上面的 `"$DESKTOP_DSH" plugin --profile desktop remove dsh-session-link`。卸载保留已记录会话消息与 `session_link` 存储域；UI 和工具随插件卸载。再次安装同一数据身份的实现可读回原互联组和邮箱。

## 配置

profile 的 `cordis.patch.yml` 可以覆盖宿主行配置。补丁会替换整行 config，需同时写出希望自定义的所有配置项。

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

工具行和命令行各自用 `presets` 选择挂载的 preset：

```yaml
- id: tool-session-link
  config:
    presets: [standard, ptc, cordis]
- id: command-session-link
  config:
    presets: [standard, ptc, cordis]
```

`uiPollIntervalMs` 范围为 1000 到 2147483647。UI 在有订阅时轮询，写入确认与连接重置后立即刷新；其它窗口或命令的修改最迟在下一次轮询出现。查询失败保留最后读到的列表并显示重试入口。

## 开发与验证

默认编译使用 npm 上的 `0.2.0-rc.2` 开发 SDK，不需要 checkout。Zod 固定为 `4.4.3`，避免与构建期 SDK 的 schema 类型产生递归比较和内存耗尽。

```sh
pnpm typecheck
pnpm build
pnpm test
```

`pnpm test` 运行客户端行为与生命周期测试，以及构建产物的 RPC 参数名、exports、peers、浏览器依赖检查；需要先 build。宿主完整回归使用 DSH 自己的未发布测试支持包，因此单独指定 source checkout：

```sh
DSH_SOURCE_ROOT=/absolute/path/deepseek-harness pnpm test:host
```

可用 `DSH_SOURCE_ROOT=/absolute/path/deepseek-harness pnpm build` 选择该 checkout 已构建的 declarations；这些路径仅供编译，不会进入运行时配置。不要软链整棵 checkout node_modules 来运行安装验证。

正式安装与浏览器 smoke 走一次性 home 和 profile，不修改用户现用 profile，不调用模型：

```sh
BROWSER_EXECUTABLE_PATH='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' pnpm test:integration
```

测试说明与产物见 [tests/integration/README.md](tests/integration/README.md)；运行结果见 [VERIFICATION.md](VERIFICATION.md)。

## 已知限制

- 用户在对方会话按下停止时，Agent 会清空 inbox。此前已插入并确认的 peer 消息仍记为已送达，但模型可能没有看到；发送方需要以对方回复为准。
- 卸载会等待在途邮箱操作结束；如果该操作正在等待一个也在关闭的宿主服务（如恢复冷会话或 flush），卸载会一直等它，没有超时。
- 工具和命令是否挂载，在 Agent 创建和切换 preset 时判断；顶层会话之后若被子代理路由接管，工具仍在其工具表中，但执行时会被拒绝。
- 邮箱消息与台账不会自动清理，送达确认和预算统计按消息全量扫描；长期大量使用需要关注其规模。

## 兼容性

保留原 `session_link` 域名、version 1、三张表及 `session-link-message` 来源字段，没有新增 Session 事件，也不要求会话日志迁移。恢复不会自动唤醒会话或消耗模型调用。

宿主只导入声明过的 DSH peers。客户端产物只从浏览器冻结模块表加载 React、React JSX runtime 和 ReactDOM；控件、样式、协议校验、查询状态与翻译均在本包内。DSH 客户端包仅作开发类型依赖。Remote 通过活跃服务的 `@Remote` 标记发现，无生成 `./typert` 或 `./remote`，无 `api/remotes` 修改；`request` 参数名保留，不压缩宿主方法。

仍依赖 DSH 的服务名、插槽 props、四类 UI 插槽与 ModuleLoader/RPC 约定，以及 `agentPresets.composedPreset()`、`agent-preset/selected` 事件和 Agent 作用域注册。未来版本需要重新运行安装 smoke；当前兼容证据不能保证任意未来版本兼容。轨迹尾卡依赖可选 `uiConversation` 服务，缺席时其它 UI 仍可用。

本版抽取自本地 `656ca65` 及其当前 UI/Remote 原型，修正顶层调用者验证、恢复唤醒、持久收据确认、卸载等待和消息字节限额。0.3.0 起工具和命令按 preset 挂载，spawn 的初始任务会唤醒新会话，建链校验发起方并原子拒绝重复组，删除未使用的 `listFor`、`catalog` 接口和 `selectionFor`。原探针源码备份在 `artifacts/probe-original/`。0.3.1 修正首任务重发唤醒、自动唤醒并发更新，并改写 Desktop 安装说明。0.3.2 把 spawn 重放的判断移到创建和建链之前，复用原调用记录，不再恢复已解除的组；降级到更早版本时 `spawns` 记录会在下次写 ledgers 时丢失。0.4.0 统一投递规则（报错即永不投递、flush 成功才确认、按目标整队按序投递、取消贯穿到插入前、重放走同一恢复路径），模型可见的消息框架带消息 ID 与回复方法，拒绝向自身发送，卸载按序关闭，并修正冷会话已持有消息、同毫秒排序、跨组回复链预算、取消后的唤醒退还和 `in_reply_to` 校验；消息记录新增可选字段 `seq`、`inserted`，旧记录照常读取。0.4.1 在交付前标记写入完成后再次检查取消，并在标记写入或取消失败路径中撤销未交付标记、消息唤醒次数和当天额度，使原消息仍可重试。0.3.3 去掉 spawn 与幂等的跨表写入依赖：调用记录先于组提交，解除先标记后删除，idempotency key 随消息一起写入；降级后，0.3.3 写入的 key 不会被旧版本识别。本次没有提交、push、回退原提交、清理原工作区或切换现用 Desktop profile。
