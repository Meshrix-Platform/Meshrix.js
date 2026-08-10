# What's Next: One Functional Candidate

This document is the product-level priority index for Meshrix.js. The only
current outcome is one **enterprise single-node functional candidate**. It is
not a release publication, environment support statement, execution receipt,
or replacement for the machine-readable local Plan in `docs/plans/`.

The candidate contains Linux amd64 and arm64 offline artifacts, but accepting
it does not by itself establish native Linux, cloud, macOS, Windows, connector,
cross-host, or independent recovery-environment support.

## Four mandatory workstreams

The workstreams are parts of one candidate, not competing product priorities.
After the candidate identity and receipt graph are frozen, delivery, plugin
isolation, and offline transfer may proceed independently. Functional
acceptance consumes their exact same-candidate final receipts.

| Workstream | Required closure |
| --- | --- |
| Enterprise Single-Node Delivery | First governed MCP-to-upstream call; denial, revocation, replay, cancellation, and uncertainty; privacy-safe diagnostics; emergency administration and key lifecycle; independent backup and clean-root restore; N-1 upgrade and failed rollback; named capacity envelopes. |
| Plugin Console Isolation | Register plugin verification in the unified registry; migrate the public contribution contract; run third-party Console UI in an opaque-origin iframe; expose only a bounded, revocable MessageChannel bridge; delete the same-origin dynamic-import path and pass browser escape tests. |
| Cross-System Offline Transfer | Export candidate-bound Linux amd64 and arm64 OCI layouts with complete inventory, SBOM, provenance, signatures, digests, and instructions; transfer the exact bytes to a disconnected target; verify, import, start, execute the first governed call, stop, and clean up without rebuilding. |
| Functional Release Acceptance | Consume only the current delivery, plugin-isolation, and offline-transfer receipts; reject missing, stale, rebuilt, substituted, replayed, or cross-candidate evidence; run the Functional Release Gate exactly once. |

The release root then reduces the accepted functional receipt into the only
current candidate result. Publication and every environment-specific support
workflow remain separate downstream decisions.

## Deferred until candidate acceptance

- Native Linux host qualification for named amd64 and arm64 systems.
- macOS, Windows, and other client-platform qualification.
- Public-cloud and independent clean-host recovery qualification.
- Multi-node availability, forwarding, federation, hosted operation, and
  concrete third-party provider support.

## Maintenance standard

- Keep one current candidate and its mandatory workstreams visible here.
- Put node ordering, state, and receipts only in the canonical local Plan.
- Move post-candidate environment goals to `docs/plans/FutureGoals.md`.
- Never promote a proposal, command, report, or historical receipt into a
  current release or support claim.
