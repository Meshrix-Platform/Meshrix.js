# Meshrix.js Status

Status assessed on 2026-07-28.

This document is the authority for current Meshrix.js status claims. It separates
intent, implementation, verification, release, and support. A command,
workflow, source file, changelog entry, or release definition is not by itself
evidence that another dimension has been satisfied.

## Product-wide status

| Dimension | Current status |
| --- | --- |
| **Intent** | Approved direction: a full, private-deployable governance platform. The next product closure is one independently acceptable enterprise single-node candidate. |
| **Implementation** | The repository contains the server, Web Console, protocol gateways, Operation Permission, workspace, storage, plugin Host boundaries, agent gateway, jobs, and operations surfaces described by their owning technical documents. The current source remains a mutable pre-release candidate and is not represented here as a closed release. |
| **Verification** | Focused verifiers and the Functional Release Gate exist. This status document does not assert a current immutable candidate with a complete passing functional receipt. Individual checks, prior reports, and development-host simulations cannot be combined across candidates. |
| **Release** | The repository declares a `0.0.1` release target and contains a changelog entry. No source tag, npm package set, container manifest, GitHub Release, or other publication channel is claimed by this document without immutable channel evidence for the same accepted candidate. |
| **Support** | No operating-system, architecture, connector, deployment, or hosted-service support claim is made at product level. A support claim requires the exact accepted candidate and the named environment workflow defined in [Compatibility](COMPATIBILITY.md). |

Meshrix.js is therefore **pre-release**. It must not be described as
release-ready, production-ready, published, or supported without naming the
dimension, candidate, evidence, channel, and environment.

## Capability status

| Capability | Intent | Implementation | Verification | Release or support |
| --- | --- | --- | --- | --- |
| Enterprise single-node private deployment | Current closure | Candidate source and deployment assets exist | Complete same-candidate closure not asserted | Not claimed |
| First governed MCP-to-upstream call | Required minimum user journey | Governing server, MCP, permission, gateway, and receipt surfaces exist | Must pass as one same-candidate positive and negative journey | Not a separate release claim |
| Local diagnostics and bounded observability | Required for the single-node closure | Health, diagnostic, metric, audit, and report surfaces exist | Complete operator diagnosis journey not asserted | No environment claim |
| Independent backup and clean-root restore | Required for the single-node closure | Backup, restore, integrity, and recovery mechanisms exist | Complete same-candidate clean-root closure not asserted | No recovery support claim |
| N-1 upgrade and rollback | Required after recovery closure | Candidate orchestration and focused verifier surfaces exist | Two distinct immutable images, schema transition, failure rollback, and reopen closure not asserted | No upgrade support claim |
| Offline dual-architecture delivery | Later release work | Source and container assembly surfaces exist | Complete disconnected artifact closure not asserted | No Linux architecture support claim |
| External identity, telemetry, notification, datastore, and provider integrations | Optional extension intent | Varies by independently owned integration | Each enabled integration needs its own evidence | Cannot promote or block Meshrix.js release |
| Meshrix.js hosted service | Separate hosted-service concern | Not established by this repository | No operation evidence asserted | No operation claim |

## Next acceptance order

1. Freeze one auditable single-node candidate and its exact scope.
2. Prove the first governed call and its denial, replay, and uncertain-outcome
   boundaries on that candidate.
3. Prove an operator can diagnose startup, readiness, upstream, storage, and
   resource failures using bounded, privacy-safe output.
4. Prove independent backup and clean-root restore.
5. Prove N-1 upgrade, failure rollback, and healthy retry.
6. Run the Functional Release Gate once for the immutable candidate.

The prioritized gaps are maintained in [What's Next](WHATS-NEXT.md). Local
execution detail remains in ignored `docs/plans/` material and is never a
public completion claim.
