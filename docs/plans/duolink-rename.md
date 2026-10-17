# DuoLink Rename and Copy Session ID Execution Plan

Historical plan. Its old-compatibility and migration decisions are superseded by [DuoLink namespace isolation](duolink-isolation.md). The old directory symlink has been removed; do not follow the old upgrade steps below.

Local implementation and isolated validation completed on 2026-10-18. GitHub rename and origin update completed on 2026-10-18 after explicit approval. Actual profile migration remains unexecuted. Version 0.6.1 makes English the default `README.md` with Chinese in `README.zh.md`; 0.6.0 runtime behavior remains unchanged. Current evidence is in `VERIFICATION.md`.

## Goal

Deliver `dsh-gc-duolink` 0.6.0 (DuoLink · 会话互联) with the Session-row Copy Session ID utility. Keep the standalone copy plugin intact.

## Context

A compatibility symlink at the old directory name preserves the Desktop profile's existing 0.5.3 tarball source path without changing that profile.

The former package is `dsh-session-link` 0.5.3. Both plugins already contribute to `sidebar.workspaces.session.menu.item`. The checkout has pre-existing uncommitted changes, and its origin is `https://github.com/cskeleton/dsh-session-link.git`.

## Constraints

- Preserve the complete working tree, `.git`, current `master` branch, commits and tags. No commit, push, new branch, worktree or profile installation.
- Preserve `session_link` v1, `sessionLinks` RPC, message attribution, tool names, `/session-link`, command definition identity and persisted metadata.
- Keep old release archives and historical validation records unchanged.
- Do not modify `dsh-client-ui-copy-session-id`.
- GitHub rename and origin update were explicitly approved and completed on the existing repository; no replacement repository was created.

## Implementation

### Task 1: Rename package and local directory

**Objective**: Move the existing checkout to `dsh-gc-duolink`, retaining `.git` and local changes; update package, Cordis module names, browser loader identity, package-owned UI IDs, current documentation and isolated installation checks.

**Relevant files**: `package.json`, `cordis.patch.yml`, `tsdown.config.ts`, `src/client/index.tsx`, `README.md`, `README.zh.md`, `tests/built-contract.test.mjs`, `tests/integration/*.mjs`.

**Depends on**: None.

**Verification**: Build/typecheck, package export checks, unchanged HEAD/branch, no changes to the standalone copy plugin, preserved baseline files.

**Done when**: The new package builds and loads under its own identity while keeping durable contracts.

### Task 2: Merge the copy utility

**Objective**: Register a separate menu row at order 500. Copy the clicked row's full ID independently of link membership, close on success, retain the menu with an error on failure. Retain the old clipboard fallback and clean up temporary DOM/focus.

**Relevant files**: `src/client/CopySessionIdMenu.tsx`, `src/client/index.tsx`, `src/client/locales.ts`, `tests/client-copy-session-id.spec.tsx`.

**Depends on**: Task 1 package identity.

**Verification**: Clipboard success, unavailable/denied API fallback, rejected fallback with visible error and retry, cleanup/focus; real installed browser menu and clipboard round trip.

**Done when**: The copied value equals the clicked Session ID, without Host calls or changing the current conversation.

## Integration / Final Verification

Run the existing client suite, typecheck/build, built contracts, and a packed install into an isolated temporary DSH profile using the existing browser proof. Record the exact validation and create a fresh 0.6.0 archive with `pnpm pack:release`.

## Acceptance Criteria

- New directory and package are `dsh-gc-duolink`; existing copy-plugin directory remains intact.
- Copy succeeds from the actual Session menu; failures are visible and retryable.
- Existing durable data, tools and command remain compatible.
- A usable local archive and bilingual upgrade instructions exist.
- GitHub rename/origin update and user profile migration are clearly distinguished from completed local work.

## Handoff Notes

Upgrade from the old package requires a controlled identity replacement: back up existing plugin settings, stop the relevant runtime, remove the old bundle, install the new archive, and restore custom configuration. Never enable both service packages together. Retaining the old copy-plugin source is safe; enabling it alongside DuoLink would duplicate the copy menu.

Completed GitHub action: renamed the existing `cskeleton/dsh-session-link` repository to `dsh-gc-duolink` and updated origin with `git remote set-url origin https://github.com/cskeleton/dsh-gc-duolink.git`. The repository node ID stayed `R_kgDOVD0Qpw`; branch, history, issues, tags and releases remain on that repository, without history rewrite. Do not reuse the former repository name, which would break redirects. See https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository.
