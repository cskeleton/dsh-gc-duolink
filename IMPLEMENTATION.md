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

## Acceptance

- Official DSH runs the plugin without the fork's session-link packages or generated metadata.
- Host behavior tests cover non-human attribution, durable queued/accepted receipts, revocation, cancellation, ordering and wake limits.
- Browser mutations, header and row marks agree with host data; failures keep existing data visible.
- Plugin absence/failure preserves DSH startup and already recorded session input.
- The original checkout files and live Desktop profiles are unchanged by this work.

## Handoff

`DSH_SOURCE_ROOT` optionally selects built checkout declarations for compilation and source aliases for the full host regression tests. Runtime profile installation always uses its own declared peers. README records actual compatibility evidence and cutover commands; switching the user's running profile is separate from isolated verification.
