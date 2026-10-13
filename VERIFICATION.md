# Verification — 0.5.0 plugin-only initial model

日期：2026-10-13。本节是当前验收；下方折叠内容保留旧实验版历史，不构成本版依赖或需求。实施决策与任务关闭见 [PLUGIN_ONLY_EXECUTION.md](PLUGIN_ONLY_EXECUTION.md)。

## 当前结果

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

Screenshots of the actual app were visually inspected in both themes. Detailed installed-smoke evidence is in [tests/integration/RESULTS.md](tests/integration/RESULTS.md); rerun instructions are in [README.md](README.md#开发与验证). Screenshots live in `output/playwright/`.

UI changes in another window or from a command use polling, defaulting to 30 seconds; acknowledged writes refresh immediately. The plugin's `uiConversation` tail card is optional. Existing fork implementations must be disabled before activating the external plugin in the same profile.

</details>
