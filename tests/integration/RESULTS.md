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
