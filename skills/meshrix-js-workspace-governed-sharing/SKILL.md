---
name: meshrix-js-workspace-governed-sharing
description: Guide Meshrix.js workspace asset management and governed sharing, including grants, ACLs, checkpoints, controlled local-directory access, mutation preview, compensation, and unsharing. Use for workspace files, sharing, local-directory sync, checkpoint restore, or Shared Space.
---

# Meshrix.js Workspace Governed Sharing

Read `docs/functionality/WORKSPACE-ASSETS.md`. Keep core workspace sharing distinct from the optional Shared Space local-directory integration.

## Canonical transaction

1. Resolve the workspace, authenticated subject, requested target, and current asset revision.
2. Authorize the operation with Operation Permission, tags, ownership, and workspace governance.
3. For sharing, persist the share Grant before changing the target ACL. If ACL mutation fails, compensate the new Grant.
4. Require both the current Grant and target ACL for subsequent access.
5. For optional local-directory access, bind an explicit mount and allow only list, read, or stat until a mutation preview is approved.
6. Before mutation, validate path, parent chain, symlinks, archive shape, type, and size; capture a mount-scoped CAS preimage and revalidate mount identity and fingerprint immediately before apply.
7. Apply the mutation, then commit state, checkpoint, history, audit metadata, and receipt in that order. On any incomplete stage, mark the transaction incomplete, stop new reads of the candidate revision, restore bytes and domain state from the preimage, and reconcile checkpoint/history/receipt projections idempotently.
8. For unshare, remove the target ACL and close the matching Grant without affecting unrelated recipients. If either half fails, retain an explicit incomplete-unshare record and retry with the same idempotency key until ACL and Grant converge.

## Boundaries and failure semantics

- Core owns workspaces, share Grants, ACL policy, checkpoints, and receipts. The optional plugin owns its adapter and sync behavior, not the host filesystem.
- Missing governance, uncapturable preimages, traversal, symlink escape, executable content, stale fingerprint, or quota overflow fails closed.
- Sharing is complete only when Grant and ACL agree. Mutation is complete only when bytes, state, checkpoint, and receipt agree.
- Evidence contains controlled identifiers and digests, never local paths or raw file content.

## Ownership and routing

Route governed access to `$meshrix-js-operation-permission`, security validation to `$meshrix-js-security-authorization`, canonical object/checkpoint repair to `$meshrix-js-storage-operations`, and closure to `$meshrix-js-regression-planner`.

## Verification

Run `npm test` for the current baseline. Grant/ACL compensation, recipient isolation, path denial, CAS capture, TOCTOU revalidation, full projection restoration, incomplete-unshare reconciliation, quotas, and redacted receipts remain acceptance requirements. Until a catalog-backed workspace-sharing task proves them together, report partial evidence only.
