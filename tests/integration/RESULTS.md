# Shipped-runtime verification

The installed smoke passed on 2026-10-10 against the official `dsh 0.2.0-rc.2` CLI, using the packed `dsh-session-link 0.4.1` artifact and an isolated Brave browser context.

```sh
BROWSER_EXECUTABLE_PATH='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' npm run test:integration
```

The command exited with status 0. It installed a local tarball into a new temporary Web profile and verified that the four tools stay out of the global tool layer, mount in a `standard`-preset Session's scope, and are absent with the command from a newly created `minimal`-preset Session. It also verified that two concurrent link requests for one pair create one group, that a repeated `session/create` with one explicit Session id adopts the same Session, the Session Link command, browser add/wake/revoke operations, a one-second configured polling update, reload persistence, light and dark theme colors, retained content after an HTTP 503 refresh failure, retry recovery, and Host rejection of a self link. It issued no model request.

An invalid `uiPollIntervalMs: 1` configuration produced an explicit `3 entries did not activate` warning and `expected number >= 1000` validation failure. The Web app still started, its core Session list and both Session views worked, and the history API returned the peer-attributed message. Removing the plugin and restarting the same profile preserved those reads, including the `session-link-message` attribution; the plugin RPC and header action were absent.

The runner closed its browser and server and removed its temporary home. The light, dark, and refresh-error screenshots were visually inspected and showed readable controls with no clipping. Screenshots are under `output/playwright/`: `session-link-light.png`, `session-link-dark.png`, `session-link-refresh-error.png`, and `session-link-invalid-config.png`.

Electron launch, future DSH releases, and live model-driven message exchange were not run by this browser smoke. Non-human peer messages are checked through the history API; the Chat pane displays the ordinary human message in each seeded Session.
