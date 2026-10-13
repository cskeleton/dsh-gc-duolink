# dsh-session-link

English | [简体中文](README.md)

An independent Session Link plugin for DeepSeek Harness. Version 0.5.0 preserves peer links, the durable mailbox, automatic wake grants, commands and UI, and adds **initial model selection for newly created Sessions**. It uses public APIs in official DSH `0.2.0-rc.2`, without modifying the Host.

## Usage

Click **Links** in the Session header, find a peer, confirm the wake settings in both directions, and create the link. The right panel opens peers, changes wake settings and confirms unlinking. The sidebar's right-hand chain action and `… → Session links…` manage the clicked Session without switching the main conversation. Chain color indicates membership only, independently of execution and wake state.

Two-member groups show “My messages → wake peer” and “Peer messages → wake me.” Larger groups grant wake permission per receiving member; that setting applies to every sender in the group. Both switches default to on for a new UI link and require confirmation. Existing groups and human-disabled switches receive no additional grants. Only existing, unarchived ordinary top-level Sessions can link. Duplicate Session pairs are rejected within the serialized admission queue.

Messages carry non-human peer attribution. They share message text, not model history or permissions. A running peer receives a follow-up; an idle peer without a wake grant retains mail durably until its next turn. Automatic wakes obey daily, per-message and reply-chain budgets.

```text
/session-link list
/session-link add <peer-session-id> [wake]
/session-link wake <peer-session-id> on|off
/session-link revoke <link-id>
```

Five tools are available to the model:

- `session_list_links`: list links and reachable peers.
- `session_send_session_message`: send or reply with `in_reply_to`; self-send and model selection are rejected.
- `session_cancel_session_message`: cancel mail not yet inserted into the peer's Session.
- `session_spawn_linked_session`: create an ordinary Session, link it and deliver its initial task; optionally select its initial model.
- `session_list_models`: query deployed provider/model/effort metadata, optionally filtered by `provider`.

Tools and commands mount in eligible top-level Agents' preset scopes, never globally. Omitting `presets` includes `standard`, `ptc`, `cordis` and the public registry's eligible effective default. An explicit list is an exact allowlist; an empty list disables mounting. Minimal and child Agents are excluded; archived Sessions cannot invoke these tools. Eligibility is checked at Agent creation and preset changes. Changing the default alone does not remount existing Agents.

## Initial model selection

Query `session_list_models`, then pass an optional strict object to spawn:

```json
{
  "cwd": "/absolute/path/project",
  "task": "A complete, self-contained task description",
  "initial_model": {
    "provider": "provider ID from the catalog",
    "model": "model ID belonging to that provider",
    "reasoning_effort": "effort ID supported by that exact model"
  }
}
```

Provider and model are required non-empty strings. Effort is optional: omission uses the selected model's own default, rather than the caller's effort. Extra nested fields are rejected. Without `initial_model`, spawn uses the original create/link/delivery flow. All spawn modes share a per-call concurrency lock: conflicting concurrent parameters return `SPAWN_REPLAY_CONFLICT`; ordinary completed-call replay retains its previous compatibility rules. Catalog membership is metadata, not proof of authentication or execution success.

The plugin writes the existing native `model/selection` event into the new Session and confirms durability before activation and task delivery. Native Session Controller owns subsequent requests and recovery. The choice persists across turns; later human model changes in the native UI take precedence. Spawn does not change the application default, override runtime selection, provide temporary task routes, perform fallback or rerun model failures.

The first spawn result text retains its original format. A second text block carries version 1 `session-link/initial-model` metadata. The turn card labels it **Initial session model**, not the current model or evidence of successful execution. `queued` and `accepted` are delivery states only.

Replay reuses the original Session, link and task message. Selected spawn hashes the complete normalized request; changes to the model, full task, directory, title or grants are rejected. Replay cannot add or remove `initial_model`. An existing ID with unconfirmed ownership is never adopted, repaired or activated. A crash after Session creation but before ownership confirmation can leave an empty orphan Session; the error requests human inspection, and the plugin neither overwrites nor deletes it. Unlinked groups are never revived by replay.

Old top-level `provider`, `model`, `reasoning_effort`, `model_scope` and `on_model_unavailable` arguments are explicitly rejected. Send also rejects `initial_model`. Task decisions (`session_get_task`, `session_resolve_task`), task panels/cards and the `./tasks` export are retired.

## Delivery and wakes

- `queued` means durably stored in the mailbox; `accepted` means inserted into the target and successfully flushed. Neither means processed or completed. A delivery failure after storage stays queued; retry delivers the same message.
- A send error means the message was not stored, was cancelled before insertion, or names a blocked legacy report. It will not later be newly delivered. Cancellation after insertion cannot recall it; failed flushes retain receipt recovery. Each target receives mail in durable admission order.
- Idempotency keys commit with their messages. Cancelled, failed and revoked keys return `MESSAGE_UNDELIVERABLE`. Replies must name a message received by this Session. Reply-chain budgets span groups.
- Spawn owes its initial task one budgeted wake. `auto_awake` controls later messages and defaults to false. `wake_caller` defaults to `auto_awake` and can be set independently. The initial task does not add a return-direction grant. Replay preserves the original grants.
- UI/command links carry human grants; spawn links carry Session grants. Unlinking blocks undelivered mail but cannot retract inserted input. Unload refuses new operations, waits for in-flight operations and then closes storage.

## Installation

Build and pack first. Preset-registry and session-persistence are optional peers: ordinary tools can mount without them; selected spawn explicitly refuses missing public bootstrap services. Runtime peers resolve from the target profile. Disable peer auto-installation to avoid a second Host dependency tree.

```sh
pnpm install --frozen-lockfile
env -u DSH_SOURCE_ROOT pnpm build
pnpm pack
```

For Web and other ordinary profiles:

```sh
dsh plugin --profile web add --ignore-scripts --config.auto-install-peers=false /absolute/path/dsh-session-link-0.5.0.tgz
```

Electron exclusively manages Desktop profiles. Open Desktop once to initialize its profile, then quit it completely and use the bundled CLI:

```sh
DESKTOP_DSH='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
"$DESKTOP_DSH" plugin --profile desktop add --ignore-scripts --config.auto-install-peers=false /absolute/path/dsh-session-link-0.5.0.tgz
```

Reopen the application afterward. Do not perform package operations while Desktop is running. The Plugins page can inspect, enable and disable the bundle. The final argument can also be `link:/absolute/path/dsh-session-link` for a built local directory. Build and isolated checks do not switch an existing profile.

### Upgrading from 0.4.1

The ordinary peer-link 0.4.1 release can be replaced using the same `add` command, without uninstalling first. Link records and historical messages remain. Quit Desktop completely before updating and reopen it afterward.

The experimental task-routing line also used version 0.4.1, so version alone does not establish compatibility. If you used top-level model arguments, task scope, fallback or task decision tools, inspect the profile's experimental data before replacing it. These profiles have no automatic migration or downgrade path.

If a fork embeds the same service, disable its old service, UI and preset tool/command rows before switching to the external plugin as the sole implementation. Legacy reports carrying `statusKind` or `taskStatus` remain stored but cannot deliver or wake; explicit replay returns `LEGACY_TASK_MESSAGE_BLOCKED`. This guard does not cover unmarked task mail or Host-specific events; inspect those before cutover. Historical domains are not automatically cleared.

Uninstall Web with `dsh plugin --profile web remove dsh-session-link`; for Desktop, quit first and use `"$DESKTOP_DSH" plugin --profile desktop remove dsh-session-link`. Removal retains Session history and `session_link` data; it does not restore an old model or undo human native choices.

## Configuration

A profile's `cordis.patch.yml` can override configuration. A patch replaces the whole row configuration, so restate custom values you want to retain.

```yaml
- id: session-link
  config:
    uiPollIntervalMs: 30000
    maxLinkMembers: 8
    maxPendingPerTarget: 16
    maxMessageBytes: 16384
    maxAutoWakesPerSessionPerDay: 6
    maxAutoWakesPerMessage: 1
    maxAutoWakesPerChain: 4
    maxDeliveryAttempts: 3
```

For custom presets, configure both tool and command rows:

```yaml
- id: tool-session-link
  config:
    presets: [standard, ptc, cordis, coding, my-custom-preset]
- id: command-session-link
  config:
    presets: [standard, ptc, cordis, coding, my-custom-preset]
```

The poll interval is 1000–2147483647 milliseconds. UI consumers share the Host view, poll while subscribed and refresh after confirmed writes or connection resets. Failures retain the last data and expose retry.

## Development and verification

Official npm `0.2.0-rc.2` SDK packages are the default. No source checkout or task-host extension is required.

```sh
env -u DSH_SOURCE_ROOT pnpm typecheck
env -u DSH_SOURCE_ROOT pnpm build
env -u DSH_SOURCE_ROOT pnpm test
```

The default test command runs client tests, initial-model unit tests, native proof, packed tools integration and built contracts; build first. The official native proof makes 19 mock requests; packed tools make 30, with zero paid calls. Client 56, initial-model 55 and contracts 3 pass; the separately run auxiliary Host suite passes 120 checks. Browser evidence and precise boundaries are in [VERIFICATION.md](VERIFICATION.md).

```sh
BROWSER_EXECUTABLE_PATH='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' pnpm test:integration
```

Installation checks use disposable homes/profiles, without changing the user's running instance. See [integration documentation](tests/integration/README.md). `DSH_SOURCE_ROOT=/absolute/path/deepseek-harness pnpm test:host` runs the original four auxiliary Host suites. Source declarations can aid development but do not replace official SDK and packed installation evidence.

## Compatibility and limitations

Domain `session_link` remains version 1 with three tables and `session-link-message` attribution. The optional ledger map `initialModelSpawns` records complete request digests, `headerCreated` and `seedConfirmed`; old missing fields read as empty. No new task domain or Session log format is required. Initialization uses native events without an additional runtime model owner.

The browser loads only React, JSX runtime and ReactDOM from the frozen module table. Controls, styles, parsing, state and translations are local to the package. Public services expose Remote methods; there are no generated `./typert`/`./remote` entries or Host allowlist changes. The turn-tail card depends on optional `uiConversation`; other UI remains available without it.

Stopping an Agent clears its inbox, so delivered does not mean read; rely on the peer's reply. Mail and ledgers have no automatic cleanup. Unload waits for in-flight work without a timeout. Electron and paid remote-model execution have not been verified; future Host releases require fresh checks.

The user reported preliminary 0.5.0 testing passed, without specifying the environment or coverage. This does not extend the Electron or paid-model verification claims.

Old routing plans, reviews and the roadmap remain marked as retired historical evidence. Version 0.5.0 replaces the experiment with forward source changes and preserves Git history. Old extensions in the separate DSH repository are neither current dependencies nor reverted by this plugin commit. See the [architecture and history decision](docs/decisions/001-plugin-only-initial-model.md).
