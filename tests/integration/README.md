# Installed Web smoke

Build the plugin, then run `npm run test:integration`. The smoke requires the supported `dsh` launcher on `PATH`, `pnpm`, and a Chromium browser usable by Playwright. `DSH_BIN` can select a different installed launcher. If the matching Playwright browser is unavailable, set `BROWSER_EXECUTABLE_PATH` to an existing Chromium executable; the browser always receives a fresh isolated context.

```sh
npm run build
BROWSER_EXECUTABLE_PATH='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' npm run test:integration
```

The runner packs the built artifact and installs that tarball with `dsh plugin` into a temporary Web profile under its own `DSH_HOME`. Peer auto-installation is disabled so the profile uses the launched installation's DSH services. Runtime dependencies still install normally. It seeds two closed ordinary Sessions using the shipped JSONL persistence API used by the repository's Web scaffold; one carries a `session-link-message` source to check history reads after removal of its producer. It then launches the actual Web app through the supported profile CLI. It changes no existing profile, running instance, repository branch, or user Session.

The browser adds a link, changes wake flags, observes a background mutation through polling, reloads persisted links, switches the Host theme, handles a failed refresh and retry, and revokes the link. The same launch checks that the four tools stay out of the global tool layer, mount in a `standard`-preset Session, and, together with the Session Link command, are absent from a `minimal`-preset Session it creates. It also sends two concurrent link requests for one pair and expects one group. It then removes the installed bundle, restarts the same profile, and reads both Sessions again. This scenario issues no model request. Screenshots go to `output/playwright/`, or `SMOKE_ARTIFACT_DIR` when supplied; authentication URLs stay in memory and are redacted from failure logs. The runner closes its own browser and server and removes its temporary home on success or failure.

This verifies the browser surface shared with Desktop. It does not launch Electron or measure compatibility with future DSH releases.
