# Offline storage recovery

Meshrix stores service state below a data root and can create verified backups
for recovery. Restore is an offline operator action: stop the Meshrix runtime
that owns the data root, select one backup by its exact ID, inspect a preview,
then explicitly confirm the apply command. The command calls the same durable
restore implementation used by the platform and does not start the server,
Console, plugins, or storage runtime.

## Select and preview a backup

If backups are held outside the data root, set `MESHRIX_BACKUP_ROOT` to that
existing backup directory in the command environment. When independent backup
custody is required by the deployment, configure
`MESHRIX_REQUIRE_INDEPENDENT_BACKUP_ROOT=1` as well. The selected backup root
must be a real directory outside the data root.

Choose the exact `backup_<timestamp>_<id>` from the backup manifest, then run a
read-only preview against the intended data root:

```sh
meshrix storage restore --data-dir /srv/meshrix/data --backup-id backup_2026-01-01T00-00-00-000Z_example
```

Preview verifies every selected backup file and reports only bounded summary
counts. It does not create a lock, write a receipt, or modify the data root.
Review the backup ID, restore semantics, integrity result, and action counts
before proceeding. Restore replaces governed state by default; secrets and
sealing keys are kept under separate operator custody and are excluded from
backup contents.

## Apply while stopped

Keep the same data root and backup ID used for preview. Confirm the selected
backup only after the runtime is stopped:

```sh
meshrix storage restore --data-dir /srv/meshrix/data --backup-id backup_2026-01-01T00-00-00-000Z_example --apply --confirm
```

Apply acquires the storage maintenance lock, refuses an active runtime lease,
checks backup identity and file integrity again, then commits through the
durable restore transaction. If the backup changes after preview, apply uses
the current manifest and refuses files that no longer match their recorded
size and SHA-256. An active runtime lease returns
`storage_restore_runtime_active`. Re-run preview when selecting another backup
or data root. A
bounded JSON result contains counts and a stable error code; it does not print
local paths, raw manifests, or file contents.

After a successful apply, start Meshrix through its normal supported entry
point. Startup reconciles any interrupted restore transaction before serving
requests. Preserve the independent key material and restore it through its
separate key-custody procedure; a backup intentionally cannot recreate it.

## Recovery semantics

Backup and restore preserve governed files such as authorization grants and
revocations, job records, and the state that indicates whether an external
effect may have completed. Meshrix does not repeat an `uncertain external effect`
as part of restore. Operators must reconcile such effects with their
own upstream system before retrying the associated work.

The durable transaction records enough progress to reconcile an interrupted
restore during the next startup. A process interruption test validates that
software path; it does not establish behavior under host power loss or storage
hardware failure. Keep independent backups, test recovery on a separate data
root, and retain the keys needed to reopen encrypted custody.

This is the first-release recovery contract. Before upgrading a published
installation, retain the original data root and an independently stored
backup, then validate the release's documented restore procedure against a
copy of that data. Restore never deletes the source backup.
