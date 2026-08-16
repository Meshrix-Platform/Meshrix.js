# State Machines

<!-- GENERATED: tools/generators/generate-state-machine-docs.ts — DO NOT EDIT BY HAND -->

Projection schema: `v0.0.1:docs:state-machines-projection-1`
Generated at: `1970-01-01T00:00:00.000Z`
Integrity registry digest: `sha256:f5e96df9ace44b88de5d8a9c9bb6e63e6f33faff1139d37307f4a4f00a192d12`
Authority: JSON definitions under `packages/foundation/src/workflow/state-machine/definitions/`. This markdown file is projection-only and must not be treated as an independent authority.

Core state-machine definitions live under `packages/foundation/src/workflow/state-machine/definitions/`. Package-owned definitions are admitted from verified plugin bundles and are not compiled into Core documentation.

## Core And Plugin-Registered Machines

| Machine | Definition digest | States/Events/Cells | Authority path |
| --- | --- | --- | --- |
| `alert.lifecycle` | `sha256:4ad852cb858debea7edc76504f884edabbdbdec28d93730928efef5820d95bc1` | 7/6/42 | `packages/foundation/src/workflow/state-machine/definitions/alert.lifecycle.json` |
| `deployment.lifecycle` | `sha256:418191bb87702bc98e0640b9c337128b37be1a64eb0958e74f80a3ff10a565bd` | 9/8/72 | `packages/foundation/src/workflow/state-machine/definitions/deployment.lifecycle.json` |
| `operation.narrow` | `sha256:b8b9c2e58678a125db10910688bebcb26aa903dd1579807a64225ea411ba6986` | 10/9/90 | `packages/foundation/src/workflow/state-machine/definitions/operation.narrow.json` |
| `production.readiness.lifecycle` | `sha256:3f14e7a8684f2b84f7406ba79175151527a78360cafcde6f2b87c8f5b1f4d167` | 10/10/100 | `packages/foundation/src/workflow/state-machine/definitions/production.readiness.lifecycle.json` |
| `storage.backup.lifecycle` | `sha256:dd59a37c93ddb4e78bdfa0fd0d7b8a685a51ef1e4f6d78a945bb0c9b1c859aa6` | 8/7/56 | `packages/foundation/src/workflow/state-machine/definitions/storage.backup.lifecycle.json` |
| `version.artifact.lifecycle` | `sha256:e6c1107913ecef1e1f9e544b59d3d8cc33aea3dd5fc3228deb11cc198221c2fb` | 5/4/20 | `packages/foundation/src/workflow/state-machine/definitions/version.artifact.lifecycle.json` |
| `version.transition.lifecycle` | `sha256:1733230948674675ec30094608f7293980ca004cde5a95de8a985e9b9bd6f402` | 9/9/81 | `packages/foundation/src/workflow/state-machine/definitions/version.transition.lifecycle.json` |

## Normative Proof Machines

| Machine | Purpose |
| --- | --- |

## Capability Acceptance Evidence

Generated `acceptance.<capability-id>` machines model repository-local functional evidence only. Their terminal state is `verified`, which means the capability checkpoint graph is eligible as an input to the Functional Release Gate. These machines cannot declare a capability or release accepted.

Completed implementation and final-validation criteria must cite reproducible commands. An aggregate reducer cannot be used as evidence for its own input checkpoint. Every implementation, organization, simulation, failure-injection, resource, security, recovery, and packaging check that the development environment can execute is functional evidence; a missing required check fails the Functional Release Gate.

A Real-Machine Verification Workflow is remaining required work and is external to these machines. It may run only for an immutable candidate that already has a passing Functional Release Gate receipt. Its `not_run`, `ineligible`, `passed`, or `failed` result controls only the exact Environment Support Claim and can never block, promote, or alter functional acceptance.

Run the capability evidence verifier directly with:

```bash
npm run verify:capability-acceptance-machines
```

Only `npm run verify:acceptance` may reduce capability evidence and the other required functional reports into project-level functional acceptance. Project-level `blocked` is not a Functional Release Gate result.

## Acceptance Machines

| Machine | Definition digest | States/Events/Cells | Authority path |
| --- | --- | --- | --- |
| `acceptance.approval-governance` | `sha256:b5a918a7c0c491216ab29b3696a80bd3428653a140f162026dd82ee4ade9f8cb` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/approval-governance.json` |
| `acceptance.console-administration` | `sha256:244383535c9ede809b9a143882f402d81fdfc68466e79bc7009fc608a79e8566` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/console-administration.json` |
| `acceptance.container-deployment-resumability` | `sha256:732701212974d4847c559e633b1f6a5b2253a42fff1cb0de8e44ec74e5e7ab8d` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/container-deployment-resumability.json` |
| `acceptance.core-workspace-assets-governance` | `sha256:8cefb9e24e65549f24b3e2bf16ae22991353f81ceab640e2afb4bfb6bfdff383` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/core-workspace-assets-governance.json` |
| `acceptance.downstream-mcp-gateway` | `sha256:ac253218ad590e04efa9e12ce6ec546c00b91782c7b52d7c7b9dfabdfea64371` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/downstream-mcp-gateway.json` |
| `acceptance.execution-sandbox` | `sha256:21c20d4007aaf9fa4fedce563b9f510cedb66936be572fe31acde66dba5b1c77` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/execution-sandbox.json` |
| `acceptance.jobs-work-queue-runtime` | `sha256:e70166f348820344aa2cbb33530b26a70772019995ca1983dde5b221c329df96` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/jobs-work-queue-runtime.json` |
| `acceptance.mcp-native-installer-process-identity` | `sha256:ce3225eee3c0643cb8506b69b1ad76e1e2b33af66bf2f2bdfefbfcf349951338` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/mcp-native-installer-process-identity.json` |
| `acceptance.model-gateway-service` | `sha256:68071835dce68dcefdadfbd4b1bbc8fc087288cb2ae65bf55eb12b956b52aac7` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/model-gateway-service.json` |
| `acceptance.observability-alerts-reporting` | `sha256:7b29ace9374ad882bdd34c095283ba6e9dd998e60c44ba9b00517514848f641c` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/observability-alerts-reporting.json` |
| `acceptance.operation-permission-authorization` | `sha256:944050d50d85081a3eb91ea49e10db2e51075a2fcdf32431547e8e6dd85bcf8f` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/operation-permission-authorization.json` |
| `acceptance.pactium-cryptographic-foundation` | `sha256:29971392f3a3479ed7ec5ee6f0f6dbe5d4ed4bfa9099636b579d1f3bc46b0ea9` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/pactium-cryptographic-foundation.json` |
| `acceptance.plugin-runtime-and-module-system` | `sha256:d70ada51e1653e1ce168749d73eacb0dc251756e2dbcf061ebb02d7e4febb68a` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/plugin-runtime-and-module-system.json` |
| `acceptance.state-machine-governance` | `sha256:1b89f6d34bec725d866000137fe14acfa3a01f9c02563e7d3f32aee50b568c72` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/state-machine-governance.json` |
| `acceptance.storage-backup-runtime` | `sha256:7bce6ab6881eb65f9fe0528334cffc9c9a35ef1fe6ad366f97cefd0ba514ac73` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/storage-backup-runtime.json` |
| `acceptance.strategy-management` | `sha256:687b915fbfc4069d55b25ccd6d74daf8698cef67bc4f53aaa54d55c4c37afea6` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/strategy-management.json` |
| `acceptance.upstream-mcp-passthrough` | `sha256:f68d5ae6ae077e102aa8861cb1e64f6faf6d55190983311aacf4dfba8b94d07f` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/upstream-mcp-passthrough.json` |
| `acceptance.upstream-service-publishing` | `sha256:e533580288ea55888ff32c0cdf232200219002c7134dee0bfff13514751dfaac` | 5/8/40 | `packages/foundation/src/workflow/state-machine/definitions/acceptance/upstream-service-publishing.json` |

Run:

```bash
node tools/generators/generate-state-machine-integrity-registry.ts
node tools/generators/generate-state-machine-docs.ts
npm run server:verify:state-machines
npm run verify:capability-acceptance-machines
```
