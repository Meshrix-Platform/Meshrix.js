# Meshrix.js Status

Status assessed on 2026-08-14.

This document owns current product status claims. It separates intent,
implementation, verification, release, and support. Source, a Plan, a command,
a prior report, or a changelog entry cannot satisfy a different dimension by
itself.

## Product-wide status

| Dimension | Current status |
| --- | --- |
| **Intent** | The only current Plan is one enterprise single-node functional candidate led by Agent-to-MCP Service collaboration efficiency. |
| **Implementation** | Server, Console, gateways, Operation Permission, Workspace, storage, jobs, Plugin Host, Agent Gateway, and operations surfaces exist. Runtime capacity and concurrency improvements are current substrate; the shared Working View and Change Set interaction model remains planned work. |
| **Verification** | Focused verifiers exist, but no current immutable candidate has the complete efficiency, Plugin isolation, enterprise operations, offline delivery, and final acceptance evidence set. Historical Plan receipts are not current evidence. |
| **Release** | `0.0.1` remains a declared target. No tag, package set, OCI manifest, GitHub Release, or hosted deployment is claimed without immutable same-candidate channel evidence. |
| **Support** | No operating system, architecture, client, connector, cloud, cross-host, or recovery environment is currently supported by product-level claim. Functional acceptance does not create an environment support claim. |

Meshrix.js is therefore **pre-release**. It must not be described as
release-ready, production-ready, published, or supported without naming the
candidate, evidence, channel, configuration, and environment.

## Current candidate boundary

| Capability | Current fact | Remaining candidate evidence | Claim boundary |
| --- | --- | --- | --- |
| Agent-to-Service collaboration efficiency | MCP gateways, reusable sessions, bounded runtime substrate, Workspace assets, and Connector entrypoints exist | Service Working View, one bounded Change Set per dirty turn, Resource delta synchronization, explicit Effect Commands, and the named comparison profile | The 60% call and 70% byte reductions are future acceptance thresholds, not achieved results |
| Runtime capacity and concurrency | The refactor implementation exists as current substrate | Fresh evidence for the consolidated interaction profile and repair of any objectively failing final regression | No standalone capacity Plan or general capacity claim |
| Plugin Console isolation | Signed or digest-bound packages and focused runtime verification exist | Opaque-origin iframe, bounded revocable MessageChannel bridge, old importer removal, and browser escape evidence | Third-party browser-code isolation is not yet claimed |
| Enterprise single-node operations | Candidate source and deployment surfaces exist | Governed journey, diagnostics, administration and keys, clean-root restore, and N-1 upgrade rollback | Functional candidate only |
| Cross-system offline delivery | Source and container assembly surfaces exist | Candidate-bound Linux amd64 and arm64 bundle, inventory, SBOM, signatures, disconnected lifecycle, and cleanup | Required artifact; no native Linux support claim |
| Functional acceptance | Gate and receipt authorities exist | Exact current efficiency, Plugin isolation, enterprise operations, and offline evidence; one gate execution | No publication or environment claim |

The current priority summary is [What's Next](WHATS-NEXT.md). Compatibility and
support evidence rules are in [Compatibility](COMPATIBILITY.md). Execution
state remains in ignored `docs/plans/` material and is never a public
completion claim.
