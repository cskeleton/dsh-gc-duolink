# Spawn Workspace Placement Execution Plan

Status (2026-10-16): implementation and tests complete. Delivery uses `output/0.5.3/`; final archive verification is recorded in its `delivery-manifest.json` and `SHA256SUMS`.

## Goal

Deliver 0.5.3: omitted `cwd` inherits the caller's directory and Workspace (including Ungrouped); explicit `cwd` creates or reuses that directory's Workspace and publishes the new top-level Session to Desktop/Web.

## Context

Both spawn paths currently call native Session Controller with `cwd` only. GUI groups by explicit Workspace membership. Public `workspaceRegistry.create(path)` reuses canonical paths; `Workspace.attachSession` validates canonical cwd, persists membership, and publishes domain changes to the existing GUI stream.

## Constraints

- Current branch; retain existing work. No commits, push, user-profile installation, app restart, or Host changes.
- Keep initial native model seeding, grants, wake budgets, legacy replay, and first-task identity intact.
- A subdirectory gets its own Workspace, never its parent's. Do not change the caller's membership or selected GUI conversation.
- Persist placement intent and completion. A completed replay must not undo human Workspace removal/detachment. Pending placement retries reuse the recorded Workspace identity; deletion is an explicit error.

## Implementation

### Task 1: Spawn behavior and durable placement

**Relevant files:** `src/tools.ts`, `src/model-spawn.ts`, `src/link.ts`, `src/spec.ts`.

Make `cwd` optional; resolve omission from the actual caller header and fail before creation if unavailable/invalid. Include inherited-versus-explicit semantics in same-call conflict detection, preserving old explicit initial-model digests. After creation/link and before task admission, use the public Workspace API to resolve inherited membership or create/reuse the explicit directory's Workspace. Save the target before attachment and completion afterward in the existing serialized spawn ledger. Do not backfill old completed calls on replay. Placement failures keep the Session/link, report their identities, and admit no task.

**Verification:** tool integration regressions and real published Workspace service tests for inheritance, unknown/new directories, exact canonical matching, failure/retry, human edits, legacy calls, and same-call races.

### Task 2: Installed runtime and GUI proof

**Depends on:** Task 1.

Extend the installed packed-plugin proof with real registry/membership checks, restart/replay checks, and an isolated browser check showing a newly registered directory and spawned Session through the shipped GUI. Keep all data in temporary DSH_HOME and use a mock provider only.

**Verification:** installed native/packed proofs; browser assertion and screenshot from the isolated profile. No changes to the running Desktop profile.

### Task 3: Versioned delivery

**Depends on:** Tasks 1–2.

Bump 0.5.2 → 0.5.3; update both READMEs and current verification record. Build using installed official development peers, run the relevant existing regression commands and new checks, and use `pnpm pack:release` for the final archive/checksum/manifest. Preserve prior versioned archives.

## Integration / Final Verification

- `env -u DSH_SOURCE_ROOT pnpm build` and relevant Vitest suites.
- Source-testkit Host regression with explicit `DSH_SOURCE_ROOT` (auxiliary evidence only).
- Installed native/packed initial-model proof, extended with Workspace placement checks.
- Isolated browser verification for Workspace and Session visibility.
- Built contracts and `pnpm pack:release`; inspect the actual final archive and SHA256.

## Acceptance Criteria

- Omitted cwd produces a peer in the caller's Workspace, or Ungrouped if the caller is ungrouped.
- Explicit existing, unregistered, nonexistent, symlinked, and child directories resolve to the exact intended Workspace.
- Ordinary and initial-model paths share placement; task delivery starts only after placement succeeds.
- Retry does not duplicate the Session/task, move it after success, or recreate a deleted recorded Workspace.
- 0.5.3 archive and verification evidence exist; limitations are reported accurately.

## Handoff Notes

Historical ungrouped Sessions are outside this migration. Desktop Electron itself remains untouched; the isolated shipped Web GUI exercises the same Workspace controller and browser grouping logic.
