# Session Link external plugin

## Goal

Ship one independently installable `dsh-session-link` package, preserving durable peer messaging, four model tools, the human command, and desktop/web controls without adding code to DSH.

## Constraints

The existing checkout and live profiles remain intact. Keep storage domain `session_link` version 1 and message attribution `session-link-message`. Resolve host packages from profile peers. Browser modules import only React and ReactDOM at runtime. Do not depend on generated Remote packages or the remote-event allowlist.

## Implementation

1. Copy the current service, tools, command and their behavior tests into this package. Keep grant checks, mailbox ordering, receipt-based acknowledgement and cancellation. Correct exposed top-level caller and recovery invariants.
2. Bind decorated Remote methods through service-derived dispatch. Keep `request` argument names unminified. Add a plugin-owned `view` containing links and session candidates, plus the configured polling interval.
3. Rewrite UI controls under the four existing slots with local styles and locale dictionaries. Share one read-only view; refresh after acknowledged writes, reset and polling. Cancel subscriptions, timers and stale reads on unload.
4. Verify focused behavior tests, built endpoint argument names, declared peers/exports and browser module imports. Install a packed artifact in a temporary official DSH profile and exercise real browser add/wake/revoke flows.

5. (0.3.0) Mount tools and the command per preset into top-level Agent scopes through a child plugin under `agent.ctx`, following `agent-preset/selected` and row unload. Give the spawn tool's initial task one budgeted wake, link before rename and delivery, validate the calling Session, reject duplicate pairs inside the admission chain, and gate repeated UI writes.

## Approved UI / wake update (0.4.1 workspace)

- Omitted `presets` selects standard/ptc/cordis plus public registry `defaultId` (effective selectedDefault fallback); explicit lists, including empty, remain exact. Always exclude minimal and child-owned Agents. Clear Schemastery's implicit array default to preserve omission. Re-evaluate on existing Agent/preset lifecycle events, without inventing a default-change event.
- Remove the leading mark entirely. Register right-side hover action and formal `…` menu through workspace slots. Store the managed row's Session id in typed sidebar-right navigation params; bind mutations to that id, not the visible conversation. No DOM interception or Host modification.
- Reuse one searchable, explicit-confirmation picker in the header and panel. Show separate visible wake directions and budget cost; membership and execution state are independent. Multi-member groups use receiving-member terminology.
- New spawn `wake_caller` defaults to `auto_awake`; explicit false opts out. Human link requests have optional `autoWakeCaller` (omission preserves legacy false); human wake RPC can edit the caller's own receiving flag. Existing groups and human-disabled flags never change on replay.
- Persist the original new spawn intent's optional `autoWakeSessionIds` before its group write. Recovery uses these original grants, not replay arguments. Legacy incomplete intents recover with no later-wake grants; the existing owed-first-task wake remains. Storage version stays 1.
- Host tests cover return wake with the real ToolRuntime/mock model and storage-failure replay; browser smoke uses a packed artifact, isolated profile/npm cache, and non-foreground peer row management. The browser fixture's rename materializes Host projections and attaches its peer; cold-catalog non-activation is covered by host regression, not inferred from that browser fixture. No live profile or model call is required.

## Acceptance

- Official DSH runs the plugin without the fork's session-link packages or generated metadata.
- Host behavior tests cover non-human attribution, durable queued/accepted receipts, revocation, cancellation, ordering and wake limits.
- Browser mutations, header and row marks agree with host data; failures keep existing data visible.
- Plugin absence/failure preserves DSH startup and already recorded session input.
- The original checkout files and live Desktop profiles are unchanged by this work.

## Handoff

`DSH_SOURCE_ROOT` optionally selects built checkout declarations for compilation and source aliases for the full host regression tests. Runtime profile installation always uses its own declared peers. README records actual compatibility evidence and cutover commands; switching the user's running profile is separate from isolated verification.

## Model-routing presentation milestone (0.4.1 workspace, LL task 6)

- **Tool output**: tracked spawn/send keep the legacy first text segment byte-identical (`session … created and linked (…)` / `message … accepted by …`); a second text block carries the tracked-task facts (state, scope, requested-vs-selected route, inspect/decision pointers) followed by a versioned `session-link/task-result` JSON line. needs_decision results whose precheck failed before a Session existed omit `sessionId`/`linkId` and the card renders no fake session jump. Spawn/send descriptions now document the pairing rule, the task-scope default, the 4-fallback cap, session_default activation-time resolution and exhaustion behavior, so the model never guesses.
- **Client turn projection**: the existing first-segment pattern stays the ONLY feed for the legacy spawn card (old logs replay unchanged); the new sidecar is narrowed from later text blocks only. The TurnCard renders three additional shapes — admitted (requested vs selected with a temporary/persistent scope label, acceptance framed as delivery-only), needs_decision without a Session (waiting statement + inspect hint, never a session jump), and session-scope labels shown persistently only once persistence is factual (`persistent_selection_skipped` surfaces as an honest "not persisted" note in the panel).
- **Task view carrier**: one read-only `sessionLinks/taskView` Remote on the existing Typert bridge (same `request` argument convention; built-contract updated) filters tasks server-side by the managed Session; the panel polls it with the same keep-last-known pattern the link view uses. Cards stay static transcript facts; no new namespace, no generated metadata.
- **Task-status attribution**: `session-task-status` mailbox messages carry body-framing ONLY today — the report body itself states it is a host-generated fact, never the peer Agent's own words and never an instruction; no transcript badge ships (a badge awaits a host message-attribution seat).
- **Docs**: README gained the tracked-task section (boundary, scope/persist CAS, fallback order + exhaustion → waiting_decision + notification, notification delivery without wake guarantee, partial never re-run / TASK_NOT_RESUMABLE today, minimum host capability and old-host refusal) plus panel/card description updates.
