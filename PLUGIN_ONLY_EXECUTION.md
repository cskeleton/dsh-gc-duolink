# 纯插件初始选模：实施记录

日期：2026-10-13。版本：0.5.0。实施授权来自本轮 `/goal ...规划开发和执行`。

依据：[附件方案](MODEL_ROUTING_PLUGIN_ONLY_PLAN.md)及 DSH 会话 `session-5898d9ac-a19c-4973-8654-ceac15b849a7` 的最后讨论。原始记录位于 `~/.dsh/sessions/--Users-gc-Dev-MyProject-dsh-plugin-dsh-session-link--/session-5898d9ac-a19c-4973-8654-ceac15b849a7/session.v4.jsonl.zstd`；解压后 seq1078 是用户“只做新建会话选模”的选择，seq1252 是最终纯插件门槛与基线裁决。附件中“仅规划”是上一轮状态，本轮已追加实施授权。

## 执行结果

1. **Task 1 完成**：未改官方 DSH 0.2.0-rc.2，隔离 native seed → append/flush/close/read → create/adopt，19 次实际 mock adapter 请求；首请求、多步、随后普通 turn、并发 A/B/BASE、prompt/effort、应用默认隔离、重启、原生人类改 C 全部通过。无收费请求。
2. **Task 2 完成**：以 `42abec4` 前向恢复功能架构。逐项核对原 44 个 tracked 文件，恢复旧文件，删除 17 个旧 feature 独有模块/测试/helper。未 reset、改分支、提交或改历史；旧规划、审查、路线图及未知缓存保留。逐文件清单在 `output/plugin-only-baseline-manifest.json`。
3. **Task 3 完成**：严格 initial_model、目录/effort 校验、已有 ledger 的创建意图、完整参数 SHA256、稳定 Context 的同 key 单飞。仅在持久确认后由 native controller 激活。未确认碰撞拒绝；确定归本意图的空记录可在同调用重放中补齐；已有任务回执不重新激活。无后台恢复器或另一套模型 owner。
4. **Task 4 完成**：原 spawn 第一文本保持，第二文本为版本化初始配置 JSON；卡片标记“初始会话模型”。旧参数明确拒绝，send 无选模，tasks 导出/任务 RPC/状态卡/任务决策工具退出。
5. **Task 5 完成（官方 Web 范围）**：packed tarball 安装后实际调用五工具，30 次 mock 请求；严格拒绝、完整参数重放、原生 C 后重放、首次同 call 并发、跨有/无模型竞争、unlink、卸载后的 native resume 通过。独立浏览器 smoke 通过。Desktop Electron 为 NOT_RUN；未进行用户 profile 切换或实验数据迁移。

## 决策与修复

- Service getter 的 Cordis proxy 身份不稳定，单飞使用工具行捕获的 Context；有/无模型路径共用锁。真实安装并发测试覆盖首次调用，避免只有“完成后重放”通过的假象。
- 失败报告区分真实组成员关系、已存任务和投递回执；不会因当前重放失败否认以前已经 accepted 的消息。
- 已确认 seed 的重放不重新解析原 preset，不恢复后来人类的模型/preset；必要的 activation 让 native observation 选择现有 preset。
- 官方 defineTool 的顶层参数对象默认开放。spawn/catalog 显式关闭；send 保留原 sender_id 等未知参数不获得授权的兼容行为，但所有模型字段明确拒绝。
- 测试夹具使用异步 import 官方 ESM 包，避免 require(ESM) 与 Loader 链接竞态。生产代码无私有 import、宿主复制或 monkey patch。

## 验证与运行

当前命令、产物和证据边界见 [VERIFICATION.md](VERIFICATION.md)。可复跑：

```sh
env -u DSH_SOURCE_ROOT pnpm build
env -u DSH_SOURCE_ROOT pnpm test
DSH_SOURCE_ROOT=/Users/gc/Dev/Opensource/deepseek-harness pnpm test:host
BROWSER_EXECUTABLE_PATH='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' pnpm test:integration
```

source host 四组回归只证明原互联功能的辅助兼容；纯插件发行证据来自官方包和 packed profile。取消的任务状态机套件已退休，没有修改旧断言以伪装任务能力可用；审查和提交历史仍可追溯。

## 交付边界

- 实施阶段在 master / 549a1d7 上前向修改；后续按用户明确授权形成 0.5.0 提交，保留这之前的全部历史；不 push。
- 未修改 DSH checkout、官方安装文件、Desktop 或用户正在运行的 profile。
- 旧 tracked-task profile 不自动迁移/降级；未删除会话日志、任务域或旧缓存。
- 当前安装包只支持经过验证的官方 0.2.0-rc.2 Web 场景；Electron 未测试，实际远端模型鉴权/付费执行未测试。

## 审查后的局部修复

2026-10-13 按独立审查处理五项风险：保留并隔离带 statusKind/taskStatus 的旧报告；使用 BASE 显式 low/B 默认 high 的实际请求证明 effort 不继承；补充 ownership 未确认时的孤儿会话说明；两个 bootstrap peers 标 optional；普通 spawn 并发异参使用 SPAWN_REPLAY_CONFLICT 并澄清共用锁行为。未改变不自动迁移旧 tracked profile 的边界。

本轮重跑 build/typecheck/pnpm test，client 56、initial-model 55、contracts 3；host 新增三项旧报告重启/重放/普通消息混排回归，共 120 项。native/packed 仍为 19/30 次 mock、0 付费。Brave smoke 沿用前轮记录，本轮无 UI 变更，不重复运行。安装包仍为 0.5.0，重建到原 output 路径；未安装进用户现用 profile。

## 文档与提交

用户随后反馈初步测试通过，并授权更新中英文文档及 commit。README 保留中文入口，新增 README.en.md；增加 ADR-001 记录实验线废弃和独立宿主工作区的处理边界。旧计划、审查和路线图保留原文并标历史，不删除旧提交，不提交／回退／清理 DSH 宿主改动。具体测试环境未由用户提供，初步测试反馈不扩大现有验证范围。
