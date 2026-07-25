# State Machines

<!-- GENERATED: tools/generators/generate-state-machine-docs.mjs — DO NOT EDIT BY HAND -->

Projection schema: `v0.0.1:docs:state-machines-projection-1`
Generated at: `1970-01-01T00:00:00.000Z`
Integrity registry digest: `sha256:80bdc9eab4f25cec95ca0d4d89377b95b152e506b98b52c946278ce768fb7838`
Authority: JSON definitions under `packages/foundation/src/workflow/state-machine/definitions/`. This markdown file is projection-only and must not be treated as an independent authority.

Core state-machine definitions live under `packages/foundation/src/workflow/state-machine/definitions/`. Package-owned definitions are admitted from verified plugin bundles and are not compiled into Core documentation.

## Core And Plugin-Registered Machines

| Machine | Definition digest | States/Events/Cells | Authority path |
| --- | --- | --- | --- |
| `alert.lifecycle` | `sha256:4ad852cb858debea7edc76504f884edabbdbdec28d93730928efef5820d95bc1` | 7/6/42 | `packages/foundation/src/workflow/state-machine/definitions/alert.lifecycle.json` |
| `deployment.lifecycle` | `sha256:824311432b75f1d4f9dabc586f43b0b88200ab8491904fc65cf1a293713cbb82` | 9/8/72 | `packages/foundation/src/workflow/state-machine/definitions/deployment.lifecycle.json` |
| `operation.narrow` | `sha256:4ff0f8515eb7e0ff505a7bb689580a5bce764c6bc47c38e55274a25c4751f567` | 10/9/90 | `packages/foundation/src/workflow/state-machine/definitions/operation.narrow.json` |
| `production.readiness.lifecycle` | `sha256:3f14e7a8684f2b84f7406ba79175151527a78360cafcde6f2b87c8f5b1f4d167` | 10/10/100 | `packages/foundation/src/workflow/state-machine/definitions/production.readiness.lifecycle.json` |
| `storage.backup.lifecycle` | `sha256:0b20188bf561075a701f18af89bc8db2452eba579825df2a77923e40f0d63448` | 8/7/56 | `packages/foundation/src/workflow/state-machine/definitions/storage.backup.lifecycle.json` |
| `version.artifact.lifecycle` | `sha256:e6c1107913ecef1e1f9e544b59d3d8cc33aea3dd5fc3228deb11cc198221c2fb` | 5/4/20 | `packages/foundation/src/workflow/state-machine/definitions/version.artifact.lifecycle.json` |
| `version.transition.lifecycle` | `sha256:1733230948674675ec30094608f7293980ca004cde5a95de8a985e9b9bd6f402` | 9/9/81 | `packages/foundation/src/workflow/state-machine/definitions/version.transition.lifecycle.json` |

## Normative Proof Machines

| Machine | Purpose |
| --- | --- |

## Capability Acceptance Evidence

Generated `acceptance.<capability-id>` machines model repository-local evidence only. Their terminal state is `verified`, which means the capability checkpoint graph is eligible as an input to the platform acceptance reducer. These machines cannot declare a capability or release accepted.

Completed implementation and final-validation criteria must cite reproducible commands. A capability or platform aggregate reducer cannot be used as evidence for its own input checkpoint. Objective evidence that must be produced by an external client, supported operating system, independent audit, or deployment environment is recorded as a structured `external-evidence` blocker with the required receipt and its verification command.

Run the capability evidence verifier directly with:

```bash
npm run verify:capability-acceptance-machines
```

Only `npm run verify:acceptance` may reduce capability evidence and the other required reports into project-level release readiness.

## Acceptance Machines

| Machine | Definition digest | States/Events/Cells | Authority path |
| --- | --- | --- | --- |
| `acceptance.agent-gateway-model-routing` | `sha256:47adfef18fcfe91fb6a215095c1542fa419773eb23a731237bf1c41008a70eb9` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/agent-gateway-model-routing.json` |
| `acceptance.approval-governance` | `sha256:90706175bddb40f32302ad8bfc5f7d69583e32931cbc555db6430e4aedb07576` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/approval-governance.json` |
| `acceptance.console-administration` | `sha256:41035b75312a2265673fbebe7bb4fdcdc36a4ea180042ab67405651a78a7f497` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/console-administration.json` |
| `acceptance.container-deployment-resumability` | `sha256:ba6e3cc2b6aa36db11b8a26e08a4e05a153f6100b18cc018ca5335f83159e6fa` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/container-deployment-resumability.json` |
| `acceptance.core-workspace-assets-governance` | `sha256:18c9535152c9df5cec1f16d0e4a58cc656b30e372e6a45a81503fa7d0b392180` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/core-workspace-assets-governance.json` |
| `acceptance.downstream-mcp-gateway` | `sha256:a6a486f7b2d2a42ac1c73b2f40692e62b34f06f991d6cd59a79f9a8b32ebd229` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/downstream-mcp-gateway.json` |
| `acceptance.execution-sandbox` | `sha256:1b4ddee5ac82c0150ef33d05e7972cdd3611c1d3bddb00c9b8b8e7ec8078bd38` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/execution-sandbox.json` |
| `acceptance.jobs-work-queue-runtime` | `sha256:1eb9458003b08c6c8bf80d0d012421c09d969f8ee9dd3ad3a93ff48f6b1efab1` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/jobs-work-queue-runtime.json` |
| `acceptance.maintenance-agent-collaboration` | `sha256:d9d4f3fee78a51444529e4015a9e01d844ec380df155d9392baac08d5bada124` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/maintenance-agent-collaboration.json` |
| `acceptance.mcp-native-installer-process-identity` | `sha256:1998330a561d3ae46372d99dd7990c11d0ffb9c10f8058b1bcbd7b863228cd22` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/mcp-native-installer-process-identity.json` |
| `acceptance.observability-alerts-reporting` | `sha256:88d4c4faa00a9f92c2fa286f83395dc1194991ab774a66dd07fb3b5654261d66` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/observability-alerts-reporting.json` |
| `acceptance.operation-permission-authorization` | `sha256:acc63d5c72e7be108e3e1d118412248e8e6d69a06cc6183c125197aa0745c972` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/operation-permission-authorization.json` |
| `acceptance.pactium-cryptographic-foundation` | `sha256:0fe3867249b6ef5c0ed96b04925cba55c1aeb677158ba8ff739a8144c3d9da7f` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/pactium-cryptographic-foundation.json` |
| `acceptance.plugin-runtime-and-module-system` | `sha256:db2ba150cdb47825468ed323c4f24524db8611f5eb6d8f0c5e4c65bc7c420d88` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/plugin-runtime-and-module-system.json` |
| `acceptance.state-machine-governance` | `sha256:79a8fcc7b64f44fa08079d6143834358e920d11c5c212aec0103935a6ae0a8be` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/state-machine-governance.json` |
| `acceptance.storage-backup-runtime` | `sha256:3348357d569412706f51652d80912d2f5913ebafe5c39c7276a109d386f51018` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/storage-backup-runtime.json` |
| `acceptance.strategy-management` | `sha256:fc33eea6645cae577062ebe3219383f48329e5c29a0e4eb3ea8997d71086acc5` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/strategy-management.json` |
| `acceptance.upstream-mcp-passthrough` | `sha256:b9af939a1dfaccb3d7ec6268cdbb2ef5cd17f7cc4f8ea835d517b1964c6dedf9` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/upstream-mcp-passthrough.json` |
| `acceptance.upstream-service-publishing` | `sha256:031cf2ac879e4029f72d68604084ccb37d2eda878e34fcd3b51113bac9276bf2` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/upstream-service-publishing.json` |

Run:

```bash
node tools/generators/generate-state-machine-integrity-registry.mjs
node tools/generators/generate-state-machine-docs.mjs
npm run server:verify:state-machines
npm run verify:capability-acceptance-machines
```
