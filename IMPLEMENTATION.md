# Session Link external plugin — 0.5.0

## Scope

Ship one independently installable plugin for official DSH `0.2.0-rc.2`. Preserve the original UI, grants, durable peer mailbox, wake budgets, human command and four tools. Add `session_list_models` and optional `initial_model` on `session_spawn_linked_session` only.

Task routing, temporary model scopes, fallback, task decisions, task status notifications, task RPC/panel/cards and the `./tasks` export are removed. Historical plans and reviews remain evidence of cancelled scope, not implementation requirements.

## Existing invariants

- Keep `session_link` domain version 1, its three tables and `session-link-message` attribution. Mailbox ordering, receipt-based accepted acknowledgement, cancellation-before-insertion, idempotency, unlink and recovery retain their original semantics.
- Tools and commands mount under qualified top-level Agent scopes. Omitted presets include standard/ptc/cordis and the effective default; explicit lists are exact. Minimal and child Agents remain excluded.
- Header picker, right hover action, formal row menu, owner-bound management panel and turn-tail linked-spawn card share the link view. UI writes are gated; polling failures retain last known data. No Host DOM interception.
- Human links and spawn links keep their respective grants. Wake flags are receiving-member permissions, separate from membership and running state. Existing human choices never receive replay-time expansion. Spawn's budgeted first-task wake and optional return wake remain intact.

## Initial model contract

`session_list_models` reads the deployment's public provider/model/effort catalog, optionally filtered by provider. `initialModelSelection` reports public bootstrap capability. Catalog presence is metadata, not authentication or successful execution.

Spawn accepts only `initial_model: { provider, model, reasoning_effort? }`. Provider/model are required non-empty strings; effort is validated against that exact model. Omission uses the selected model's own default, not the caller's effort. Extra nested fields and retired top-level provider/model/reasoning_effort/model_scope/on_model_unavailable are rejected. Send accepts no model selection. Unselected spawn uses the original path.

## Bootstrap and recovery

1. Validate public catalog and bootstrap services before creating the selected Session. Resolve the native preset and derive a deterministic Session ID from caller and call ID.
2. Reserve a ledger `initialModelSpawns` intent keyed by caller/call ID. Hash the full normalized request, including the entire task, Session identity, CWD, title, wake grants and selection. Changed replay parameters, including adding/removing selection, fail explicitly. Concurrent same-key requests share one operation; conflicting payloads fail.
3. Create the native Session header and durably confirm `headerCreated`. Prepare a detached ordinary top-level Session, append the existing native `model/selection` event, persist/flush/close, then reopen and verify before confirming `seedConfirmed`.
4. Activate via the native Session Controller with the recorded identity/preset/CWD. Only after the confirmed seed is consumed does the original link/title/task delivery path run.
5. Replay a confirmed seed by verifying the original fact, never by writing a new model choice. Later request headers, turns and human UI selections remain native-owned. A revoked link is not recreated. An existing or altered unconfirmed identity is refused, without automatic repair or activation.

The optional ledger map records creation facts, not a second runtime model state machine. It does not change the application default, intercept model requests or provide fallback. Failures report the bootstrap stage and known Session identity/state; retained partial data is not described as successful dispatch.

## Presentation

The legacy spawn first text block remains unchanged. A second versioned `session-link/initial-model` sidecar exposes configured provider/model/optional effort. The turn projection pairs successful spawn calls/results and retains the original turn cutoff. Invalid metadata does not suppress a valid legacy card. Cards label it “Initial session model” / “初始会话模型”; they do not assert the current model or execution success. Queued/accepted remain delivery-only facts.

Client runtime dependencies stay within the existing React/ReactDOM browser module set; protocol parsing is local. No task RPC or generated Remote metadata is needed.

## Verification and handoff

Use `env -u DSH_SOURCE_ROOT pnpm typecheck`, `pnpm build` and `pnpm test` against official npm SDK packages. `test:initial-model` runs focused parser/catalog/bootstrap tests and an isolated official native proof. The native proof passed with 19 mock requests and zero paid calls; this proves the public native route, not the packed plugin or Electron UI.

`test:initial-model-installed` installs the packed plugin into a temporary official profile and exercises actual tools, native requests, replay/refusal and removal/restart. `test:integration` separately verifies packed Web installation and browser UI. Current results and limitations belong in `VERIFICATION.md`; do not infer PASS from planned coverage. Desktop Electron has not been tested this iteration.

`DSH_SOURCE_ROOT` supports only optional development declarations and the four original auxiliary Host suites (link, remote, tools, command). No patched task-host is required. Runtime installation resolves declared peers from its own profile.

The user's running profile and Host remain unchanged. Do not automatically migrate/downgrade tracked-task experiment profiles or clean historical storage domains. A live cutover requires its own explicit authorization and compatibility assessment.

## Review follow-up

Legacy `statusKind` / `taskStatus` metadata survives schema decoding. Marked pending reports remain stored and are excluded from delivery queues, startup recovery, wake triggers and explicit idempotency replay; ordinary messages continue to deliver. This does not make unmarked experimental task mail or Host-exclusive events safe to downgrade: profile inspection remains required.

Preset-registry and session-persistence peers are optional. Ordinary spawn shares the common flight lock but keeps its normal completed-replay contract; concurrent changed parameters use the generic SPAWN_REPLAY_CONFLICT error. Ownership-uncertain collisions explicitly describe possible empty orphan Sessions and human inspection. The official request fixtures set caller BASE to explicit low effort and B's model default to high, while B omits effort, proving non-inheritance across first/tool/later requests and restarts.

## History and release documentation

[ADR-001](docs/decisions/001-plugin-only-initial-model.md) records the forward replacement of the 19 experimental commits after 42abec4. Historical plans and review evidence are retained and labeled superseded. The separate DSH working tree remains unchanged; its uncommitted Host extension is neither a 0.5.0 dependency nor covered by this plugin commit. [中文 README](README.md) and [English README](README.en.md) describe the same current contract and distinguish ordinary versus experimental 0.4.1 upgrades. The user reported preliminary testing passed without specifying platform or coverage; automated verification boundaries remain unchanged.
