# DuoLink namespace isolation

Date: 2026-10-18. This decision supersedes the old-compatibility portions of `duolink-rename.md` and earlier verification records.

## Goal

Use `dsh-gc-duolink` as an independent plugin with no old configuration, storage or protocol compatibility. Keep the version unchanged and create no archives while details are being refined.

## Interfaces

| Surface | Current identity |
|---|---|
| Bundle configuration file | `gc-duolink.patch.yml` |
| Configuration rows | `gc-duolink`, `tool-gc-duolink`, `command-gc-duolink` |
| Service / RPC | `gcDuolink`, `gcDuolink/*` |
| Storage domain / default JSON file | `gc_duolink`, `$DSH_HOME/storages/gc_duolink.json` |
| Command | `/gc-duolink` |
| Tools | `gc_duolink_list_links`, `gc_duolink_send_message`, `gc_duolink_cancel_message`, `gc_duolink_spawn_session`, `gc_duolink_list_models` |
| Message attribution / generated IDs | `gc-duolink-message`, `gc-duolink-*` |
| Initial-model metadata / transcript node | `gc-duolink/initial-model`, `gc-duolink-created` |
| Locale / sidebar tab kind | `gcDuolink` |
| CSS / DOM markers | `gcdl-*`, `data-gc-duolink-*` |

The DSH-owned profile `cordis.patch.yml` remains shared, but only the new row IDs configure DuoLink. There are no old-name aliases or storage fallbacks. Existing records are not imported, renamed, copied or deleted. The old directory compatibility symlink is removed. Existing old-profile dependency specs are not rewritten automatically.

## Storage ownership

The new domain has its own format version 1. A product marker and initialized flag are explicitly persisted through `domain.global.set`; the Host's `global.initial` does not write to disk. Existing nonempty data without an initialized DuoLink marker is rejected. Foreign product markers also fail schema validation. This prevents accidentally adopting old storage after someone copies/renames a file.

The old idempotency-ledger lookup and field are removed; the current message record owns its idempotency key. Strict ledger decoding rejects the old field. Pending-mail recovery, durable receipts and wake-budget preservation inside the new domain remain necessary restart behavior. Defensive blocking of unsupported task-report payloads is retained; it is not an old-data import path.

## Implementation and verification

Source, client RPC, tools, command registration, schema, bundle manifest and focused tests share the new identities. Host tests check old-domain isolation, rejected copied/unmarked storage, durable marker writes and unchanged peer-message behavior. Browser smoke includes an invalid old configuration row and an unrelated old storage file, then verifies the new UI/RPC, unchanged old file and separate new file. Installed initial-model proof uses the new tools and metadata.

Integration defaults use `link:` to a built directory in a disposable DSH profile. They do not run `npm pack`. Default contract checks exclude the explicit release-packing test. No actual user profile, version number, historical archive, Git branch or remote is changed for this task. Current evidence belongs in `VERIFICATION.md`.
