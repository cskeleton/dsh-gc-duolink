# DuoLink isolation working tree — 2026-10-18

The old-package compatibility decision in earlier records below is superseded. No new archive or version bump was made.

- Browser: PASS with official DSH 0.2.0-rc.2 and Brave, installing the built directory through `link:`. The invalid old configuration row is ignored, old service/RPC/tool/command aliases are absent, the old storage file remains byte-identical, and the independent new file carries a durable product marker. Full existing UI smoke including clipboard copy passes; 0 model calls. [Result](../../output/playwright-isolation/installed-smoke-result.json).
- Installed-directory model proof: PASS, 46 mock requests / 0 paid calls; new tool names and metadata, same-domain recovery and plugin-free native resume. `installationMode` is `built directory link`. [Result](../../output/initial-model-installed-result.json).
- Storage boundaries, failed writes and behavioral regressions: 260 Host tests; client/scope: 111; initial-model unit tests: 56; built contracts: 3. [Verification](../../VERIFICATION.md).
- Existing archives, actual profiles, HEAD and branch retained. The old directory compatibility symlink is removed. Existing old links/settings are not migrated.

Earlier records are historical and do not describe current backwards compatibility.

---

# DuoLink 0.6.0 — 2026-10-18

- Fresh packed `dsh-gc-duolink` install: PASS on official DSH 0.2.0-rc.2 + Brave. Real Copy Session ID menu copies the clicked unlinked Session ID to the clipboard without switching the foreground conversation. Full existing UI smoke and removal/history checks passed; 0 model calls. [Result](../../output/playwright/installed-smoke-result.json).
- Rename migration from the preserved `dsh-session-link` 0.5.3 tgz: PASS. Real old link remains readable after package replacement; storage and profile overrides retained byte for byte; only the new bundle remains enabled. Full UI smoke passed; 0 model calls. [Result](../../output/playwright-rename/installed-smoke-result.json).
- Native model proof: PASS, 19 mock requests / 0 paid calls. Packed new-name model proof: PASS, 46 mock requests / 0 paid calls. [Full verification](../../VERIFICATION.md).
- No user profile installation, Electron run, GitHub rename, commit, push or publication occurred.

Earlier records below are historical.

---

# 0.5.3 Workspace placement — 2026-10-16

PASS on official `dsh 0.2.0-rc.2` using a disposable home/profile and the packed plugin. The extended native/packed fixture validates omitted-cwd inheritance for ordinary and selected-model spawns under both grouped and ungrouped callers; explicit existing-unregistered and nonexistent directories; child-directory isolation; canonical symlink reuse; human detach/replay; and membership after an actual Host restart. Packed proof: five phases, 46 mock model requests, zero paid calls. Native proof: four phases, 19 mock requests, zero paid calls.

The isolated Brave/shipped Web GUI subscribes before placement and observes a new directory group without reload, then opens the spawned conversation and reloads to check persistence. Evidence: [installed JSON](../../output/initial-model-installed-result.json), [native JSON](../../output/initial-model-proof-result.json), [screenshot](../../output/playwright-workspace/workspace-live-created.png). Workspace/browser verification runs with `pnpm test:workspace-installed`; preview acknowledgement is preseeded in the disposable overlay to retain the configuration-purity assertion. User profiles and the running Desktop app are untouched. Desktop Electron itself, a user-profile upgrade and the full historical mailbox UI smoke are NOT_RUN in this iteration.

See [VERIFICATION.md](../../VERIFICATION.md) for 423 unit/regression/contract checks and final archive details.

---

# Latest installation result — 0.5.2 / 2026-10-14

PASS: isolated 0.5.1→0.5.2 upgrade through the same `pluginManager/installBundle` RPC as the GUI. Repeated identical local file spec reproduced pnpm success / ambiguous-install; a new version/path identified the bundle, reported restart-required and installed current client bytes. Restarted temporary Host then passed the full browser suite including wake extension dialog, with 0 model calls. Evidence: [upgrade result](../../output/playwright-install-upgrade/installed-smoke-result.json). Build and 4 contract tests pass, including immutable release packaging. No user Desktop changes were made; actual Electron installation remains NOT_RUN.

Prior functional evidence below remains applicable to the byte-identical runtime code; it is not described as a new full unit/native run for the version-only 0.5.2 delivery.

# Current functional results — 0.5.1 wake extensions / 2026-10-14

Official DSH 0.2.0-rc.2 native proof: PASS, 19 mock / 0 paid calls. Packed proof: PASS, 39 mock / 0 paid calls, including 8 actual bidirectional wakes, queued ninth message, human +4 continuation exactly once, concurrent request idempotency and persisted extension replay after Host restart. Client/scope 105, initial-model 55, contracts 3 and auxiliary Host 237 checks pass (400 total).

Packed Web/Brave smoke: PASS, 0 model calls. The exhausted-chain dialog uses a clearly marked imported-history fixture and tests modal open/cancel/focus, choices and invalid inputs, actual append RPC, truthful continued queueing under another blocker, duplicate/stale confirmations and prior M1/M2 scenarios. Light/dark/narrow modal screenshots were visually inspected under output/playwright-wake-extension/. Electron is NOT_RUN.

See [VERIFICATION.md](../../VERIFICATION.md) for commands, artifacts and exact boundaries. No user profile was changed. The local 0.5.1 package and integrity manifest are under output/0.5.1/; older records below are historical.

<details>
<summary>Earlier installed-smoke record</summary>

# Shipped-runtime verification

## Model-routing verification round (2026-10-12) — PASS

The fresh `BROWSER_EXECUTABLE_PATH='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' pnpm test:integration` run exited 0 against `dsh 0.2.0-rc.2` with the packed `dsh-session-link 0.4.1` workspace artifact that includes the Task 7 registration and test changes. Machine-readable result: `{"result":"PASS","dshVersion":"0.2.0-rc.2","installation":"packed tarball","modelCalls":0,"toolsScopedToListedPresets":true,"explicitSessionIdAdopted":true,"invalidPluginConfigCoreUsable":true,"pluginAbsentSessionsReadable":true}` ([installed-smoke-result.json](../../output/playwright/installed-smoke-result.json)). It used a temporary `DSH_HOME`, profile and npm cache; it did not replace the running GUI or any live profile and issued no model request. The scenario set is unchanged from the approved-UI round below (the shipped runtime has no task-host capability, so the tracked-task path correctly stays out of its scope here; tracked surfaces are covered by the host and client suites).

## Prior round — approved UI update — PASS

The fresh `BROWSER_EXECUTABLE_PATH='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' pnpm test:integration` run exited 0 against `dsh 0.2.0-rc.2` with the current packed `dsh-session-link 0.4.1` workspace artifact. It used a temporary `DSH_HOME`, profile and npm cache; it did not replace the running GUI or any live profile and issued no model request.

New browser checks cover:

- Header click opens the searchable quick-link picker; selecting a candidate does not create a group. Both wake choices start on; disabling peer wake preserves caller wake after explicit confirmation.
- Linked right-row actions reflect membership regardless of wake; no plugin leading mark remains. Clicking beta manages beta while alpha stays in the main conversation. Setting beta's own wake uses beta as caller/receiver. Clicking alpha changes params of the existing tab back to alpha.
- Peer wake toggling preserves caller wake; external mutation becomes visible by polling; reload and the header's management entry preserve the group.
- Unlink removes the membership emphasis, not the quick-link entry. Existing scope, duplicate-link, theme, refresh/retry, invalid configuration and removal/history checks still pass.

Formal menu registration/dismissal and row-scoped RPC wiring are covered by client tests; this browser scenario clicks the right-row action. The fixture's preparatory rename attaches beta and materializes Host projections, so non-foreground management is **not** cold-resume evidence. Cold catalog queries are separately tested by Host regression.

The final light/dark screenshots were visually inspected. Temporary resources were closed and removed. The machine-readable result is [installed-smoke-result.json](../../output/playwright/installed-smoke-result.json); screenshots are [light](../../output/playwright/session-link-light.png) and [dark](../../output/playwright/session-link-dark.png).

Setup fixes while extending this smoke: use an isolated npm cache instead of the user's permission-failing default cache; do not mistake the fixture's earlier rename for a plugin-induced Agent activation. A direct JSONL seed alone does not materialize the same title/workspace projections in this shipped Host, so the original public rename preparation remains.

## Historical run — before this update

The installed smoke passed on 2026-10-10 against the official `dsh 0.2.0-rc.2` CLI, using the packed `dsh-session-link 0.4.1` artifact and an isolated Brave browser context.

```sh
BROWSER_EXECUTABLE_PATH='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' npm run test:integration
```

The command exited with status 0. It installed a local tarball into a new temporary Web profile and verified that the four tools stay out of the global tool layer, mount in a `standard`-preset Session's scope, and are absent with the command from a newly created `minimal`-preset Session. It also verified that two concurrent link requests for one pair create one group, that a repeated `session/create` with one explicit Session id adopts the same Session, the Session Link command, browser add/wake/revoke operations, a one-second configured polling update, reload persistence, light and dark theme colors, retained content after an HTTP 503 refresh failure, retry recovery, and Host rejection of a self link. It issued no model request.

An invalid `uiPollIntervalMs: 1` configuration produced an explicit `3 entries did not activate` warning and `expected number >= 1000` validation failure. The Web app still started, its core Session list and both Session views worked, and the history API returned the peer-attributed message. Removing the plugin and restarting the same profile preserved those reads, including the `session-link-message` attribution; the plugin RPC and header action were absent.

The runner closed its browser and server and removed its temporary home. The light, dark, and refresh-error screenshots were visually inspected and showed readable controls with no clipping. Screenshots are under `output/playwright/`: `session-link-light.png`, `session-link-dark.png`, `session-link-refresh-error.png`, and `session-link-invalid-config.png`.

Electron launch, future DSH releases, and live model-driven message exchange were not run by this browser smoke. Non-human peer messages are checked through the history API; the Chat pane displays the ordinary human message in each seeded Session.

</details>
