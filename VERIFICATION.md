# Verification — 0.6.1-beta prerelease preparation

日期：2026-10-18。用户明确授权 commit、push 和 GitHub beta release，版本使用标准 SemVer `0.6.1-beta`，tag 为 `v0.6.1-beta`；发布为 Pre-release，不替换稳定版。中英文 README 增加预发布包入口和旧插件独立安装说明。

| 发布前检查 | 结果 |
|---|---|
| 类型和构建 | PASS；`pnpm typecheck`、`pnpm build`，版本 0.6.1-beta |
| 默认测试 | PASS；`pnpm test`：客户端 109/109、初始模型单位测试 56/56、构建契约 3/3；原生 proof 19 次 mock，链接安装 proof 46 次 mock，均 0 付费调用 |
| 打包保护 | PASS；`pnpm test:pack-release`，1/1；相同字节可重试，禁止不同内容覆盖同版本包 |
| 完整浏览器回归 | PASS；已安装 Desktop 0.2.1-rc.2 的运行时 + 隔离 Web profile + Brave；本轮未使用 `SMOKE_UI_ONLY`，完整邮箱、取消、唤醒额度追加、刷新/重载、撤销、旧命名空间隔离及卸载历史场景通过；[JSON](output/playwright-beta-release/installed-smoke-result.json) |
| 最新 UI | PASS；中英文即时切换、3/8 候选与完整搜索、紧凑折叠卡片、标题栏解除、单行打开按钮、原生菜单字体与间距、仅保留 1 个原生复制入口、仅已互联会话显示侧栏链条 |

发布包通过 `pnpm pack:release` 生成到 `output/0.6.1-beta/`，打包器逐文件核对工作区字节与导出入口；GitHub 随包提供 SHA256SUMS 和含源码提交信息的 delivery-manifest.json。此前 0.6.1 本机测试包继续保留，不覆盖。自动化只操作一次性 profile；未修改或重启用户实际 Desktop，未进行真实远端模型调用。实际 Electron 前台窗口的自动交互不在本轮范围。

以下为历史验证记录；其中「未提交/未发布」「不打包」「完整邮箱 NOT_RUN」等陈述仅描述各自轮次。

---

# Verification — linked-only sidebar action (working tree)

日期：2026-10-18。会话列表外侧链条按钮仅在该会话至少有一个互联对象时显示，解除最后一组后隐藏；互联菜单入口始终保留，唤醒开关不影响可见性。移除不再使用的「未互联」按钮文案，中英文 README 同步说明。

- PASS：`pnpm test:client`，109/109，10 files；新增未互联隐藏→建链出现（双向唤醒均关闭）→解除隐藏、菜单保留的订阅更新检查，既有唤醒关闭不隐藏检查保留。
- PASS：`pnpm typecheck`、`pnpm build`、`pnpm test:contracts`，契约 3/3。
- PASS：已安装 Desktop 的 0.2.1-rc.2 运行时 + 一次性 Web profile + Brave，实际验证未建链无外侧按钮、菜单可进入、建链后可管理、解除后隐藏且菜单保留；[JSON](output/playwright-linked-row/installed-smoke-result.json)、[未互联截图](output/playwright-linked-row/ui-row-unlinked.png)。此运行时版本取自实际命令输出。
- 0 模型调用；`SMOKE_UI_ONLY=1`，完整邮箱场景 NOT_RUN。其余紧凑 UI、语言、原生菜单样式、无重复复制、无效配置及卸载后历史检查通过。
- 版本仍为 0.6.1，未打包、安装、commit/push 或修改用户 profile；17 个既有安装包保持不变。实际 Desktop 窗口未操作。

以下为历史验证记录。

---

# Verification — native Session menu and copy removal (working tree)

日期：2026-10-18。当前 Desktop 0.2.1-rc.1 已内置「复制 Session ID」。本轮从 DuoLink 删除重复菜单注册、复制组件、Clipboard/textarea fallback、专用文案及 6 个专用测试；独立复制插件源码不变。「会话互联…」改用宿主提供的 `MenuItemButton`，删除自定义菜单按钮 CSS。浏览器构建将该 UI 模块保留为宿主外部模块，不打入另一套组件；运行时契约限定仅请求 React 和这一宿主模块。

| 检查 | 当前结果与证据 |
|---|---|
| 客户端 | PASS；`pnpm test:client`，108/108，10 files；只注册互联菜单、使用宿主组件、点击管理与关闭行为通过 |
| 类型、构建与契约 | PASS；`pnpm typecheck`、`pnpm build`、`pnpm test:contracts`，契约 3/3；产物不包含复制入口/文案标记，Host UI 外部模块保留 |
| 当前 Desktop 运行时的隔离 Web proof | PASS；使用已安装应用的 CLI/asar（0.2.1-rc.1）和 Electron 的 Node 模式加载依赖，启动一次性 Web profile + Brave；中英文菜单均与原生行样式相同，字体 13px、行高 20px、上下 padding 各 6px、min-height 34px；仅剩 1 个原生复制入口；[JSON](output/playwright-native-menu/installed-smoke-result.json) |
| UI 回归 | PASS；3/8 候选与完整搜索、语言即时切换、单行打开按钮、紧凑卡片折叠、标题去重、插件无效配置/卸载后核心和历史可用；0 模型调用 |
| 截图 | [中文菜单](output/playwright-native-menu/ui-menu-zh.png)、[英文菜单](output/playwright-native-menu/ui-menu-en.png)，均已人工查看 |
| 边界 | 最终运行使用 `SMOKE_UI_ONLY=1`，完整邮箱场景 NOT_RUN；没有操作正在运行的 Desktop 窗口或用户 profile；未重启实际应用、未重新安装 |
| 工作区 | 版本仍为 0.6.1，HEAD/master、既有 tgz 文件及 SHA256、独立复制插件文件均保持不变；未打包、commit 或 push；`git diff --check` 通过 |

旧的本机测试包仍保留先前复制实现，不代表当前工作区；需要用户另行要求打包后再交付新测试包。复跑命令见 [integration README](tests/integration/README.md)。以下记录为历史验证范围。

---

# Verification — compact bilingual UI (working tree)

日期：2026-10-18。基于已提交的 `e23989a` 调整 UI；本轮未 commit/push，版本仍为 0.6.1，未生成或覆盖安装包，未修改实际用户 profile 或重启 Desktop。

- 沿用 DSH locale 注册和语言偏好；真实 Host 设置切换中英文后，已打开的面板和快速互联弹窗即时更新，无需刷新。
- 候选列表按 Host 的最近活跃顺序默认显示 3 个，展开最多 8 个；搜索先过滤完整候选集合，再应用显示上限。打开会话按钮不换行。
- 双人组标题直接显示对端名称，正文只保留 ID、状态和操作；可见唤醒文案省略重复名称，无障碍名称仍保留对象。多人组继续显示成员名和逐成员接收控制，避免方向歧义。
- 卡片标题加深、元信息变浅，解除互联移至标题栏并保留确认；折叠仅隐藏正文。删除无关的 `doraemon-bicycle.html`。

| 检查 | 当前结果与证据 |
|---|---|
| 客户端 | PASS；`pnpm test:client`，114/114，11 files；新增 3/8 展开、完整搜索、隐藏选择清理、双人/多人语义、折叠和标题栏解除确认检查 |
| 类型、构建与契约 | PASS；`pnpm typecheck`、`pnpm build`、`pnpm test:contracts`，契约 3/3 |
| 真实浏览器专项 | PASS；官方 DSH 0.2.0-rc.2 + Brave，隔离 profile 链接构建目录；中英文即时切换、3/8 和第 9 个候选搜索、单行打开按钮、折叠与标题去重；0 模型调用；[JSON](output/playwright-ui-compact/installed-smoke-result.json) |
| 截图 | [英文](output/playwright-ui-compact/ui-compact-en.png)、[中文](output/playwright-ui-compact/ui-compact-zh.png)、[窄屏快速互联](output/playwright-ui-compact/ui-quick-zh-narrow.png)、[深色](output/playwright-ui-compact/ui-compact-zh-dark.png)；测试样本卡片展开 188px、折叠 34px |
| 验证边界 | 本次最终浏览器命令使用 `SMOKE_UI_ONLY=1`，完整邮箱场景为 NOT_RUN；仍验证卸载后会话可读、非法插件配置不影响核心功能。Host 源码未改，未重复模型/Host 测试；实际 Desktop 为 NOT_RUN |
| 交付边界 | 版本、HEAD/master、`output/` 下全部 7 个既有 tgz 的清单与 SHA256 未变；未打包、安装或发布；`git diff --check` 通过 |

复跑命令见 [integration README](tests/integration/README.md)。以下保留之前各轮的验证记录，其范围与计数不并入本轮。

---

# Verification — independent DuoLink namespaces (working tree)

日期：2026-10-18。本节取代此前保留旧插件配置、存储路径和协议的决定；下方记录只说明当时的历史验证。`package.json` 版本仍为 0.6.1，本轮未生成或覆盖任何 tgz，也未 commit/push、修改实际用户 profile 或重启 Desktop。

当前配置文件为 `gc-duolink.patch.yml`，配置行 `gc-duolink` / `tool-gc-duolink` / `command-gc-duolink`；服务/RPC 为 `gcDuolink`，存储域为 `gc_duolink`，默认 JSON 文件为 `$DSH_HOME/storages/gc_duolink.json`。命令 `/gc-duolink`，五个工具使用 `gc_duolink_` 前缀，来源标记 `gc-duolink-message`，初始模型元数据 `gc-duolink/initial-model`。客户端 locale、tab、轨迹节点、DOM 与 CSS 标识同步隔离。无旧名别名、旧路径回退或自动迁移；旧目录兼容软链接已移除。

| 检查 | 当前结果与证据 |
|---|---|
| 客户端与 scope | PASS；`pnpm test:client`，111/111，含新 RPC/locale/轨迹工具名/复制功能 |
| 初始模型单位测试 | PASS；两组测试 56/56，使用新的服务与工具名称 |
| Host 源码辅助回归 | PASS；`DSH_SOURCE_ROOT=/Users/gc/Dev/Opensource/deepseek-harness pnpm test:host`，260/260，6 files |
| 旧存储隔离与拒绝误接管 | PASS；Host 测试向旧 `session_link` 域放入不兼容记录/版本，新服务不读写它；复制旧 global 到新域明确拒绝；非空且 global 为 null 的旧格式也拒绝，不写身份标记；新域 marker 显式持久化 |
| 类型、构建与运行时契约 | PASS；`pnpm typecheck`、`pnpm build`、`pnpm test:contracts`，3/3；配置文件/三行 ID、RPC 和 product schema 均核验 |
| 安装目录模型 proof | PASS；`pnpm test:initial-model-installed`，`link:` 到构建目录，46 次 mock、0 付费调用，含新工具/元数据、重启幂等和卸载后原生恢复；[JSON](output/initial-model-installed-result.json) 的 `installationMode` 为 `built directory link` |
| 真实浏览器隔离 | PASS；Brave + 官方 DSH 0.2.0-rc.2，构建目录链接到隔离 profile；旧配置故意填非法值仍不影响新配置、旧 RPC/service/tool/command 无别名、旧文件字节不变、新存储有身份标记；完整邮件/复制/唤醒 UI 通过，0 模型调用；[JSON](output/playwright-isolation/installed-smoke-result.json) |
| 无版本/安装包迭代 | PASS；对照任务开始前快照，版本仍为 0.6.1，全部 tgz 清单和 SHA256 未变，HEAD/master 未变，独立复制插件未改；README 链接、配置文件清单和 `git diff --check` 通过 |

存储身份处理先从浏览器复现出 `global.initial` 不自动写盘，再核对官方已安装 domain 实现，增加显式 `global.set` 和非空未标记存储拒绝检查。旧幂等账本字段/回退读取已删除；危险任务报告的防执行检查保留，它不导入旧插件数据。

默认集成验证不再运行 `npm pack`，默认契约检查不再执行打包测试；显式 `test:pack-release` / `pack:release` 仅在用户要求打包时运行。既有 tgz 仍是此前的历史快照，不代表当前工作区。旧配置、互联关系与唤醒授权不会继承，使用新版本需重新配置与建链。旧用户存储没有删除，实际 Desktop 安装未切换；旧安装源路径的软链接已移除。

默认不打包、不增版本的约定已写入 `AGENTS.md`。详细边界见 [DuoLink 隔离说明](docs/plans/duolink-isolation.md)。

---

# Verification — DuoLink 0.6.1 README and repository update

日期：2026-10-18。经用户明确授权，GitHub 原仓库已更名为 `cskeleton/dsh-gc-duolink`，node ID 仍为 `R_kgDOVD0Qpw`，本地 `origin` 已更新；新地址及旧地址 API 均返回同一仓库，新 origin 的 `git ls-remote ... HEAD` 成功。未 commit、push 或发布本地代码，未修改实际用户 profile。

默认英文 README 为 `README.md`，首行 `[中文](README.zh.md) | English`；中文移至 `README.zh.md`，首行提供英文入口。包的 `files` 清单同步更新；当前本地交付版本 0.6.1。README 相对文件链接、双向语言链接及打包文件存在性校验通过；`pnpm test:contracts` 4/4 与 `git diff --check` 通过。

本次只调整文档、包版本及打包文件清单。`lib/` 全部运行时文件及 `cordis.patch.yml` 与已验证 0.6.0 交付清单的 SHA256 一致，0.6.0 历史 tgz SHA256 保持不变。未重复运行此前通过的客户端、模型和浏览器流程；运行时依据为下列 0.6.0 证据。0.6.1 使用新目录和新文件名交付，避免覆盖旧包。

以下保留 0.6.0 本地实现阶段及更早的验证记录；其中尚未更名 GitHub 等陈述描述当时状态。

---

# Verification — DuoLink 0.6.0

日期：2026-10-18。包和真实目录改名为 `dsh-gc-duolink`，展示名 DuoLink · 会话互联；整合独立复制 ID 插件的菜单功能。保留当前 `master`、HEAD、全部原有文件和未提交修改；独立 `dsh-client-ui-copy-session-id` 文件哈希未变化。旧目录名为兼容软链接，保留 Desktop 既有 0.5.3 安装包来源路径。

| 检查 | 当前结果与证据 |
|---|---|
| 客户端与 scope | PASS；`pnpm test:client`，111/111，11 files；含完整 ID、异步成功、不可用/拒绝/同步抛错 fallback、失败提示/重试和 DOM/focus 清理 |
| TypeScript 与构建 | PASS；`pnpm typecheck`、`pnpm build`；浏览器 loader ID、Cordis 三个导出入口均使用新包名 |
| 构建与交付契约 | PASS；`pnpm test:contracts`，4/4；RPC 签名、冻结 React 模块、全部 bundle 行精确匹配和版本化打包拒绝覆盖 |
| 初始模型单位测试 | PASS；`pnpm exec vitest run tests/initial-model.spec.ts tests/model-spawn.spec.ts`，56/56 |
| 官方 native proof | PASS；4 阶段，19 次 mock、0 付费调用；[JSON](output/initial-model-proof-result.json) |
| 新包安装后的模型/历史兼容 | PASS；`pnpm test:initial-model-installed`，46 次 mock、0 付费调用；含卸载后原生恢复；[JSON](output/initial-model-installed-result.json) |
| 新包真实浏览器 | PASS；Brave + 官方 DSH 0.2.0-rc.2；隔离 profile 中安装新名字 tgz、完整 UI smoke、未互联会话菜单复制到系统剪贴板、当前会话不切换、0 模型调用；[JSON](output/playwright/installed-smoke-result.json)、[菜单截图](output/playwright/duolink-copy-session-id.png) |
| 旧包更换为新包 | PASS；`SMOKE_UPGRADE_FROM=.../output/0.5.3/dsh-session-link-0.5.3.tgz` 的同一浏览器 runner：旧版创建真实互联，停止临时服务后更换包，存储/profile 配置字节保留、新包读取原互联不变、仅新 bundle 启用、完整 UI smoke 通过；[JSON](output/playwright-rename/installed-smoke-result.json) |
| 工作区与旧插件保留 | PASS；对照任务开始前文件清单和哈希，原有文件均保留，旧复制插件未修改，HEAD 和 master 未变化；`git diff --check` 通过 |

兼容契约仍为 `session_link` version 1、`sessionLinks` RPC、五个工具名、`/session-link`、原命令 definition ID、历史消息标记和元数据。UI 槽位和浏览器模块使用新包身份；SDK 中排除宿主旧内置同名模块的规则继续保留。

本次未修改或安装实际用户 profile，未重启 Desktop，未 commit/push/发布，未更名 GitHub 仓库或更新 origin。Electron 实机运行与本次 Host source 辅助回归均为 NOT_RUN。GitHub 推荐沿用原仓库改名，等待明确授权；详见 [说明](docs/plans/duolink-rename.md)。当前校验使用隔离运行时和浏览器，不消耗付费模型。

以下保留 0.5.3 及更早的历史记录，历史包名、路径和计数不代表当前版本。

---

# Verification — 0.5.3 spawn Workspace placement

日期：2026-10-16。当前交付版本 **0.5.3**；在已有未提交工作区上局部实现，未提交、未发布、未安装到用户 profile，未重启 Desktop。执行计划见 [spawn-workspace-placement.md](docs/plans/spawn-workspace-placement.md)。以下 0.5.2/M1/M2/实验记录保留历史范围。

## 0.5.3 目录继承与 Workspace 归类（2026-10-16）

已核对运行中的 `/Applications/DeepSeek Harness.app` 0.2.0-rc.2 的 asar：Session Controller 只在请求带 `workspaceId` 时关联成员，GUI 按 Workspace 的 `sessionIds` 分组。已安装插件两条创建路径只传 `cwd`；本机 spawn ledger 六个 Session 都未登记成员，其中五个目录已有 Workspace。问题是缺少显式成员登记。

本版 `cwd` 可选。省略时使用真实调用方 header.cwd，并继承调用方 Workspace；调用方未分组则新会话也未分组。显式绝对目录在原生创建后通过公开 `workspaceRegistry.create(cwd)` 创建或复用 Workspace、再 `attachSession`，无需事先在 Desktop 打开；软链接规范化复用，子目录独立归类。两条创建路径在建链后、首次任务前汇合，不修改初始模型预写/原生 owner。Workspace 归类意图及完成收据保存在原 spawn ledger；失败明确暴露、首任务不入队；重试不重复创建，已完成调用不恢复人类后续移除的成员/分组，待完成的目标注册被删除时拒绝重建。旧已完成调用及历史会话不自动迁移。

| 检查 | 当前结果与证据 |
|---|---|
| 官方 SDK 构建 | PASS；`env -u DSH_SOURCE_ROOT pnpm build`，DSH 0.2.0-rc.2，TypeScript 与浏览器/Host 打包完成 |
| 客户端与 scope | PASS；`env -u DSH_SOURCE_ROOT pnpm test:client`，105/105，10 files |
| 初始模型单位测试 | PASS；`env -u DSH_SOURCE_ROOT pnpm exec vitest run tests/initial-model.spec.ts tests/model-spawn.spec.ts`，56/56；新增省略/显式 Workspace 摘要区别，保留旧显式目录摘要 |
| Host 辅助回归 | PASS；`DSH_SOURCE_ROOT=/Users/gc/Dev/Opensource/deepseek-harness pnpm test:host`，258/258，6 files；工具失败/重试/并发/旧调用回归，以及真实 Workspace 服务的分组、规范化、持久收据、重启、人类移除检查。使用 source testkit，单独列作辅助证据 |
| 构建与打包契约 | PASS；`pnpm test:contracts`，4/4；Remote 签名、浏览器模块、peer/export 与版本化交付拒绝覆盖 |
| 官方 native proof | PASS；`env -u DSH_SOURCE_ROOT node tests/integration/initial-model-proof.mjs`，4 阶段、19 次 mock、0 付费调用；[JSON](output/initial-model-proof-result.json) |
| 官方 packed + Workspace/GUI proof | PASS；`env -u DSH_SOURCE_ROOT BROWSER_EXECUTABLE_PATH='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' pnpm test:workspace-installed`，5 阶段、46 次 mock、0 付费调用；普通/选模均覆盖继承、未分组、未注册现有目录、新目录、软链接、实际 Host 重启、原生模型控制；[JSON](output/initial-model-installed-result.json) |
| 真实浏览器归类 | PASS；隔离 Brave + shipped Web GUI，先订阅再创建；新分组无需 reload 即出现，新会话可打开，刷新仍保留，0 未处理浏览器错误；[截图](output/playwright-workspace/workspace-live-created.png)。预览提示确认状态预置在临时 overlay，保持 profile/overlay 配置不变的原检查 |
| 发布包 | 通过 `pnpm pack:release` 生成 `output/0.5.3/dsh-session-link-0.5.3.tgz`；最终逐文件一致性、导出完整性及 SHA256 以同目录 `delivery-manifest.json` 和 `SHA256SUMS` 为准 |
| 边界 | Desktop Electron 本体、用户现用 profile 安装/升级、完整旧邮箱 UI smoke、真实远端模型调用本轮均 NOT_RUN；未改动 Host checkout、用户会话或旧版交付包 |

单位/回归/契约合计 **423 项**，均为当前工作区运行结果；历史记录的测试数量不并入本轮。

## Historical verification

日期：2026-10-14。**当前交付以本页「0.5.2 安装问题修复」为准；功能行为沿用下方唤醒额度追加验收**。M1 已在 `9b56e40` 提交，M2 未提交、未发布，包版本已更新为 0.5.2；下方 0.5.0/M1/旧实验版记录保留其历史范围，不构成本轮新的依赖或需求。

## 0.5.2 安装问题修复（2026-10-14）

用户在 Desktop 插件安装窗口重复选择同一路径的 0.5.1 包：pnpm exit 0，但 DSH 返回“无法从依赖变更中确定安装了哪一个包”。原因已直接验证：我们此前在同一个版本/路径覆盖了不同内容；Desktop 依赖仍指向该 file spec，锁文件 integrity 与当前 tarball 不同，已安装 client.js 为 89,692 字节而新包为 108,218 字节（旧包不含 extendChainWakeFrom）。主机安装器成功执行 pnpm 后按 dependencies 前后差异识别目标；同路径无差异，裸路径又不匹配其包名回退规则，触发 ambiguous-install。peer warnings 和 cloudflared ignored-builds 不是这个错误的直接原因。

修复为新的 **0.5.2 / output/0.5.2/dsh-session-link-0.5.2.tgz**，不再覆盖旧交付；双语安装说明指向新路径。新增 `pnpm pack:release`：先核对包中文件与工作区、导出入口，再独占创建制品；相同字节允许重复打包，不同字节的同版本制品明确拒绝，要求升级版本号。旧 0.5.1 文件保留为历史。

| 检查 | 证据 |
|---|---|
| 隔离旧包→新包升级 | PASS；从用户已安装 0.5.1 仅复制插件公开包文件生成 fixture，在临时 Web profile 内执行与 GUI 相同的 `pluginManager/installBundle` RPC；同路径重复安装复现 pnpm exit 0 / ambiguous-install，换 0.5.2 后 bundle 被识别并返回 restart-required |
| 重启与完整 Web 场景 | PASS；只重启测试 profile 后运行整套 M1/M2/追加额度 UI smoke，0 次模型调用；[结果](output/playwright-install-upgrade/installed-smoke-result.json) 的 upgradeEvidence 为 0.5.1→0.5.2、samePathFailureReproduced=true、restartVerified=true |
| 构建与契约 | `pnpm build` PASS；`pnpm test:contracts` **4/4**。新增隔离 fixture 回归验证初次打包、相同重试、修改文件后拒绝覆盖且旧 archive 字节不变 |
| 运行代码比较 | 当前构建的 **63 个 lib 文件**逐字节等于前轮已通过 400 项功能测试及 native/packed proof 的 0.5.1 最新实现；此次没有改动产品功能源码，不重复声称在 0.5.2 重跑了所有单位或 native proofs |
| 发布包 | `pack:release` 逐文件核对、导出完整性与 SHA256；证据随包存放于 output/0.5.2/delivery-manifest.json 与 SHA256SUMS |

Desktop profile 全程只读，未安装、删除、重启或更改用户现用实例；未提交或发布，原会话和配置保留。真实 Electron 的安装升级未执行，隔离 Web 使用的是相同 Host 安装 RPC。

## 唤醒额度追加验收（2026-10-14，0.5.1 未发布工作区）

用户确认[专项开发计划](docs/plans/chain-wake-budget.md)后，两个 GPT-6.1-Sol / high 子代理分别完成服务端与弹窗，主代理检查实现并运行下列最终集成门禁。此前 M1/M2 改动保留，没有向其他 DSH session 派发工作。

- 默认链/UTC 日/单消息额度为 **8/12/1**；原配置字段可覆盖，显式旧值不变。首任务继续计入链和日额度，不重置历史。
- `extendChainWakeFrom` 仅供人类 UI，严格解析归属及链根；追加收据与去重事实一起保存在原 ledger。请求重试、重启、并发陈旧确认不会重复加额；只有所选 pending 消息会被尝试继续投递。
- 消息旁入口主动打开原生模态窗口，选择 4/8/自定义 1–100；显示当前计数、新上限、接收方日额度和其他限制。取消不写入；成功与刷新失败分开反馈；冲突需再次确认；owner 切换、隐藏、卸载清理窗口，迟到结果不污染别的会话。
- 每日/单消息预算、wake:false、双向授权、归档、legacy 隔离、FIFO、取消/解绑不复活和初始模型原生 ownership 保持。五个模型工具不变。

| 最终检查 | 结果与证据 |
|---|---|
| 官方 SDK typecheck/build | PASS；`env -u DSH_SOURCE_ROOT pnpm typecheck` 与 `pnpm build`，0.5.1 / 官方 0.2.0-rc.2 peers |
| `pnpm test` | PASS；client + scope **105/105**（10 files），initial-model/model-spawn **55/55**，built contracts **3/3**，另包括下方两个 installed proofs |
| `pnpm test:host` | PASS；**237/237**（5 files），与上述单位/客户端/契约合计 **400 项** |
| native proof | PASS；**19 次 mock、0 付费**；[结果](output/initial-model-proof-result.json) |
| packed proof | PASS；**39 次 mock、0 付费**；[结果](output/initial-model-installed-result.json)。真实双方交替完成 8 次自动唤醒，第 9 条排队；人类 +4 后仅新增 1 次请求；同请求并发重放不二次加额/派发，旧总额确认返回 conflict；真实 Host 重启后再次重放保持 extra=4、used=9、零请求 |
| packed Web / Brave | PASS；[结果](output/playwright-wake-extension/installed-smoke-result.json)。真实 RPC/界面验证默认计数、主动弹窗、默认4/选择8/自定义无效值、取消零写入及回焦、确认后 extra=4/limit=12、未授权情况下仍 queued、重复请求不加额、陈旧请求 conflict，以及原 M1/M2 场景；0 次模型调用 |
| 视觉核对 | 已查看[浅色弹窗](output/playwright-wake-extension/session-link-wake-dialog.png)、[暗色弹窗](output/playwright-wake-extension/session-link-wake-dialog-dark.png)、[窄视口弹窗](output/playwright-wake-extension/session-link-wake-dialog-narrow.png)。原生模态遮罩、单选与确认/取消可读，窗口不横向溢出 |
| diff | `git diff --check` PASS |

浏览器 fixture 的耗尽链来自显式注入的前日历史，用来验证窗口与 RPC，不把它算成真实发生过的 8 次唤醒；真实扣减、解除链阻塞后的请求次数和重启去重由独立 packed mock proof 验证。两者均为隔离 home/profile，未修改用户运行实例。

本轮复核补足：投递尝试耗尽后正确报告 failed/not_pending；成功追加且刷新失败时旧行显示新限额；响应不确定时保留相同 requestId/payload，实际拒绝原因不隐藏；显示“继续检查时状态”，不把历史回执冒充实时状态；严格拒绝矛盾的协议状态。现有测试未删除或 skip。

本阶段历史交付为 `output/0.5.1/dsh-session-link-0.5.1.tgz`，同目录 SHA256SUMS 与 delivery-manifest.json 描述本次构建。旧 0.5.0 历史包不变。未提交、push、发布、安装现用 profile；Electron、付费模型与实验 profile 迁移仍为 **NOT_RUN**。M3/M4 暂缓结论不变。

## M2 里程碑验证（2026-10-14，未发布工作区）

接续 `session-53d3fc31-5833-49ef-8e80-d6373b690f40` 的最后状态与 [有效规划](ITERATION_ROADMAP_0_5_BASELINE.md)。当前分支直接开发，由主代理及 Sol high 子代理完成；未再向 DSH session 派发任务。M3 仍等待真实使用反馈，M4 仍等待可复现规模问题，不启动追溯扩建、GC 或宿主改造。

**M2-A 先独立验收**：人类 RPC `cancelMessageFrom({ sessionId, messageId })` 在原串行临界区重读归属与目标持有证据，返回 cancelled / already_terminal / too_late 和检查时状态。原模型取消接口保持兼容；普通邮件仅限原始双方，断链不丢失归属，legacy 标记（含非字符串值）拒绝并保持只读。UI 共用写入门控，重复点击只发一次，owner 切换丢弃迟到反馈，刷新失败与已接受操作分开提示；解除确认说明不停止运行、不撤回交付内容。该阶段 typecheck/build、客户端、宿主 **178 项**、native **19** / packed **30** 次 mock 请求与隔离 Web smoke 均通过（[阶段结果](output/playwright-m2a/installed-smoke-result.json)）。

**M2-B 后单独实施并最终合并验收**：仅 send 增加可选布尔 `wake`；新消息记录持久化意图，旧缺字段按 true。false 不主动冷恢复、不唤醒空闲目标、不扣额度，同 key 重放使用原值；running 的 next-turn、合法唤醒/人类活动带来的 FIFO 顺带交付保持。spawn 不接受 wake，初始模型和原生 owner 流程不变。activity/UI 以“此消息不申请唤醒”区别于授权不足。新提示计入字节限额，旧正文不重写，预览识别新旧精确框架；中英文说明记录降级可能丢失 wake 语义。

| 最终检查 | 当前证据 |
|---|---|
| 官方 SDK typecheck / build | PASS；`env -u DSH_SOURCE_ROOT pnpm typecheck` / `pnpm build`，官方 0.2.0-rc.2 peers |
| `pnpm test` | PASS；client **91/91**（9 files）、initial-model/model-spawn **55/55**、built contracts **3/3**；包括下方两个真实安装 proof |
| 官方 native bootstrap | PASS；**19 次 mock、0 次付费**；[结果](output/initial-model-proof-result.json) |
| 官方 packed 工具 proof | PASS；**30 次 mock、0 次付费**；额外验证真实 send 的 false→true 重放不升级、无新增请求、严格 wake/schema、接收方人类取消；[结果](output/initial-model-installed-result.json) |
| `DSH_SOURCE_ROOT=/Users/gc/Dev/Opensource/deepseek-harness pnpm test:host` | PASS；**209/209**（5 files）：冷热/运行状态 × omitted/true/false、重启/旧记录、FIFO、预算、取消/插入/flush/解绑竞争、legacy 隔离、字节上限与工具严格参数 |
| packed Web smoke | PASS；Brave + 隔离 profile，**0 次模型调用**；真实取消 UI/RPC、第三方拒绝、接收方重复取消、写后刷新、unlink 保留 cancelled、wake:false 阻塞文案，以及原 M1 生命周期场景；[结果](output/playwright-m2/installed-smoke-result.json) |
| 图像核对 | 已查看最终[取消界面](output/playwright-m2/session-link-mail.png)、[窄栏](output/playwright-m2/session-link-narrow.png)、[暗色](output/playwright-m2/session-link-dark.png)，内容可读，无新增截断/重叠 |
| 独立代码复核 | 修复 too_late/pending 缓存永久禁用：新权威快照可恢复取消；结果文案标为“取消检查时状态”，避免冒充实时状态。回归均纳入 client 门禁 |
| `git diff --check` | PASS |

本轮调试记录：首个浏览器取消拒绝断言错误地要求普通异常的 `code` 穿过宿主 RPC，改为核对真实公开的拒绝文本；服务端原始错误 code 仍由 host 测试校验。新增框架提示后，三个原 400 字节恢复测试无法再容纳合法短任务，限额改为 700；原 800 字符超长载荷仍被拒绝，并新增恰好上限/少一字节测试。没有删除或 skip 既有回归。

边界：未提交、push、发布或安装到用户现用 profile；保留无关 `doraemon-bicycle.html`。Desktop Electron、真实收费模型、实验 profile 迁移为 **NOT_RUN**。取消只控制尚未被目标持有的投递，不停止运行、不撤回已交付内容。单测中的故障注入不作为真实磁盘断电证明。

### 后续阶段门禁与本地交付（2026-10-14）

用户在继续 Goal 时明确反馈“暂时没有明显追溯痛点”。Sol high 子代理只读复盘指定 session，确认四类历史案例：引用已有会话（seq 30）、两个独立研究返回（153/174/188）、指定初始模型的实施交接（525/571/589）、多轮 M1 复审及状态同步（589/742/973/1116/1198）。这些是 M2 实际使用前的通信事实，不证明新增折叠链会降低查日志成本；M3 按原计划保留最近列表。未确认跨目录、预算排队或取消错误消息的真实使用反馈，不以测试 fixture 冒充用户反馈。

本地存储只读快照：9 组、38 条消息（其中 25 条带父引用）、120,786 字节；没有已报告或可复现的规模问题。没有因此启动 M4，也未把条数或文件大小当作性能基准。

交付审计发现原 `output/dsh-session-link-0.5.0.tgz` 仍为 10 月 13 日基线，不能当作 M2 包。保留原历史包及其校验和；首次 M2 临时包独立放在 `output/m2-unreleased/dsh-session-link-0.5.0.tgz`，旁附 SHA256SUMS 与交付 manifest。该次临时快照当时沿用 0.5.0 package version，现已由下方 0.5.1 交付取代。包内补入 README 直接引用的有效规划与 ADR-001；其他源码/历史证据链接仍需仓库环境。

### 首次 0.5.1 版本编号与交付（历史）

按用户要求将当前 M1/M2 工作区正式编号为 0.5.1，但未执行发布、提交或现用 profile 安装。新包路径为 `output/0.5.1/dsh-session-link-0.5.1.tgz`；旧基线和 `m2-unreleased` 临时快照保留为历史，当前安装示例已指向 0.5.1。本次仅修改版本号与交付文档，功能验收仍以本页上方 358 项测试及 native/packed/Web 结果为准；版本交付另行检查 build、构建契约、包内版本、所有导出与逐文件一致性，结果随包记录在 `delivery-manifest.json` 和 `SHA256SUMS`。

## 0.5.0 基线结果（历史）

| 检查 | 当前证据 |
|---|---|
| 官方 SDK build / typecheck | PASS；清除 DSH_SOURCE_ROOT，官方开发 peers 0.2.0-rc.2；最终 build 含 TypeScript 声明编译 |
| pnpm test 默认入口 | PASS；client 56，initial-model 55，built contracts 3；同时运行以下两个官方 integration suites |
| 官方 native bootstrap | PASS；19 次实际 mock adapter 请求，0 次收费；不安装 Session Link、不替换 controller/persistence/preset |
| 官方 packed tools | PASS；30 次实际 mock adapter 请求，0 次收费；安装 0.5.0 tarball，实际注册工具、native create/selection owner、JSONL persistence |
| 原功能辅助 host suite | PASS；120 tests / 4 files：link、remote、tool-session-link、command-session-link；source checkout 仅用于未发布 testkit，不是选模发行依据 |
| packed Web browser smoke | PASS；Brave；header/panel/wake/poll/theme/reload/invalid config/remove、五工具 scope、明确 ID adopt；0 model calls；明暗截图已人工核对 |
| diff / 运行依赖 | PASS；git diff --check；生产源码无 taskHost factory/runtime/tasks/outbox/决策工具引用、无私有 deep import或宿主路径；退役字段仅用于拒绝迁移 |
| Desktop Electron / 付费模型 | NOT_RUN；没有启动/切换用户 Desktop，没有真实远端模型鉴权或收费请求 |
| 旧 tracked-task profile 迁移 | NOT_RUN；本轮不做现用 profile 切换、降级、迁移或历史数据清理 |

单位、客户端、契约与辅助 host 合计 234 项检查通过。取消功能的旧任务状态机/宿主扩展套件已退休；不以原 359 项计数作为新版目标。

## M1 里程碑验证（2026-10-13，0.5.0 之后未发布工作区）

里程碑范围见 [ITERATION_ROADMAP_0_5_BASELINE.md](ITERATION_ROADMAP_0_5_BASELINE.md) M1-A/M1-B：`activityView` 只读分页观察 RPC（M1-A）；最小邮件面板、头部速览、spawn 卡片创建时投递状态与打开会话按钮（M1-B）。本轮不改动持久化 schema（src/spec.ts 未触碰）、不改动任何投递/唤醒语义，邮件 UI 全部只读（取消 UI 属 M2，未实现）。

### 审查发现逐项关闭（M1_REVIEW.md F1–F10）

| 发现 | 修复 | 证据 |
|---|---|---|
| F1 错误文本未脱敏 | `sanitizeError` 先脱敏后截断：Authorization/Bearer 头、常见 token/key/password 参数值、URL userinfo 均被替换为占位符；持久化原始记录不改 | 审查方回归 [tests/review-m1-backend.spec.ts](tests/review-m1-backend.spec.ts) 原样转绿（未删除/未 skip/未改写断言） |
| F2 无关会话误判欠首任务唤醒 | 摘要投影先按被管理会话的组成员身份过滤，再调用原 firstWakeOwed helper；spawn 首任务语义未动 | 同文件回归转绿；另补多组/空邮箱/不存在 owner 用例 |
| F3 显示队列与投递队列排序不一致 | pending 段直接按实际投递队列（`pendingFor` 同序）分页；跨目标不伪称全局执行序；游标为带签名的有界快照，队列结构变化即失效报 `ACTIVITY_CURSOR_INVALID`；投递 FIFO 未改 | 同文件回归（activity 对照真实 `pendingFor`）转绿 |
| F4 运行中目标误标"未授权唤醒" | `blockingReasons` 区分"当前投递阻塞"与"若将来空闲时的唤醒限制"：目标 running 或已持有待确认时不列唤醒约束；无明确原因报 unknown；冷驻留不写成"对方未在运行"；入站记录称"接收方/目标" | 同文件回归（模拟 running 后不再出现 wake-unauthorized）转绿 |
| F5 预览固定剥两行 | `previewText` 用 record 的 senderTitle/senderId/messageId 校验完整已知帧后精确移除；无法识别的旧形状保守保留原文 | 同文件回归（真实 `frameSessionLinkText` 生成消息，预览为用户正文）转绿 |
| F6 加载更多失败静默 | 分页失败独立呈现 alert 并提供同页重试，已有条目保留；成功重试清除错误且不重复 append | 审查方回归 [tests/client-mail-review.spec.tsx](tests/client-mail-review.spec.tsx) 原样转绿 |
| F7 刷新失败清空数据 | 同 owner/section 刷新失败保留最后快照并标记 stale（保留 sampledAt）；owner/section 切换立即隔离；补迟到响应/卸载/切换/竞争用例 | 同文件第二项回归转绿；client-state 竞争用例覆盖 |
| F8 邮箱未接入刷新生命周期 | 按 owner 共享的 MailController（[src/client/state.ts](src/client/state.ts)）：仅订阅时轮询（沿用 view 的 pollIntervalMs）、`connection/reset` 触发刷新、写后 invalidate 全部邮箱、AbortSignal 取消过时请求、退订即停；采样时间按页记录。本轮 smoke 另复现并修复重订阅死链：视图全部卸载后重新挂载时 `subscribe()` 重新武装轮询定时器（退订会停表），peek 收尾同样补武装 | smoke "revoked mail disappears from the mounted view" 通过；新增单测 "re-arms polling when a view resubscribes after a full unmount" |
| F9 入口与诊断缺口 | 头栏弹层新增已互联对象快览与逐条"打开会话"入口；面板标题新增"打开被管理会话"；摘要含 firstTaskWakeOwed 首任务例外提示；入队时间明确标注 "Enqueued"；legacy 脚注说明本版不投递、需人工检查 | smoke quickPeerOpen / managedSessionOpen / 头部快览断言通过；组件测试覆盖文案 |
| F10 packed RPC / Web smoke | packed tarball + 隔离 profile + Brave：activityView 请求/响应分页与畸形游标拒绝、管理非当前会话、头栏对端入口、前台切换/断连重连/写后刷新、分页错误保留与重试、窄栏/长正文/明暗主题截图（output/playwright/）；0 次模型调用 | `pnpm test:integration` PASS，摘要 13 项标志全 true；截图已人工核对 |

F10 范围说明：隔离 profile 无模型供应商，目标永远不会 running，因此"已送达"邮件在 smoke 中按设计不可能；recent 段通过解除互联后的终态 `revoked` 记录验证，长正文经 600 字符信封验证。delivered 路径、firstTaskWakeOwed 实际触发与 legacy 标记隔离由 host/单测覆盖。

### 第二轮复审发现逐项关闭（M1_REVIEW.md R2-01–R2-07，2026-10-14）

审查方复审在首轮未覆盖场景复现 F1/F3/F8 未闭合，记为 R2-01–R2-07；审查方新增回归 [tests/review-m1-backend.spec.ts](tests/review-m1-backend.spec.ts) +3 项、[tests/client-mail-rereview.spec.tsx](tests/client-mail-rereview.spec.tsx) +5 项，全部原样转绿（未删除/未 skip/未改写断言）。

| 发现 | 修复 | 证据 |
|---|---|---|
| R2-01 脱敏漏纯文本 password=X 与 JSON api_key | 本轮先改为 `redactSecrets` 系统化分层（authorization 头、bearer/basic、JSON 成员、带引号与裸 key=value、header 风格、URL userinfo，敏感键并集大小写/空白不敏感）；**第三轮复审判定"改写任意原文"仍不可完备（R3-01），已由固定安全摘要取代，见下节**；持久化原始记录始终不改 | 审查方 `it.each` 回归（纯文本 password=、JSON api_key）原样转绿；R3 三项亦已转绿 |
| R2-02 pending 投影用非传递比较器全局排序 | 不再对超集做全局排序后过滤：按目标取 `pendingFor(targetId)` 权威队列并过滤到可见集合，按入队时间（平手：targetId、messageId）做 k 路归并交错；`sig` 摘要对最终可见有序身份列表计算；注释改述 sig 为无密钥内容摘要（变更检测），非安全签名 | 审查方多目标队列保序回归原样转绿（过滤后子序列恒等于真实 `pendingFor` 队列） |
| R2-03 退订遗留 loading/refreshing，重挂载不重启首次加载 | 全员退订时把 `status`（空页时）复位为 idle、清 refreshing/loadingMore；重挂载订阅时按 status 重新启动读取，epoch 防护保留 | 审查方"中断的首次加载在重挂载后重启"回归原样转绿；smoke 新增 reload 后延迟路由中断首读→前台切换打断→重开面板重启边界断言 |
| R2-04 refresh/loadMore 互相取代但不清对方忙标志 | 忙标志归属当前 epoch：refresh 落定发布 `loadingMore: false`，loadMore 落定发布 `refreshing: false` | 审查方"refresh 取代 loadMore 后按钮不再永久禁用"回归原样转绿 |
| R2-05 头部速览 peek-only，计数器永久陈旧 | 仅摘要订阅（速览）也纳入共享轮询：有监听且（有页或有摘要）即武装定时器，无页时以 peek 轮询；落定记录 `summarySampledAt`，速览以 title 标注采样时刻；退订即停 | 审查方 fake-timers 轮询回归原样转绿；smoke 新增速览 staleness title 断言 |
| R2-06 invalidate 重读所有曾打开的 owner | 无订阅时 invalidate 仅标记 dirty，不发请求；下次激活（重新订阅）时按模式重读（有页 refresh、仅摘要 peek）；有订阅时行为不变；缓存保留策略不动 | 审查方"退订后 invalidate 不再触发读取"回归原样转绿；补 client-state 两项 dirty 激活重读单测；smoke 新增"alpha 退订期间 UI 写不产生 alpha 读取"路由计数边界 |
| R2-07 MailSection 本地 section 状态与控制器脱节 | 删除组件内本地 section useState 与重置 effect：tab 选中唯一以 `state.section`（控制器）为准 | 审查方"Recent 重挂载后 tab 与数据一致"回归原样转绿；smoke 新增前台切换重挂载后 tab=Recent 且 recent 行仍在断言 |

### 第二轮门禁（2026-10-14 复跑，全部 PASS）

| 检查 | 证据 |
|---|---|
| 官方 SDK typecheck / build | `env -u DSH_SOURCE_ROOT pnpm typecheck`、`pnpm build` PASS |
| pnpm test:client | 79 tests / 8 files（审查方 rereview 5 项 + 新增 dirty 重读 2 项，全部原样/新增转绿） |
| pnpm test:host | 143 tests / 5 files（审查方后端复审 3 项原样转绿） |
| 官方 native bootstrap proof | 19 次 mock adapter 请求，0 次收费 |
| 官方 packed tools proof | 30 次 mock adapter 请求，0 次收费（`npm_config_cache=/tmp/dsh-npm-cache`） |
| pnpm test:contracts | 3 tests PASS |
| packed Web browser smoke | PASS；Brave；13 项标志全 true；新增 R2 浏览器边界：速览采样时刻 title、重挂载 tab/数据一致、退订期间写零读取、reload 后中断首读重启 |
| git diff --check | PASS |
| Desktop Electron / 付费模型 | NOT_RUN |

### 第三轮复审收尾：R3-01 与 lastError 输出契约（2026-10-14）

第三轮复审确认 R2-02～R2-07 可关闭，仅 R2-01/F1 仍阻断：审查方新增 3 项真实 activityView 回归（[tests/review-m1-backend.spec.ts](tests/review-m1-backend.spec.ts) :119–128，原 8 项未动）复现"改写任意原文"路线仍不完备——URL query 裸 `key`（前一轮键集重写时遗漏）、合法 JSON 值内含相反引号、JSON 字符串转义引号，三种形状均可泄漏后缀。

**根因**：`lastError` 由任意自由文本经分层正则改写得到。对不受约束的原文，任何正则集合都不完备（形状无穷、每轮都有新绕过），且"截断 + 控制字符压平"同样不满足"不返回敏感错误"。继续叠加正则只会重复第三轮。

**最终契约（不再改写原文）**：`errorSummary(error)` 在记录带 error 时返回固定安全摘要 `delivery error (details withheld)`，不含原始文本的任何片段；无 error 时仍不产生 `lastError` 字段（可选短字符串契约不变，schema/类型/工具/错误系统均未增改）。`redactSecrets`/`SECRET_KEYS` 已整体删除，不留正则层。持久化记录的 `error`、`text` 原样保留，投影只读、不迁移不改写。注释明确记载：任意原文不保证安全，截断压平不能满足"不返回敏感错误"要求，故只报"发生过投递异常、详细诊断未展示"。

| 检查 | 证据 |
|---|---|
| 审查方 R3 三项回归 | 原样转绿（未删除/未 skip/未改写）；本地先复现 143 PASS/3 FAIL 后再修复 |
| tests/remote.spec.ts 契约更新 | 原"恰好 200 字符且以 boom 开头"期望改为固定摘要内容 + ≤200 上限 + 不含原文片段 + 无控制字符；新增 7 形状 `it.each`：任意原文不拼接到 `lastError`/`JSON.stringify(view)`，且原始记录 `error`/`text` 逐字节不变 |
| pnpm test:host | 153 tests / 5 files（146 + 7 新形状用例） |
| pnpm test:client / contracts / typecheck / build | 79 tests PASS / 3 tests PASS / PASS / PASS |
| native + packed initial-model | 19 / 30 次 mock，0 次收费 |
| packed Web browser smoke | PASS；Brave；13 项标志全 true；0 次模型调用 |
| git diff --check | PASS |
| 文档校正 | 本节输出契约；[ITERATION_ROADMAP_0_5_BASELINE.md](ITERATION_ROADMAP_0_5_BASELINE.md) M1-B 的 packed 浏览器 NOT_RUN 更正为 PASS（隔离 profile + packed tarball + Brave） |

### 本轮门禁（2026-10-13 复跑，全部 PASS）

| 检查 | 证据 |
|---|---|
| 官方 SDK typecheck / build | `env -u DSH_SOURCE_ROOT pnpm typecheck`、`pnpm build`（ESM 117.79 kB） |
| pnpm test:client | 72 tests / 7 files（含审查方 2 项客户端回归原样转绿、重订阅轮询回归） |
| 官方 native bootstrap proof | 19 次 mock adapter 请求，0 次收费 |
| 官方 packed tools proof | 30 次 mock adapter 请求，0 次收费（`npm_config_cache=/tmp/dsh-npm-cache` 隔离缓存） |
| pnpm test:contracts | 3 tests；activityView 在期望方法集内 |
| 原功能辅助 host suite | 140 tests / 5 files；审查方 5 项后端回归（[tests/review-m1-backend.spec.ts](tests/review-m1-backend.spec.ts)）已纳入 test:host 门禁并原样转绿 |
| packed Web browser smoke | PASS；Brave；摘要 `activityViewPaged/activityCursorRejected/mailSurface/mailFailureRetained/quickPeerOpen/managedSessionOpen/unlinkRevokesQueuedMail` 等 13 项全 true |
| git diff --check | PASS |
| Desktop Electron / 付费模型 | NOT_RUN；无真实远端模型鉴权或收费请求 |

行为边界：activityView 不唤醒、不 flush、不占用预算、不激活冷会话，不做会话存在性检查；条目预览 ≤160 字符且剥离投递帧，`lastError` 脱敏后 ≤200 字符；游标为 base64url 不透明令牌，畸形或队列结构变化时报 `ACTIVITY_CURSOR_INVALID`。spawn 卡片新增"任务消息创建时已入队/受理"标签——仅记录创建时刻的投递意图状态，不表示已读、已执行或已完成，也不会随后续送达变化冒充实时状态；需要最新详情时打开面板。打开会话按钮仅调用宿主 openSession。带 legacy statusKind/taskStatus 标记的记录继续隔离：不进条目列表，仅计入 `legacyBlocked` 并在面板以脚注提示。面板摘要含唤醒已用/上限与 UTC 重置时刻，并以 sampledAt 标注数据采样时间，陈旧数据可被识别。


## 可复跑命令

```sh
env -u DSH_SOURCE_ROOT pnpm typecheck
env -u DSH_SOURCE_ROOT pnpm build
env -u DSH_SOURCE_ROOT pnpm test
DSH_SOURCE_ROOT=/Users/gc/Dev/Opensource/deepseek-harness pnpm test:host
BROWSER_EXECUTABLE_PATH='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' pnpm test:integration
git diff --check
```

默认 `pnpm test` 已包含 native 与 packed initial-model suites；不需要重复执行 installed suite才能满足默认门禁。复跑环境必须是已安装官方 DSH；runner 记录包版本、entrypoint/manifest realpath 与 controller 公共导出，拒绝 createTaskHost 扩展，并清除 DSH_SOURCE_ROOT/NODE_PATH/NODE_OPTIONS。所有验证 profile 都是临时隔离实例，测试完成后关闭并删除；没有触碰宿主 checkout 或用户运行 profile。

## 实际请求与故障边界

Native：detached Session prepare/append → persistence append/flush/close → read 确认 → native create/adopt。调用方 BASE 显式 effort low、B 省略 effort 且模型默认 high（实际请求必须为 high），以及首次请求、工具第二步、随后 turn、并发 A/B/BASE、首响应前后重启、原生改 C 与重启保留均验证了 adapter request provider/model/effort 和 prompt 内容。seed/execute 后 application 内存默认及 profile/overlay 的原始字节均保持，包含异步保存队列落定后。

Packed：严格目录和 effort、schema/旧参数拒绝、send 无选模、完整正文后缀/模型/授权变化冲突、普通调用不得补模型、解除不复活、ID 碰撞、相同调用首次并发只投递一次、有/无模型竞争两个方向、原生 C 后同调用重放保留 C、卸载后原生恢复均通过。生产 renderer 的第二 text 是可解析 JSON；initialModel 是初始事实，不冒充当前模型或执行成功。

单位测试补充真实安装不强行模拟的 I/O 故障：create/append/flush/close/activate、取消、confirmed receipt 后读取失败、未链接 intent、旧 preset 后续不可解析、未知事件/非普通身份/ownership、完整摘要与单飞。它们证明插件编排的拒绝与恢复规则；不把这些 mock 当作真实磁盘断电测试。

应用默认只允许在 fixture 后续模拟人类原生选择 C 时按宿主行为改变；spawn 的隔离阶段没有改后恢复。插件卸载前后的运行选择由原生事件/请求头保留。未增加第二 controller、selection setter、request/assemble 覆盖 listener 或自动换模。

## 产物

- [native proof JSON](output/initial-model-proof-result.json)
- [packed tools JSON](output/initial-model-installed-result.json)
- [browser smoke JSON](output/playwright/installed-smoke-result.json)
- [light screenshot](output/playwright/session-link-light.png) / [dark screenshot](output/playwright/session-link-dark.png)
- [baseline 44-file manifest](output/plugin-only-baseline-manifest.json)
- 本地安装包：`output/dsh-session-link-0.5.0.tgz`（仅交付，未安装到用户 profile）。

以上 output 是本地产物，不提交入 Git。0.5.0 以 master 上的前向提交取代 549a1d7 的实验实现，保留旧提交和计划／审查；历史处理见 [ADR-001](docs/decisions/001-plugin-only-initial-model.md)。

## 本轮审查修复（2026-10-13）

- 保留历史 statusKind/taskStatus JSON 元数据，过滤所有带标记的报告：重启恢复和普通消息触发投递均不插入、不唤醒，显式重放返回 LEGACY_TASK_MESSAGE_BLOCKED。三项新增 host 回归使用同一持久存储重启，核对原记录完整保留及普通邮件仍可送达。此防护不覆盖未标记任务邮件或宿主专属事件，不能据此直接降级旧 tracked profile。
- 官方 fixtures 让调用方 BASE 显式 low、B 模型默认 high；B 初始选择和工具参数均省略 effort。首请求、工具步骤、后续 turn 和恢复后的真实请求均由 adapter 断言为 high，排除了继承调用方的可能。
- 空会话 ownership 未确认冲突的报错明确说明崩溃窗口与人工检查；保持保留数据、不自动修复/删除的设计。
- 两个 bootstrap peers 已标 optional，built contract 验证 manifest。普通 spawn 的并发异参错误改为通用 SPAWN_REPLAY_CONFLICT；完成后的原重放规则仍保持。
- 本轮重新执行 build、typecheck、默认 pnpm test（56/55/3）、host 120 项及 diff 检查；native 19 / packed 30 mock 请求，paid 0。没有修改 UI，Brave smoke 未在本轮重复，表中该项仍为上一轮已执行证据；Desktop 仍为 NOT_RUN。

## 用户初步测试与文档交付（2026-10-13）

用户反馈“初步测试通过”，未说明具体平台、profile 或覆盖步骤，记录为用户反馈而非自动验收，不据此宣称 Electron／远端付费模型已测试。新增中英文 README 和普通 0.4.1／实验 0.4.1 升级区别；旧实验计划标为历史，宿主 checkout 的未提交扩展留在原处，不纳入本插件提交或清理。

<details>
<summary>旧 0.4.1 / task-routing 实验历史（非当前验收）</summary>

# Verification — dsh-session-link 0.4.1 workspace

## Current round — model-routing post-review state (2026-10-13)

This section is the truthful post-review status of the model-routing feature line, after the independent round-2 review ([CODE_REVIEW_MODEL_ROUTING.md](CODE_REVIEW_MODEL_ROUTING.md) — **untracked review material**, kept as the record) and the five-task fix plan ([.superpowers/sdd/MODEL_ROUTING_FIX_PLAN/](.superpowers/sdd/MODEL_ROUTING_FIX_PLAN/) — planning material, also untracked). It replaces the earlier "current round" claim; the pre-fix round-1 writeup is preserved at the bottom labeled historical-with-corrections.

**Status correction (was round 1, now post-round-2):** The round-1 narrative claimed 7 plan tasks complete and available, and "317 tests passing". The independent review showed round 1 shipped with a **test-only assembly shortcut** (the tracked task service was mounted through a `defineProperty` escape the shipped bundles never ran) and **multiple concurrent model-selection owners**, so those 317 green tests were not evidence of the shipped behavior. Round 2 confirmed 18 defect IDs (R01–R18) plus 3 flagged-but-unconfirmed risks and 1 item needing separate verification (concurrent decision replay). All 18 IDs are now fixed with grip tests; the three risks are adjudicated/closed with durable evidence below; the suite is fully green (no RED anywhere, after the reviewer probes were migrated into the persistent suite).

### Environment facts

- Plugin: `dsh-session-link 0.4.1` (workspace), built with npm SDK `0.2.0-rc.2` dev peers; zod pinned `4.4.3`.
- Host source: DSH checkout `/Users/gc/Dev/Opensource/deepseek-harness` @ `656ca652a0`, plus the **additive task-host extension that is NOT committed in the checkout** (working-tree state: untracked `packages/api/session-controller/src/task-host/` + a modified `packages/api/session-controller/src/index.ts` export block). Round 2 grew the same working tree: unified host model owner for task-bound turns (R02/R05/R06/R07), the managed-input guard (R04), projection v4 plain-JSON rows (round-1 C1/I2–I4), and initial-header settle. `TASK_HOST_VERSION = 1`; the extension now also includes projection v4 (modelSelection unit state is plain JSON end-to-end) and the task-host pause/resume fail-closed contract.
- Storage domains: `session_link` v1 (additive optional `statusKind`/`taskStatus` fields) and `session_link_tasks` v1 (new this feature line; additive `retiredDeliveries` field, optional). The `modelSelection` projection state is **v4 plain JSON** (round-1 review C1) — the durable checkpoint cache accepts it losslessly and checkpoint+tail replays classify identically to full replay, including mid-task-turn.
- Capability gate: `taskHostVersion` reports `1`; tracked paths require the task-execution capability (`insertIfAbsent`-optional service insert path) and refuse `HOST_CAPABILITY_UNAVAILABLE` when absent. The model-selection yield clause (round-1 I2) is part of the same host contract.
- UI smoke runtime: official `dsh 0.2.0-rc.2` CLI, isolated `DSH_HOME`/profile/npm cache, Brave; zero model calls (`modelCalls: 0`).

### Commands run this round — all PASS

| Command | Result |
| --- | --- |
| `pnpm run typecheck` | PASS (installed SDK `0.2.0-rc.2` declarations) |
| `pnpm run build` | PASS (`lib`, 7 files, ~306 kB ESM total) |
| `pnpm run test:contracts` | PASS — 3 built-artifact tests |
| `pnpm run test:policy` | PASS — 32 tests / 1 file |
| `pnpm run test:client` | PASS — 55 tests / 5 files (client-turn 16, client-panel 17, client-state 8, client-registration 3, scope 11) |
| `pnpm test` | PASS — `test:client` + `test:policy` + `test:contracts` (requires `build` first) |
| `DSH_SOURCE_ROOT=/Users/gc/Dev/Opensource/deepseek-harness pnpm run test:host` | PASS — **272 tests / 10 files** (`link` 59, `remote` 17, `tool-session-link` 33, `command-session-link` 16, `model-runtime` 20, `task-routing` 30, `tasks` 38, `task-notifications` 16, `task-runtime-mixed` 2, **`review-fixes` 41**) — final2 wave added the F2-final Important-1 grip |
| `DSH_SOURCE_ROOT=… pnpm exec vitest run` (root, all suites incl. client+policy) | PASS — **359 tests / 16 files, 0 failures** (the previous single RED — the reviewer probe's "shipped assembly (absent)" case — disappeared with the migration below; its honest replacement is the green old-host grip `R01 old host`) |
| `DSH_SOURCE_ROOT=… pnpm exec vitest run --config artifacts/review/vitest.config.ts` | Expected RED remains — **7 passed / 1 failed**: the frozen historical probe file still contains the pre-R01 "absent assembly must admit" case, intentionally not re-executed/registered anywhere (historical artifact untouched) |
| `BROWSER_EXECUTABLE_PATH='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' pnpm run test:integration` | PASS — packed tarball installed into an isolated Web profile, browser exercised; result JSON: `{"result":"PASS","dshVersion":"0.2.0-rc.2","modelCalls":0,…}` |

Suite-registration change this round: `scripts/test-host.mjs` now lists `tests/review-fixes.spec.ts` (the review-grip suite) explicitly; the plain root run includes it as before, now self-contained (no artifact import).

### Review-defect fix matrix (R01–R18)

Every confirmed round-2 defect and its grip test. Grip tests live in `tests/review-fixes.spec.ts` (persistent, R##-prefixed, self-contained fixtures) unless noted; all fail on the pre-fix source where the reviewer reproduced the defect and pass now.

| ID | Defect (review) | Fix commit | Grip test |
| --- | --- | --- | --- |
| R01 | Task service mounted only through a test escape; shipped assembly had no tracked path | `84bab5d` | `R01: production assembly mounts the task service without test escape`; plus probe migration `R01 old host` |
| R02 | Real ApiSessionAgentController's model owner overrode the task route | `e3c76c1` | `R02: real controller installModelSelection never overrides the task route`; probe migration `R02 probe` |
| R03 | Cancelling a queued tracked task still executed on a later wake | `b8bf3d1` | `R03: cancelling a queued tracked task revokes the delivery + host intent and never executes`; probe `R03 probe` |
| R04 | Task-bound message without a live claim executed as ordinary mail | `e3c76c1` | `R04: a task-bound message without a live claim is rejected, never executes as ordinary mail` |
| R05 | Failed session-scope task persisted its model as baseline | `e3c76c1` | `R05: a failed session-scope task never persists its model as baseline`; probe `R05 probe` |
| R06 | Consumed human selection overwritten by a stale task CAS | `e3c76c1` | `R06: a consumed human selection is never overwritten by a stale task CAS` |
| R07 | Task header folded after a human baseline became the rebuild fallback | `e3c76c1` + `2aab41e` | `R07: a task header folded after a human baseline never becomes the rebuild fallback`; `R07-initial` |
| R08 | Retry re-admitted the consumed delivery identity; retry of precheck-failed spawn didn't ride the original identity | `b8bf3d1` | `R08(1): retrying a claimed-failed task mints a NEW delivery identity and executes a real new request`; `R08(2): a precheck-failed spawn retry runs the full idempotent create/link/rename/admit path` |
| R09 | Tracked intent stored/re-sent the 160-char excerpt, not the full payload | `b8bf3d1` | `R09: the tracked intent stores and re-sends the FULL payload, never the 160-char excerpt` |
| R10 | Activation re-derived `candidates[0]` instead of the precheck-selected candidate | `b8bf3d1` | `R10: the precheck-selected candidate is fixed onto the attempt and activation uses it`; probe `R10 probe` |
| R11 | Bound-but-missing mailbox delivery replayed as admitted/queued | `b8bf3d1` | `R11: a bound-but-missing mailbox delivery is heralded as repair, never replayed as admitted` |
| R12 | Partial streamed output allowed automatic fallback | `e3c76c1` | `R12: partial streamed output bars automatic fallback`; probe `R12 probe` |
| R13 | `session_default`-only fallback rejected at precheck | `b8bf3d1` | `R13: a default-only fallback admits and executes on the baseline route`; probe `R13 probe` |
| R14 | MAILBOX_FULL-refused outbox event had no retry-condition trigger | `f76ed28` | `R14: capacity-freeing delivery re-pumps the refused outbox with no new task mutation` |
| R15 | Concurrent first-creates of one taskId could silently overwrite | `b8bf3d1` | `R15: concurrent first-creates of one taskId adopt-or-conflict, never silently overwrite` |
| R16 | Request digest hashed only the first 2048 chars | `b8bf3d1` | `R16: a replay whose tail diverges beyond 2048 UTF-16 units conflicts instead of adopting`; `R16 legacy adoption` |
| R17 | Notification messageId derivation collided on sanitized callIds | `f76ed28` | `R17: colliding sanitized callIds produce DISTINCT notification messages, never an overwrite`; `R17 conflict: admitTaskStatus never overwrites a row whose stored event differs` |
| R18 | Unbound tasks' notifications minted fresh wake chains per event | `f76ed28` | `R18: a precheck-failed task's notifications ride ONE wake-budget chain across the retry`; `R18 mint continuity` |

Round-1 review layer (the same overall review's needs-fixes tier): C1 (modelSelection row not plain JSON → checkpoint cache threw), I2 (prompt owner rewrote the frozen task route), I3 (initial-reason task header settled as human), I4 (mid-task-turn checkpoint classification diverged) — fixed in `2aab41e` with grips `Checkpoint v4: …snapshotJsonValue accepts it`, `Checkpoint v4 replay: checkpoint+tail and full replay classify identically, including mid-task-turn`, `Task prompt invariant: …prompt variables carry the frozen task route`, and `R07-initial`.

### Final2 (round-2 final review) fix wave

| ID | Finding (final2 review) | Fix commit | Grip test |
| --- | --- | --- | --- |
| F2-final Important-1 | Mixed-batch-refusal SOLO re-record built the fresh intent's route from the first *concrete* candidate only; a default-only policy (single `session_default` sentinel) re-recorded `route: {}`, so activation named the literal `session`/`session_default` placeholder in `execution.currentRoute` and commitTurn skipped session-scope persist (`routeUsed === undefined`) | `b6cb23a` | `F2-final Important-1: a default-only policy re-recorded after a mixed-batch refusal carries the CONCRETE baseline route` (fail-first verified: RED pre-fix with `route.selection` undefined; GREEN after) |

Fix mechanism: the re-record now honors the attempt's fixed candidate (`selectedCandidateIndex`), and a sentinel resolves through the SAME unified snapshot chain R13 admission uses — the TARGET host's effective baseline first, the deployment catalog default second (`resolveCatalogDefault`, wired from the tools layer's `sessionController.modelCatalog()`), never the sender's; when neither answers the row projects `waiting_decision` (`catalog_unavailable`, `not_started`) instead of ever recording an empty-route intent.

Same-wave minors in `b6cb23a`: the `R01 old host` grip's "four legacy tools" claim now has tool-level coverage (added `session_list_links` + `session_cancel_session_message` invocations to the fixture); the R11 grip-name typo `heraled` → `heralded` (this matrix and the tools.ts R11 comment follow); the pre-R08(1) "one deterministic messageId" docstring at the retry re-admission corrected to the attempt-scoped delivery-identity description; trailing blank line at the end of `tests/review-fixes.spec.ts` removed.

### The three flagged-but-unconfirmed risks — outcomes (this round's Task 5)

1. **Terminal projection vs outbox-marker revision race** — *fixed (deterministic sequencing + explicit classification)*. Terminal projections and pump markers ride the same per-row CAS revision; the pre-existing bare `catch {}` in `projectFinishTasks`/`projectWait` could, in principle, treat a durable write failure as "another terminal projection already done". The runtime now classifies: only typed `TASK_STALE_REVISION`/`TASK_TERMINAL` rejections are swallowed (the settled-by-a-concurrent-writer class); `TASK_WRITE_FAILED` and unexpected errors propagate to the finish-loop warn path. Grips: `Risk-1 terminal/marker race: the terminal projection never mis-classifies a marker CAS…` (fabricated interleave; typed refusal; row untouched) and `Risk-1 durable-failure arm: …surfaces TASK_WRITE_FAILED, never the settled-by-race class` (fail-first verified: RED on the pre-fix runtime).
2. **Outbox marker persistent write failure → pump cascade** — *fixed (bounded cascade + visible failure accounting)*. Reproduced deterministically: mailbox admission succeeded while the durable marker kept failing; the pre-fix cascade re-armed on every pass with no bound. Now (a) the cascade is single-flighted per serialized chain with an epoch budget (4 consecutive failure-driven cascades per genuine trigger; a pass whose markers fail does not cascade at all), (b) the failure surfaces on `session_get_task` as `outboxMarkerFailureNotes` (live, revision-attached notes; never a forged marker), (c) the mailbox keeps exactly ONE row (eventId idempotency replays; a later pass adopts it), and (d) recovery is self-healing (a genuine later trigger settles the marker; the note clears). Grip: `Risk-2 marker cascade: persistently failing outbox-marker writes bound the pump cascade, surface on get_task, keep ONE mailbox row, and self-heal` (fail-first verified: RED on the pre-fix classification). No timers/pollers were added anywhere.
3. **Retry scope semantics** — *adjudicated and LOCKED*. Decision: a retry/continue that replaces provider/model but omits scope **preserves the original attempt's `model_scope`**. Session scope is an explicit user grant of persistent-selection consent scoped to the task; silently degrading to task scope removes that consent (wrong direction). The wire surface intentionally keeps no scope parameter (documented in `session_resolve_task`'s description); the durable policy snapshot on each new attempt records the preserved scope. Grips: `Risk-3 retry scope: …SESSION-scope task preserves the session grant` (fail-first verified: RED showing the pre-fix silent degrade `session → task`) and `Risk-3 retry scope: …TASK-scope task keeps task scope (never a silent upgrade either)` (symmetric lock).

**Concurrent decision replay atomicity** (review: "还需单独验证") — *verified by test; no code gap found*. Two concurrent `session_resolve_task` calls with the same decision callId settle with exactly ONE applied decision recorded; the loser observes the recorded outcome (or records `stale`), the task never double-attempts. The Task-3 machinery (`decisions.find` before validation + single CAS write) already covers the realm — the test is the deliverable. Grip: `Risk-4 concurrent decision replay: two racing resolve_task calls with the SAME decision callId never double-apply`.

### Reviewer probes migration

The 7 reproduction probes plus the assembly probe from `artifacts/review/model-routing-probes.spec.ts` are now persistent fixtures in `tests/review-fixes.spec.ts` (R##-prefixed, self-contained — the harness `stack()`/`spawn()` is a local copy of the reviewer's minus the escape mode):

| Historical probe | Persistent grip |
| --- | --- |
| `shipped assembly (mounted)` | `R01: production assembly mounts the task service without test escape` |
| `shipped assembly (absent)` *(was RED — pre-R01 hosts cannot admit)* | **Replaced** by `R01 old host: tracked params refuse HOST_CAPABILITY_UNAVAILABLE; the four legacy tools keep working` — the honest old-host contract |
| `cancelling queued tracked task must prevent execution on later wake` | `R03 probe` |
| `real API Session model owner must not override tracked task route` | `R02 probe` |
| `execution must honor catalog-selected fallback B instead of rejected primary A` | `R10 probe` |
| `default-only fallback must admit when primary absent and default available` | `R13 probe` |
| `partial streamed output must prevent automatic fallback` | `R12 probe` |
| `failed session-scope task must never persist its model as baseline` | `R05 probe` |

`artifacts/review/model-routing-probes.spec.ts` and its vitest config/baselines remain untouched (historical material; not registered in any suite).

### Honest NOT_RUN list (refreshed)

- **Real assembled official host install with model routing**: the shipped `dsh 0.2.0-rc.2` runtime lacks the task-host capability; the tracked path correctly refuses there (installed smoke covers it). Installed-proof of the tracked path running inside an official host requires a host release carrying the extension. NOT_RUN.
- **Physical old-plugin downgrade over seeded model-bound tasks**: requires building a pre-model-routing artifact and installing it over a seeded profile; the fail-closed property is covered by host-side tests (`model-runtime` restart reconciliation; `tasks` crash/restart reconcile). NOT_RUN (repro in the historical section's matrix row "旧宿主/插件移除/降级").
- **Survival across a REAL transcript compaction**: this harness has no compaction op; durable facts are asserted across full context teardown/reload instead. NOT_RUN.
- **Real paid-model tests**: no authorization this round. NOT_RUN.
- **Real Electron launch / live profile upgrade**: NOT_RUN (isolated profile only).

### Known limits this round

- `continue` on a partial task: today's host exposes no resumable checkpoint; the tool refuses with `TASK_NOT_RESUMABLE` honestly (tested). Pause/resume fail closed on the host capability (tested).
- Task-status attribution is **body-framing only** (host-generated statement in the report body; no transcript badge).
- Plain-run baseline: the full vitest root run without `DSH_SOURCE_ROOT` still cannot import the host-source-dependent suites (long-standing documented split; pure suites and contracts run plain).
- `outboxMarkerFailureNotes` (get_task) is live process state by design — the durable row stays the authority (pending, marker absent); the note only explains a still-failing realm and clears when the marker lands.
- Mailbox rows and task rows are not auto-pruned; budget scans read the full tables (long-standing).
- Cosmetic: on a CATALOG_UNAVAILABLE precheck outcome the failure trail covers catalog-checked candidates only; a `session_default` late-binding candidate contributes no trail row by design.

### Publish boundary (updated)

**Minimum host**: DSH checkout @ `656ca652a0` + the additive task-host extension — which after round 2 means: `taskHostVersion 1`, **projection v4** (plain-JSON modelSelection unit state), the **task-host managed-input guard** (R04), **insertIfAbsent-optional** task insert path (R15 falls back to a single-flight chain when absent), and the **model-selection yield** semantics (round-1 I2). All of this lives as **uncommitted working-tree changes** in `/Users/gc/Dev/Opensource/deepseek-harness`; before a real publish the extension must be upstreamed into DSH and declarations rebuilt.

**Old-host behavior**: model-routing parameters on `session_spawn_linked_session` / `session_send_session_message` fail with `HOST_CAPABILITY_UNAVAILABLE` (no task created, no fake queued/accepted; proven by `R01 old host`), while the four legacy tools (`session_list_links`, untracked `session_send_session_message`, `session_cancel_session_message`, untracked `session_spawn_linked_session`) and the human command keep working unchanged. `session_list_models` reports `taskHost: false`.

**Downgrade safety**: installing an OLD plugin over a profile holding model-bound pending tasks fails closed — durable task/turn-intent facts live in the host and the `session_link_tasks` domain; the old plugin never executes them. The physical bits-swap install remains NOT_RUN (above).

**Schema compatibility**: `session_link` v1 unchanged (additive optional fields only). `session_link_tasks` v1 additive `retiredDeliveries` (optional). `modelSelection` projection state is v4 — plain JSON; old v3 rows upgrade through full log replay (the fold is forward-compatible; checkpoint rows written by the v3 Set-bearing shape are a test-realm construct that round-1 C1 removed — production checkpoints written after this build are v4).

**Uninstall**: leaves no model pollution — task-scope routes are per-turn freezes restored on close, session-scope routes persist only through the user-visible CAS commit; plugin removal preserves session histories and `session-link-message` attribution.

---

## Historical round-1 section (kept for provenance; superseded by the post-review status above)

### Round-1 claim — CORRECTED

The round-1 writeup (now removed from the current-status position) claimed the model-routing feature line verified end to end with "317 tests / 15 files" passing, 7 plan tasks complete, and cited a final fix-wave matrix as evidence. **The independent round-2 review ([CODE_REVIEW_MODEL_ROUTING.md](CODE_REVIEW_MODEL_ROUTING.md)) superseded that claim**: round 1 shipped with the assembly dual-path (test escape standing in for the production mount) and multiple model-selection owners; the 317 passing tests ran in harnesses that bypassed the real controller and real assembly, so they did not cover the shipped behavior. The review confirmed 18 defects (R01–R18, fixed and gripped above) and flagged the risks closed this round. The useful parts of that round's evidence remain the automation-matrix rows below (several of which the review's own "why 317 tests were not enough" section qualifies) and the environment facts, which are restated truthfully in the current section.

### Automation matrix (plan Task 7) — round-1 evidence, review-qualified

The row-by-row table from round 1 is retained in git history (`git show <round-1 commit>:VERIFICATION.md`). Read it with the review's qualifications: fixtures in `task-routing`/`model-runtime` bypassed the real ApiSessionAgentController and hand-mounted the task service; the prompt/header "consistency" tests compared adapter/request header attribution rather than rendered prompt variables; the restart fixture did not prove the managed-inbox prohibition under unload/downgrade with the real controller; the fallback-partial and cancel coverage missed the mid-stream and queued-cancel realms; and the installed smoke exercised an old host without the task capability (covering the refusal path, not tracked success). Every gap named there now has a grip in the matrix above or an honest NOT_RUN line.

### Prior rounds (before the model-routing feature line)

The results below document earlier rounds of this same 0.4.1 workspace (approved preset/UI/return-wake update and the original 2026-10-10 verification). They are kept for provenance and are not this round's evidence.

### Prior round — approved preset / UI / return-wake implementation

The approved update round verified: `pnpm build` / `pnpm typecheck` (PASS, installed SDK); `DSH_SOURCE_ROOT=… pnpm typecheck` (PASS); `pnpm test:client` (PASS, 39 tests in 5 suites); `DSH_SOURCE_ROOT=… pnpm test:host` (PASS, 117 tests in 4 suites); `pnpm test:contracts` (PASS, 3 tests); packed official-CLI browser smoke (PASS, `dsh 0.2.0-rc.2`, isolated Web profile/npm cache and Brave, no model requests); `git diff --check` (PASS).

Coverage and evidence boundaries from that round:

- Omitted preset config survives Loader schema resolution as automatic mode, includes effective default and standard/ptc/cordis, excludes minimal/subagents; explicit lists and empty lists remain exact. Default-id changes take effect when an Agent is next evaluated through the existing lifecycle; no synthetic default-change event was added.
- The leading mark is no longer registered. Formal workspace right-hover action and menu seats are registered. Component and wire-owner tests prove that management params bind mutations to the clicked Session, not the foreground Session. The installed browser exercise switches management between alpha/beta in the same tab without switching the foreground conversation.
- Quick linking requires explicit confirmation and sends separate peer/caller grants; the installed browser verifies independent defaults and resulting persistence. Linked count/color are independent of wake.
- Real ToolRuntime + mock model tests verify B→idle-A reply wake, caller opt-out queueing, and reply-chain-budget queueing. These are not paid/live-model tests.
- Replay keeps existing/human-disabled grants unchanged. Storage-failure tests verify all four initial wake combinations survive restart even with changed replay arguments. Legacy incomplete intents without the optional original-grants field recover conservatively, preserving the first-task special case. Domain version remains 1.
- The browser fixture's preparatory rename attaches beta to materialize Host title/workspace projections. Its non-foreground management test must not be described as a cold-resume test; cold catalog non-activation is separately covered by Host regression.
- Final installed light/dark screenshots were read and visually checked for readable directional labels and unclipped layout. The temporary browser/server/profile were cleaned up. Electron launch, live profile upgrade, touch-device smoke and live model exchange: NOT_RUN.

Rerun results: [installed smoke](tests/integration/RESULTS.md). Screenshots: [light](output/playwright/session-link-light.png), [dark](output/playwright/session-link-dark.png).

### Historical verification — 2026-10-10 (original 0.4.1)

`dsh-session-link 0.4.1` is an independently built and installed plugin. The original DSH checkout remains at `656ca65`, with its pre-existing modified/untracked files left untouched. The user's running Desktop profile was not switched.

| Check | Result |
| --- | --- |
| `pnpm build` with installed npm SDK `0.2.0-rc.2` | PASS; TypeScript and both bundles |
| `DSH_SOURCE_ROOT=/Users/gc/Dev/Opensource/deepseek-harness pnpm typecheck` | PASS with checkout `0.2.1-alpha.1` declarations |
| `DSH_SOURCE_ROOT=… pnpm test:host` | PASS; 100 tests in 4 suites |
| `pnpm test:client` | PASS; 21 tests in 3 suites |
| `pnpm test:contracts` | PASS; 3 built-artifact tests |
| Official CLI tarball installation and real browser smoke | PASS; `dsh 0.2.0-rc.2`, isolated profile, Brave |
| Tools and command mounted per preset in the shipped runtime | PASS; absent from the global layer, 4 tools in a `standard` Session, no tools or command in a `minimal` Session |
| Concurrent link requests for one pair over the real wire | PASS; exactly one group |
| Desktop install path | npm `dsh 0.2.0-rc.2` refuses `--profile desktop` (Electron-managed); Desktop's bundled `dsh 0.2.0-rc.2` refuses an uninitialized Desktop profile in an isolated home. Installing into the user's live Desktop profile: NOT_RUN |
| Invalid plugin configuration | PASS; explicit startup warning, core Sessions remain usable |
| Plugin removal | PASS; restart and both Session histories remain readable |
| Real Electron launch | NOT_RUN |
| Live model-driven peer exchange | NOT_RUN; host regression uses the real loop with mock model output |
| Future DSH release compatibility | NOT_RUN |

Changes since 0.2.0 (0.3.0): tools and the command mount per preset into top-level Agent scopes; the spawn tool's initial task wakes the new Session once under the daily budget and a rename or delivery failure no longer leaves an unlinked Session; linking validates the calling Session and rejects a duplicate pair atomically; the UI ignores repeated clicks while a write is pending; unused `listFor`, `catalog`, and `selectionFor` are removed. In 0.3.1, a follow-up review reproduced three defects, each now covered by a regression test that fails on the 0.3.0 source: a replayed spawn call created a second Session while returning the first message; concurrent auto-wake toggles from two windows dropped one flag; and resending a refused first task through the send tool only queued it. Spawned Session ids now derive from the caller and call id, toggles read and write inside the admission chain, and a spawn grant owes its spawned member one budgeted wake until a message is delivered or wakes it. In 0.3.2, a second review reproduced two replay defects in 0.3.1: replaying a spawn call relinked a group the human had removed, and replaying a call recorded by 0.3.0 created a new hash-id Session while returning the old message as `accepted`. The spawn tool now reads the call's spawn record or earlier first task before creating or linking; the group and the spawn record are written in one admission-chain slot; a removed group is reported and never recreated. Regression tests cover replay after unlink, a 0.3.0-recorded call before and after unlink, a replay after a refused task, concurrent claims, and pre-0.3.2 ledger rows; with the up-front lookup disabled, the four tool-level replay tests fail. In 0.3.3, a third review injected storage write failures and reproduced two defects in 0.3.2: a failed spawn-ledger write after the group write left a group with no call record, so a replay after the human unlinked it (and a restart) relinked it; and a failed idempotency-ledger write after the message write let a retry admit a second copy, delivering the task twice. The storage domain commits one record per write and has no cross-table transactions, so 0.3.3 orders writes instead: the spawn call record commits before its group as an intent, unlink marks spawn records removed before deleting the group, and the idempotency key is stored on the message record in the same write. Fault-injection tests fail chosen writes per table (record before group, group after record, removal mark, group delete, message store, wake record, the 0.3.2 idempotency write) with restarts on a shared medium; six of them fail on the 0.3.2 source, including both reported scenarios. In 0.4.0, a comprehensive review of 0.3.3 (`artifacts/review-0.3.3.md`) reported eight reproduced defects: in-memory insertion counted as a durable receipt; a stored spawn task's failure hint caused a duplicate; a spawn replay skipped re-delivery; cancellation was checked only at entry; a waking message overtook earlier queued mail; the model never saw the message id needed for `in_reply_to`; a Session could message itself; and unload closed storage before in-flight sends finished. 0.4.0 replaces per-message delivery with per-target in-order delivery under one rule set: `send` throws only when the message will never be delivered; `accepted` follows only a successful flush; cancellation applies until insertion; replays use the same path; the model-visible frame carries the sender id, message id, and reply instructions (verified through the repository's DeepSeek Messages `serialize`); self-sends are refused; and one ordered disposer drains before closing. On the 0.3.3 source, ten new regression tests fail, covering every item. An independent review of that result then confirmed six more defects, fixed with tests that all fail on the intermediate source: terminal replays reported `queued`; a message handed to a now-cold target could be cancelled, revoked, or failed (messages are now marked `inserted` before hand-off); delivery order across a restart for same-millisecond admissions (messages now carry a monotonic `seq`); the reply-chain wake budget reset across groups; a cancel during the wake claim wasted a day's wake (now refunded); and `in_reply_to` accepted undelivered messages. Its concern that an unavailable scoped service blocks Agent creation was tested and does not occur; the remaining unverified concerns are listed under README known limitations. Host tests cover preset scoping and reselection, row unload, subagent exclusion, the initial wake and its budget, spawn partial failures, caller validation, and concurrent linking; client tests cover repeated clicks and the shared write gate.

In 0.4.1, cancellation that arrives while the durable `inserted` marker is being written is observed before any `followup`, and any pre-handoff marker failure rolls back speculative markers, the message wake count, and the target's daily wake claim. Two host regressions cover cancellation at the marker boundary and retry after a failed marker write.

The browser smoke exercised add, wake toggle, configured one-second polling of an external mutation, command and tool registration, reload persistence, light/dark themes, failed-refresh content retention and retry, unlink, and rejected self-links. Invalid configuration and plugin removal preserve a seeded historical peer message's body and `session-link-message` source through `session/page`; that fixture demonstrates reader compatibility, not a live model exchange. It issued no model request and removed its temporary home, browser and server.

The contract tests inspect the actual built host methods' `request` and final `signal` parameter names, Remote markers, every bundle export, declared host peers, and the browser factory's React-only runtime imports. No generated Remote metadata or DSH source modification is needed.

Screenshots of the actual app were visually inspected in both themes. Detailed installed-smoke evidence is in [tests/integration/RESULTS.md](tests/integration/RESULTS.md); rerun instructions are in [README.zh.md](README.zh.md#开发与验证). Screenshots live in `output/playwright/`.

UI changes in another window or from a command use polling, defaulting to 30 seconds; acknowledged writes refresh immediately. The plugin's `uiConversation` tail card is optional. Existing fork implementations must be disabled before activating the external plugin in the same profile.

</details>
