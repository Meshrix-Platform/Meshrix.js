# Meshrix.js Status

Status assessed on 2026-08-09.

This document owns current product status claims. It separates intent,
implementation, verification, release, and support: source, a command, a
workflow definition, a prior report, or a changelog entry cannot satisfy a
different dimension by itself.

## Product-wide status

| Dimension | Current status |
| --- | --- |
| **Intent** | The only current closure is one enterprise single-node functional candidate, delivered through three mandatory workstreams and one functional acceptance gate. |
| **Implementation** | Server, Web Console, protocol gateways, Operation Permission, workspace, storage, jobs, plugin Host, agent gateway, and operations surfaces exist. The source remains a mutable pre-release candidate. |
| **Verification** | Focused verifiers and release reducers exist, but this document does not assert a current immutable candidate with all three mandatory final receipts. Historical reports and receipts are not current evidence. |
| **Release** | `0.0.1` is a declared target. No tag, npm package set, OCI manifest, GitHub Release, or hosted deployment is claimed without immutable same-candidate channel evidence. |
| **Support** | No operating system, architecture, client, connector, cloud, cross-host, or recovery environment is currently supported by product-level claim. Functional acceptance does not create an environment support claim. |

Meshrix.js is therefore **pre-release**. It must not be described as
release-ready, production-ready, published, or supported without naming the
candidate, evidence, channel, configuration, and environment.

## Current candidate boundary

| Capability | Current fact | Remaining candidate evidence | Claim boundary |
| --- | --- | --- | --- |
| Enterprise single-node delivery | Candidate source and deployment surfaces exist | Same-candidate governed journey, diagnostics, administration and keys, clean-root restore, N-1 rollback, and named capacity envelopes | Functional candidate only |
| Plugin runtime and package loading | Signed or digest-bound packages, lifecycle, contribution projection, and focused verification exist; server plugin modules are trusted in-process deployment code | Register the runtime verifier in unified verification | Provenance is not isolation |
| Plugin Console contributions | The current Host loads verified Console code by trusted same-origin dynamic `import()` | Migrate to the closed contribution contract, opaque-origin iframe, bounded revocable MessageChannel bridge, and browser escape evidence; delete the old importer | Until that migration closes, third-party browser-code isolation is **not implemented or claimed** |
| Cross-system offline delivery | Source and container assembly surfaces exist | Candidate-bound Linux amd64 and arm64 bundle, inventory, SBOM, signatures, disconnected import, startup, first governed call, shutdown, and cleanup | Required functional artifact; no native Linux support claim |
| Functional acceptance | Gate and receipt authorities exist | Exact current final receipts from enterprise delivery, plugin isolation, and offline transfer; one gate execution | No publication or environment claim |
| Optional identity, telemetry, notification, datastore, and provider integrations | Varies by independently owned integration | Each enabled integration needs its own evidence | Cannot promote or block the current candidate |
| Hosted Meshrix.js service | Not established by this repository | Separate operating evidence | No hosted-service claim |

Resource and capacity boundaries are part of the first candidate, but results
apply only to the named configuration, workload, saturation point, and recovery
behavior. Synthetic throughput is not a general production guarantee.

The current priority summary is [What's Next](WHATS-NEXT.md). Compatibility and
support evidence rules are in [Compatibility](COMPATIBILITY.md). Execution
state remains in ignored `docs/plans/` material and is never a public
completion claim.
