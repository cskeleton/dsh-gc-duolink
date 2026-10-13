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

The result is written to `output/initial-model-proof-result.json`. Native proof does not prove the packed plugin's tool assembly or Desktop UI.

## Packed initial-model tools

```sh
env -u DSH_SOURCE_ROOT pnpm test:initial-model-installed
```

This runs `INITIAL_MODEL_PROOF_PLUGIN=1 node tests/integration/initial-model-proof.mjs` after a build. The runner packs and installs the plugin with peer auto-installation disabled, then uses the actual scoped tools. Coverage includes catalog, selected/unselected spawn, model/effort validation, strict retired-argument refusal, full-request replay conflicts, grants, unlink, native first/later requests and human model changes. It removes the plugin before restart/resume to check that native model ownership survives removal. All model calls use the fixture provider, never paid providers.

Results go to `output/initial-model-installed-result.json`; the current PASS/FAIL/NOT_RUN is recorded in [../../VERIFICATION.md](../../VERIFICATION.md). The runner removes its disposable profile and closes its own server. It does not migrate existing tracked-task profiles or clean historical user domains.

## Installed Web smoke

The smoke requires the supported `dsh` launcher on PATH, pnpm and a Chromium browser usable by Playwright. If the matching Playwright browser is unavailable, set `BROWSER_EXECUTABLE_PATH`; each run uses a fresh isolated context.

```sh
BROWSER_EXECUTABLE_PATH='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' pnpm test:integration
```

The runner installs the built tarball into a temporary Web profile under its own `DSH_HOME`, with its own npm cache. Profile peers provide DSH runtime services. Two seeded ordinary Sessions include a historical `session-link-message` record to verify readability after removal of its producer.

Browser coverage includes the explicit-confirmation header picker, independent peer/caller wake choices, non-foreground row management without changing the main conversation, owner-bound mutations, polling, reload persistence, Host theme changes, failed refresh/retry and revoke. The fixture's public rename attaches the seeded Agents to materialize projections; this is not a cold-resume test. Formal menu and owner-scoped payload behavior are covered by client tests.

The launch also checks that the five tools are absent from the global tool layer, present under the standard preset and absent under minimal, together with the Session Link command. Concurrent duplicate pair requests must create only one group. After uninstall/restart, both Sessions remain readable. This browser scenario makes no model request.

Screenshots go to `output/playwright/` or `SMOKE_ARTIFACT_DIR`. Authentication URLs stay in memory and are redacted from failure logs. The runner closes its own browser/server and removes its temporary home on success or failure.

This verifies the shared Web surface; it does not launch Electron. Desktop is NOT_RUN for this iteration. Future DSH releases require fresh compatibility checks; current results are in [../../VERIFICATION.md](../../VERIFICATION.md).
