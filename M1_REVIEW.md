# M1 审查记录

**当前结论（2026-10-14）：M1-A / M1-B 最终复审通过（Approved）。** F1–F10、R2-01–R2-07、R3-01 均已关闭，最新独立验证见文末「最终复审」。这是未提交工作区的 M1 技术验收，不代表已经提交、发布或启动 M2；后续动作仍待确认。以下保留各轮发现与失败证据，历史 Request changes 不再是当前结论。

## 首轮审查：需要修改（历史记录）

日期：2026-10-13。审查对象：0.5.0 基线 `dd67a2c` 上的未提交 M1-A/M1-B 工作区。结论：**Request changes**。

本轮直接审查 diff 与源码、对照[有效规划](<ITERATION_ROADMAP_0_5_BASELINE.md>)，并新增独立回归用例运行验证。未修改产品实现，未提交、安装或发布。以下行号是本轮审查时的位置，修复后可能变化。

## 已复现的问题

### F1 · P1：错误文本并未脱敏，原始凭据可以进入 UI 响应

位置：[sanitizeError](<src/link.ts#L227-L230>)、[投影字段](<src/link.ts#L585-L599>)。

`sanitizeError` 只压平控制字符并截断到 200 字符。`Authorization: Bearer ...` 和 URL 的 `api_key=...` 值会原样进入 `lastError`。HTML 转义只能防止 markup 执行，不能去除敏感内容。这与规划“脱敏、不返回敏感错误”及实施回报的脱敏声明不一致。

证据：[独立后端回归](<tests/review-m1-backend.spec.ts#L63-L69>) 使用明确的虚构凭据字符串，断言失败；没有读取、使用或记录真实凭据。

修复边界：优先输出允许公开的错误分类/安全摘要；若保留自由文本，先脱敏，再截断，覆盖 Authorization、Bearer、常见 token/key/password 参数和 URL userinfo 等，不用“截断就是消毒”的命名。不得修改持久化原始错误来通过 UI 测试。

### F2 · P2：无关会话被错误判为仍欠首任务唤醒

位置：[摘要遍历](<src/link.ts#L617-L620>)，根因是调用 `firstWakeOwed` 前未限制组成员。

创建 Alice→Bob 的 session-granted 组后，查询并非成员的 Eve，`firstTaskWakeOwed` 也返回 true。旧 helper 依赖调用方已经校验组成员；新投影遍历全部组破坏了该前置条件。

证据：[回归](<tests/review-m1-backend.spec.ts#L46-L51>)，expected false / received true。

修复：投影先按被管理会话的 membership 过滤，再调用原 helper；补多个无关组、空邮箱和不存在 owner 的测试。不要改变实际 spawn 首任务语义。

### F3 · P2：显示队列与真实投递队列排序不一致

位置：[compareEnqueue](<src/link.ts#L176-L195>)、[activity 排序](<src/link.ts#L575-L582>)。

新 comparator 将全部无 seq 旧记录强制置于新记录之前，但既有 `pendingFor` 遇到混合记录时按 createdAt 比较。已复现：旧记录 1 月 2 日，新 seq=1 记录 1 月 1 日，实际队列为 new→old，面板为 old→new。原新增测试还把这一差异固定为期望值，不能证明“显示与投递同序”。

证据：[回归](<tests/review-m1-backend.spec.ts#L53-L61>) 直接将 activity 与实际 `pendingFor` 对照，失败。

修复：遵照规划的混合记录兼容方案，pending 按实际投递序分页；若既有混合比较无法作为稳定 keyset 游标，应采用有界快照/失效游标策略。跨目标没有全局执行顺序，不伪称全局顺序是实际执行次序。**不能为了 UI 修改原投递 FIFO**。recent 可采用另行明示的稳定入队排序。

### F4 · P2：运行中目标被错误标为“未授权唤醒”阻塞

位置：[blockingReasons](<src/link.ts#L1250-L1276>)；对照[实际投递分支](<src/link.ts#L1163-L1168>)。

投递逻辑在目标 running 时直接交付 follow-up，不要求自动唤醒授权/预算。新投影却不判断 running 或已持有状态，仍将这些空闲唤醒约束列为当前阻塞原因。刚入队、并发运行或持久确认失败时，UI 会引导用户去更改本来不需要的权限。

证据：[回归](<tests/review-m1-backend.spec.ts#L80-L94>) 模拟当前 running 事实后仍收到 wake-unauthorized。

修复：区分“当前投递阻塞”与“若将来空闲时申请自动唤醒的限制”；已持有待确认不混入新的唤醒条件。没有明确原因则 unknown。冷驻留状态也不直接等于运行阻塞；不要把“目标未驻留”文案写成“对方未在运行”。对入站记录说“接收方/目标”，不能用“对方”误指发送者。

### F5 · P2：预览按固定两次换行剥框架，会吞错或保留错误内容

位置：[previewText](<src/link.ts#L216-L224>)。

当前 frame 允许标题含换行。用真实 `frameSessionLinkText` 生成合法消息后，预览保留了整段 messageId/工具调用指引，而不是用户正文。对于无法识别的旧文本，当前 startsWith 判断也可能错误删除正文。

证据：[回归](<tests/review-m1-backend.spec.ts#L71-L78>)：期望 actual body，实际以“消息 ID…”开头。

修复：利用 record.senderTitle/senderId/messageId 校验完整已知框架后精确移除；未知旧形状保守保留/中性摘要，不按固定行数猜测。补标题换行、正文类似框架、旧框架测试。

### F6 · P2：加载更多失败被静默隐藏

位置：[分页 catch](<src/client/components.tsx#L225-L230>)、[错误渲染条件](<src/client/components.tsx#L288-L291>)。

cursor 请求失败时保留 previous.status='ready'，仅写 error；UI 只在 status='error' 时渲染告警。因此点击“加载更多”失败后无错误反馈，用户无法区分到底有无更多记录。

证据：[客户端回归](<tests/client-mail-review.spec.tsx#L24-L32>)，已有消息仍在，但找不到任何 alert。

修复：独立呈现分页错误并提供同页重试，保留已有条目；成功重试清除错误，避免重复 append。

### F7 · P2：刷新失败清空已有数据，而非保留最后快照

位置：[reload/catch](<src/client/components.tsx#L225-L237>)。

reload 一开始清空 view/entries，失败后只剩错误提示。用户失去最后已知消息与采样时间，违背已有查询模式及“陈旧数据应明确标记”的设计。

证据：[客户端回归](<tests/client-mail-review.spec.tsx#L34-L42>)，告警存在但之前的 Last known message 消失。

修复：同 owner/section 的刷新保留最后快照并标记 stale；owner/section 改变则立即隔离旧数据，不把另一会话内容暂时当作当前内容。补迟到响应、卸载、切换、刷新/加载更多竞争测试。

## 代码对照确认的实施缺口

### F8 · P2：邮箱读取未接入刷新生命周期，写后/重连保持旧结果

位置：[useMail](<src/client/components.tsx#L211-L248>)、[loadActivity 与 mutate](<src/client/index.tsx#L59-L76>)。

当前邮件只在 owner/section 改变或手动点击时读取。mutate 成功仅刷新关系 source，连接 reset 也只有原 source 订阅；邮件没有 AbortSignal、订阅刷新或写后失效入口。用户在同一面板解除互联后，关系已经消失，邮件仍可长期显示 pending；改唤醒授权后旧阻塞原因也持续保留。

“不要每张卡各自轮询”不等于“面板完全取消轮询与重连/写后刷新”。修复应采用按 owner 共享且仅有订阅时活跃的查询源，或同等精简实现；保持既有轮询间隔、写后/重连刷新、取消过时请求与卸载清理。不需为每条卡片启动轮询。按单个页/列表的混合采样定义采样时间，不能用最新后页时间给旧页整体背书。

### F9 · P2：计划中的入口及诊断展示尚未完成

- [头栏](<src/client/components.tsx#L379-L387>)实际只有 MailGlance 计数和新增会话搜索，没有“已互联对象快览”；已经互联的对象会被候选搜索排除，用户仍不能直接从头栏打开它。
- [面板标题](<src/client/components.tsx#L404-L406>)没有“打开被管理会话”入口，管理非当前会话时尤为明显。
- firstTaskWakeOwed 返回但未消费，没有首任务例外提示。目标信息也未直接用于邮件条目，来自全局关系目录的状态与详细查询为独立快照，应保持语义明确。
- 入队时间只显示一个裸日期，应明确标为入队时间；legacy 文案只写“未显示”，没有说明本版不投递、需人工检查。

这些属于已经选定的 M1 范围，不要求图形化或增加新控制。如果主动延后某项，应逐项提出并取得范围调整，不写“全部条目逐项满足”。

### F10 · 验证门槛：packed 官方 RPC / Web smoke 尚缺本期证据

实施方明确记录 Web smoke NOT_RUN，这是诚实边界，但不满足本轮 UI 的完整验收。host source 环境的 Remote 测试与旧的 packed 初始模型 proof，并不证明新 activityView RPC 在官方安装实例和客户端实际串通。

修复后补：官方 packed activityView 请求/响应、管理非当前会话、头栏对端入口、切换/断连/写后刷新、分页错误、窄栏/长正文/明暗主题与实际截图核对。沿用隔离 profile 和 mock，不能触碰用户现用实例。不要求新增 Electron 或付费模型验证。

## 本轮验证结果

```sh
env -u DSH_SOURCE_ROOT pnpm run test:client
# exit 1: 原有 64 项通过，新增独立回归 2 项失败（66 总计）

DSH_SOURCE_ROOT=/Users/gc/Dev/Opensource/deepseek-harness \
  pnpm exec vitest run tests/remote.spec.ts tests/review-m1-backend.spec.ts
# exit 1: 原 Remote 28 项通过，新增独立回归 5 项失败（33 总计）
```

这里的失败是针对真实缺陷增加的期望行为断言，不是安装失败/环境不可用。审查者未复跑完整 build/native/packed/browser，不扩大实施方已有验证声明。

新增用例：[后端五项](<tests/review-m1-backend.spec.ts>)、[客户端两项](<tests/client-mail-review.spec.tsx>)。保留给实施方修复后转绿；不得删除、skip 或改成当前错误输出来制造通过。后端文件不在当前 test:host 四文件列表内，需纳入门禁或将用例整合进已有 Remote 测试，防止遗失。

## 正向结论与下一步

本轮未见恢复任务引擎、增加第二模型 owner、修改持久化 schema 或更改 send/spawn 参数；初始模型标签和“创建时投递状态”方向正确。只读视图主体也没有显式唤醒/flush/写存储操作，legacy 标记仍被排除。

但上述问题直接影响“前端透明且事实准确”的核心目标。请实施会话仅处理 M1 修复与验收；修复完成后发送逐项关闭证据供复审，继续暂停 M2，不提交或发布。

---

## 第二轮复审（2026-10-14）：原回归通过，但仍需修改

### 已确认的进展与本轮证据

- 独立复跑实施方提交复审时的门禁：客户端 **72/72**、辅助宿主 **140/140** 通过，首轮七个审查回归未被删除且全部转绿。
- 已核对新增 packed smoke 脚本、[结果 JSON](<output/playwright/installed-smoke-result.json>)、[窄栏截图](<output/playwright/session-link-narrow.png>)及[暗色截图](<output/playwright/session-link-dark.png>)。新 RPC/分页/错误保留/入口等已有真实浏览器产物，不再将 F10 记为完全未测。本轮审查者未亲自重跑浏览器、build 或 native/packed 初始模型 proof。
- F2/F4/F5/F6/F7 的原复现问题已修；F9 入口与诊断已补。F1/F3/F8 在更完整场景下仍存在问题。
- 新增五项生命周期复现到[第二轮客户端回归](<tests/client-mail-rereview.spec.tsx>)，并在[后端回归](<tests/review-m1-backend.spec.ts#L96-L117>)追加三项；原断言保持不变。本轮新增 8 项全部失败，均为行为断言失败，不是环境故障。

### R2-01 · P1 / F1 尚未闭环：普通键值与 JSON 凭据仍原样显示

位置：[redactSecrets](<src/link.ts#L255-L266>)。当前只覆盖 Authorization/Bearer、带 `?`/`&` 的 URL 参数及 userinfo；`password=...`、`{"api_key":"..."}` 不匹配，会原样显示在 lastError。两项仅使用虚构凭据的回归已失败。

请不要仅为这两条样例再补两个孤立 regex。采用先前报告建议的**允许公开的错误分类/保守摘要**最稳妥；如果坚持展示原始片段，必须系统处理普通键值、JSON/header、引号/大小写/空白等形态，再截断。未知自由文本不可声称已安全脱敏。原始持久记录仍不修改。

### R2-02 · P2 / F3 尚未闭环：全局排序后取子序列仍不等于实际目标队列

位置：[pending 投影排序](<src/link.ts#L653-L667>)。

把 compareAdmission 原样复用只解决了单目标测试；已知 comparator 非传递，所以 **sort(所有目标) 后过滤 Bob** 与 **先过滤 Bob 再 sort** 仍不等价。

复现插入顺序：`a(Bob,seq1,日期4)`、`b(Bob,seq2,日期2)`、`d(Eve,无seq,日期1)`、`c(Bob,无seq,日期3)`。真实 `pendingFor(Bob)` 得到 a→b→c，activity 的 Bob 子序列为 c→a→b。新增回归直接对照真实 pendingFor，失败。

修复：以每个目标的真实队列为权威（还要考虑同一目标存在其它发送方/不属于 owner 的记录），**先获取实际目标队列顺序，再筛可见 owner/peer**，然后按明确规则分组或稳定交织各目标，不能全局重新应用非传递 comparator。把最终可见有序身份列表作为失效摘要依据即可。继续禁止改动实际 FIFO。

文档措辞也应准确：当前 `sig` 是无密钥内容摘要，不是安全签名；此处不需要密码学签名，不应为修文案新增密钥系统。

### R2-03 · P2 / F8：首次加载中关闭后重开，面板永久停在 loading

位置：[退订逻辑](<src/client/state.ts#L349-L358>)、[首次读取条件](<src/client/components.tsx#L230-L236>)。

退订 abort/epoch 失效后，status='loading'、refreshing=true 仍留在缓存。此时无 pages，重新 subscribe 不排轮询，组件也只在 status='idle' 时 refresh。打开→请求未完成→关闭→重开之后，没有第二次请求，面板持续加载、刷新按钮禁用。

证据：[用例](<tests/client-mail-rereview.spec.tsx#L32-L45>) expected 调用 2 次，actual 1 次。

修复：终止操作时恢复可再次读取的状态，重订阅对被中断的首次读取能够重新开始；保留 epoch 对迟到结果的防护，不允许旧结果覆盖。

### R2-04 · P2 / F8：刷新打断加载更多后，loadingMore 永远为 true

位置：[refresh](<src/client/state.ts#L267-L280>)、[loadMore](<src/client/state.ts#L294-L308>)。

分页请求正在等待时，connection/reset 或写后 invalidation 启动 refresh；supersede 使旧请求失效，但新的 refresh 不清 loadingMore，旧请求也不能再清。之后刷新与加载更多按钮都禁用，轮询成功也不恢复。

证据：[用例](<tests/client-mail-rereview.spec.tsx#L47-L64>) refresh 完成及旧分页结果到达后 loadingMore 仍 true。

修复：操作忙碌标记必须属于当前 epoch/操作，supersede/取消/完成均保持一致；不靠旧操作的 finally 清新状态。覆盖刷新打断分页、退订打断首次读取/刷新/分页、切段打断各类请求。

### R2-05 · P2 / F8：只打开头栏快览时不轮询，缓存计数可以一直过时

位置：[schedule 的 pages 条件](<src/client/state.ts#L236-L239>)、[peek](<src/client/state.ts#L320-L335>)、[MailGlance](<src/client/components.tsx#L182-L199>)。

快览仅 peek，pages 始终为空；schedule 以 pages.length===0 拒绝排定时器。已有 summary 时重新打开快览也不再 peek。因此从未打开完整面板的 owner，计数不随消息或预算变化更新。

证据：[用例](<tests/client-mail-rereview.spec.tsx#L66-L76>) 订阅+peek 后经过一个配置间隔，仍只有一次请求。

修复：摘要订阅也应有受控刷新与过期提示，不必加载全量页面；所有订阅清空时应停止，不为轨迹卡单独创建轮询。

### R2-06 · P2 / F8：无订阅的历史 owner 仍在每次写操作后请求

位置：[invalidate](<src/client/state.ts#L378-L380>)、[全体缓存 invalidation](<src/client/index.tsx#L84-L88>)。

`listeners.size > 0 || state.pages.length > 0` 把“曾访问且缓存了数据”当作“在屏幕上”。任意写操作会请求曾打开的全部 owner，违反只在订阅时活跃的约束，也随历史访问 owner 数量增长。

证据：[用例](<tests/client-mail-rereview.spec.tsx#L78-L88>) 完全退订后 invalidate，loader 从 1 次变 2 次。

修复：未订阅时只标 dirty；下次激活再读。不要删掉缓存保留能力来回避此问题。

### R2-07 · P2 / F8：重开面板，选中 Pending 却展示 Recent 数据

位置：[MailSection 独立 section state](<src/client/components.tsx#L229-L247>)。

controller 跨挂载保留 recent；组件自己的 section 每次挂载重置 pending。用户切 Recent→关闭→重开，就出现选中“待投递”却显示最近历史（可包含 cancelled/revoked/delivered）的语义错误。

证据：[用例](<tests/client-mail-rereview.spec.tsx#L90-L102>) UI='pending'，controller='recent'。

修复：标签与数据使用同一个 section 权威状态；允许一致地保留 Recent 或一致地重置 Pending，但不能分离。无需新增第二缓存或控制器层。

### 本轮复跑结果与交接

```sh
env -u DSH_SOURCE_ROOT pnpm run test:client
# 加新用例前：72/72 PASS，exit 0
# 加新用例后：72 PASS / 5 FAIL，exit 1

DSH_SOURCE_ROOT=/Users/gc/Dev/Opensource/deepseek-harness pnpm test:host
# 加新用例前：140/140 PASS，exit 0
# 加新用例后：140 PASS / 3 FAIL，exit 1
```

结论仍为 **Request changes**。这是原 M1 查询状态/事实准确性的修复闭环，不是增加功能范围。下一轮请集中完成 R2-01～R2-07；生命周期按“订阅与操作状态迁移”整体检查，不继续逐个补 timer 补丁。保留全部回归用例，重跑门禁并更新验证证据后再请求复审；M2、提交和发布继续暂停。

---

## 第三轮复审（2026-10-14）：仅保留错误详情泄漏这一阻断

### 独立验证与关闭项

本轮审查者重新执行并确认：

- `env -u DSH_SOURCE_ROOT pnpm test:client`：**79/79 PASS**，含上一轮五项生命周期回归。
- `DSH_SOURCE_ROOT=/Users/gc/Dev/Opensource/deepseek-harness pnpm test:host`：新增本轮用例前 **143/143 PASS**。
- 官方 peers 下的 `typecheck`、`build`：PASS；`test:contracts`：**3/3 PASS**。
- 重新构建后，使用 Brave、隔离临时 profile 独立执行 `test:integration`：**PASS，0 model calls**。没有替换用户现用 GUI，没有修改现用 profile；产物单独保存在 [第三轮 smoke 结果](<output/playwright-review-r3/installed-smoke-result.json>) 所在目录，不覆盖实施方此前证据。

已核对真实目标队列取序后再筛可见集合、保序交错，以及退订 busy 状态复位、当前操作 busy 标志、peek-only 轮询、无订阅 dirty、唯一 section 状态。**R2-02～R2-07 可以关闭。** 本轮不再要求增加新的 UI 范围，也没有重跑 native/packed 初始模型 proof 或付费模型/Electron。

### R3-01 · P1 / F1、R2-01 仍未闭环：正则脱敏截漏与覆盖倒退

位置：[SECRET_KEYS 与 redactSecrets](<src/link.ts#L255-L284>)；复现：[新增三项后端回归](<tests/review-m1-backend.spec.ts#L119-L128>)。

三项通过真实 `activityView` 返回值验证，只用虚构凭据：

1. `https://example.invalid/?key=SYNTHETIC_REVIEW_R3_SECRET`：原样返回。此前 query-key 列表包含普通 `key`，本次重写 SECRET_KEYS 时丢掉了它，是已有覆盖的倒退。
2. `JSON.stringify({ password: "prefix'SYNTHETIC_REVIEW_R3_SECRET" })`：返回 `{"password":"[redacted]'SYNTHETIC_REVIEW_R3_SECRET"}`。双引号 JSON 值中的合法单引号被误当作结束符，留下敏感后缀。
3. `JSON.stringify({ token: 'prefix"SYNTHETIC_REVIEW_R3_SECRET' })`：转义双引号同样提前结束正则，留下完整虚构敏感后缀。

这不是要求识别任意不可知密文，而是当前注释声称覆盖的普通 URL key、合法 JSON 值。截断、React 转义、注释里声明“未知自由文本不保证安全”都不能消除已经进入响应的凭据片段。

新增用例后重新跑完整 host 门禁：**143 PASS / 3 FAIL（146 总计），exit 1**。原 143 项保持通过。审查者只追加后端测试和本报告，未修改产品实现。

### 最小收尾方案与验收

为避免继续做不完整的敏感词/引号正则解析，**本期改用不含任何原始错误片段的固定安全摘要，或严格白名单错误分类**。保留 `lastError` 的可选短字符串契约；存在历史错误时输出“发生过投递异常，详细诊断未展示”这一类安全信息即可。没有已知稳定错误码就用固定通用摘要，不根据任意自由文本拼接内容。不新增错误分类系统、持久化字段或诊断工具，不改持久化原始记录。

- 保留所有独立审查断言，新增三项转绿；补“任意原始错误不会被拼接进响应”及“原始记录未被改写”的验证。
- [实施方 Remote 测试](<tests/remote.spec.ts#L447-L465>)原先要求 lastError 恰为 200 字符、以 `boom ` 开头，这是原文截断实现的期望，不是产品安全要求；允许改为验证安全摘要的内容与长度上限。不是去掉泄漏断言来制造通过。
- 更新 [验证记录](<VERIFICATION.md>) 的错误输出契约；同时校正[有效规划中 M1-B 的旧浏览器 NOT_RUN 状态](<ITERATION_ROADMAP_0_5_BASELINE.md#L77-L79>)，保留历史轮次证据。
- 重跑相关门禁后再请求最终复审。**当前 Request changes 仅针对该安全阻断；M2、提交和发布仍暂停。**

---

## 最终复审（2026-10-14）：Approved

### 最后一项安全问题已关闭

已读取并核对 [errorSummary 实现](<src/link.ts#L255-L276>)及[响应投影](<src/link.ts#L710-L727>)：

- 正则改写层已删除；记录有 error 时，`lastError` 只取固定常量 `delivery error (details withheld)`，不拼接原始错误内容。
- 没有 error 时省略 `lastError`，可选短字符串契约不变。
- 投影仅构造返回值，不改写持久化 error/text；没有新增 schema、模型工具、任务系统或错误分类系统。
- [独立安全回归](<tests/review-m1-backend.spec.ts#L109-L128>)保留原断言并全部通过。[Remote 契约测试](<tests/remote.spec.ts#L447-L496>)验证固定摘要、七种错误形状、原始错误保留及正文不改写。

据此关闭 **F1 / R2-01 / R3-01**。此前已关闭的查询排序、生命周期、入口和验证缺口维持关闭，**M1-A 与 M1-B 技术验收通过**。

### 审查者本轮独立执行的门禁

| 检查 | 结果 |
|---|---|
| `env -u DSH_SOURCE_ROOT pnpm test:client` | 79/79 PASS，包含全部客户端审查回归 |
| `DSH_SOURCE_ROOT=/Users/gc/Dev/Opensource/deepseek-harness pnpm test:host` | 153/153 PASS，包含独立后端审查 11 项 |
| 官方 peers `typecheck` / `build` | PASS；未使用源码 checkout 作为发行构建依赖 |
| `test:contracts` | 3/3 PASS |
| 最终重新构建产物的 packed Brave smoke | PASS；隔离临时 profile，0 次模型调用 |

上述命令链退出码 **0**。独立浏览器产物见[最终 smoke 结果](<output/playwright-review-final/installed-smoke-result.json>)。没有替换现用 GUI、安装到用户现用 profile，或执行付费模型请求。本轮未重复 native/packed 初始模型 proof，实施方记录与审查者独立证据分开保留。

### 验收边界与后续

本结论只覆盖 0.5.0 基线上的 M1 未提交工作区，不代表已发布新版本；Desktop Electron、真实付费模型、旧实验 profile 迁移仍不是本次验证范围。

审查者只更新验收文档和规划状态，未提交或发布，也未启动 M2。建议下一步先独立提交 M1，再按原规划进入 M2-A（普通待投递消息取消入口）；实施会话保持待命，等待后续确认。
