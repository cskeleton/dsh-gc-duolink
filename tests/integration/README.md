# Isolated official installation checks

These checks use an installed official `@deepseek-ai/dsh` launcher and disposable homes/profiles. `DSH_BIN` can select a different installed launcher. They do not switch the user's running profile, modify the Host checkout or use a patched task-host. For official SDK builds, remove any source override:

```sh
env -u DSH_SOURCE_ROOT pnpm build
```

## Native initial-model proof

```sh
env -u DSH_SOURCE_ROOT pnpm test:initial-model
```

This command runs focused unit tests, then `initial-model-proof.mjs` without installing Session Link. The fixture exercises native model/selection seeding, first tasks and tool steps, restart before/after responses, and a later human model change. It checks ordinary top-level identity, preset/CWD, matching prompt/request metadata and unchanged application configuration. Caller BASE explicitly selects low effort while B omits effort and advertises a high default; every actual B request must be high, including tool steps and restarts. The official `0.2.0-rc.2` native proof passed with 19 mock model requests and zero paid calls.

The result is written to `output/initial-model-proof-result.json`. Native proof does not prove the linked-directory plugin's tool assembly or Desktop UI.

## Linked-directory initial-model tools

```sh
env -u DSH_SOURCE_ROOT pnpm test:initial-model-installed
```

This runs `INITIAL_MODEL_PROOF_PLUGIN=1 node tests/integration/initial-model-proof.mjs` after a build. The runner packs and installs the plugin with peer auto-installation disabled, then uses the actual scoped tools. Coverage includes catalog, selected/unselected spawn, model/effort validation, strict retired-argument refusal, full-request replay conflicts, grants, unlink, native first/later requests and human model changes. It removes the plugin before restart/resume to check that native model ownership survives removal. All model calls use the fixture provider, never paid providers.

Results go to `output/initial-model-installed-result.json`; the current PASS/FAIL/NOT_RUN is recorded in [../../VERIFICATION.md](../../VERIFICATION.md). The runner removes its disposable profile and closes its own server. It does not migrate existing tracked-task profiles or clean historical user domains.

## Spawn Workspace placement (0.5.3)

```sh
env -u DSH_SOURCE_ROOT pnpm build
env -u DSH_SOURCE_ROOT BROWSER_EXECUTABLE_PATH='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' pnpm test:workspace-installed
```

This extends the linked-directory initial-model proof with actual public Workspace services: omitted cwd under grouped and ungrouped callers, both ordinary and initial-model paths, explicit existing-but-unregistered and nonexistent directories, independent subdirectories, canonical symlink reuse, human detach/replay, and membership after a real Host restart. The browser subscribes before these new spawns occur, then asserts the new Workspace appears without reload, the current conversation stays selected, the spawned Session opens, and the rows persist after reload. Preview acknowledgement is seeded in the disposable overlay so a welcome dialog does not change the configuration-purity baseline.

Evidence: `output/initial-model-installed-result.json` (including `workspaceBrowser`) and `output/playwright-workspace/workspace-live-created.png`. The browser opens the shared shipped Web GUI; it does not install into or control the running Desktop app. All requests use a local mock adapter; no paid calls. The standard linked-directory proof also runs the registry/restart assertions without launching a browser.

## Installed Web smoke

The smoke requires the supported `dsh` launcher on PATH, pnpm and a Chromium browser usable by Playwright. If the matching Playwright browser is unavailable, set `BROWSER_EXECUTABLE_PATH`; each run uses a fresh isolated context.

```sh
BROWSER_EXECUTABLE_PATH='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' pnpm test:integration
```

The runner installs the built directory into a temporary Web profile under its own `DSH_HOME`, with its own npm cache. Profile peers provide DSH runtime services. Two seeded ordinary Sessions include a historical `session-link-message` record to verify readability after removal of its producer.

Browser coverage includes the explicit-confirmation header picker, independent peer/caller wake choices, non-foreground row management without changing the main conversation, owner-bound mutations, polling, reload persistence, Host theme changes, failed refresh/retry and revoke. The fixture's public rename attaches the seeded Agents to materialize projections; this is not a cold-resume test. Formal menu and owner-scoped payload behavior are covered by client tests.

The launch also checks that the five tools are absent from the global tool layer, present under the standard preset and absent under minimal, together with the Session Link command. Concurrent duplicate pair requests must create only one group. M2 covers the linked-directory human cancellation RPC (sender UI action, receiver cancel/repeat, unrelated Session rejection), pending-count refresh, preservation of cancelled tombstones on unlink, and the distinct no-wake-intent message in the panel. The chain-extension scenario imports prior-day receipt history to show 8/8, then opens/cancels/confirms the real native dialog and asserts the linked-directory RPC saves +4 while preserving the separate authorization blocker. The initial-model linked-directory fixture independently spends 8 actual mock wakes, resumes the ninth exactly once and replays the receipt after a real Host restart. After uninstall/restart, both Sessions remain readable. This browser scenario makes no model request.

Screenshots go to `output/playwright/` or `SMOKE_ARTIFACT_DIR`. Authentication URLs stay in memory and are redacted from failure logs. The runner closes its own browser/server and removes its temporary home on success or failure.

This verifies the shared Web surface; it does not launch Electron. Desktop is NOT_RUN for this iteration. Future DSH releases require fresh compatibility checks; current results are in [../../VERIFICATION.md](../../VERIFICATION.md).

## Isolation from the old plugin

Old-package upgrade/migration mode is removed. `SMOKE_UPGRADE_FROM` is explicitly rejected. The runner installs `link:` to the built directory into a disposable profile without generating archives. It seeds an incompatible `session_link.json` and an invalid old `session-link` configuration row. The new `gc-duolink` row still activates, only `gcDuolink/*` RPC succeeds, the old file remains unchanged and a separate `gc_duolink.json` persists a DuoLink ownership marker.

```sh
BROWSER_EXECUTABLE_PATH='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' \
SMOKE_ARTIFACT_DIR="$PWD/output/playwright-isolation" \
pnpm test:integration
```

The full UI scenario includes system-clipboard ID copy, mail, cancellation, wake extension and same-domain recovery/removal checks. It makes no model requests. The installed initial-model proof also links the built directory and exercises mock models only.

Development does not bump versions or generate archives by default. `pnpm test:contracts` runs only built-runtime checks. `pnpm test:pack-release` and `pnpm pack:release` are explicit release operations; do not run them unless release packaging is requested.
