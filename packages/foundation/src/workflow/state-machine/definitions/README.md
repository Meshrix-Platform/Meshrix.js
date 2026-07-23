# State Machine Definitions

<!-- GENERATED: tools/generators/generate-state-machine-docs.mjs — DO NOT EDIT BY HAND -->

This directory holds machine-readable state-machine definition JSON. Documentation under `docs/state-machine/` is projection-only and cannot redefine these digests.

Integrity registry: `tools/registry/state-machines/state-machine-integrity.registry.json` (v0.0.1:registry:state-machine-integrity-1).

## Files

- `agent-gateway-model-routing.json`: `acceptance.agent-gateway-model-routing` @ `sha256:47adfef18fcfe91fb6a215095c1542fa419773eb23a731237bf1c41008a70eb9`.
- `approval-governance.json`: `acceptance.approval-governance` @ `sha256:90706175bddb40f32302ad8bfc5f7d69583e32931cbc555db6430e4aedb07576`.
- `console-administration.json`: `acceptance.console-administration` @ `sha256:41035b75312a2265673fbebe7bb4fdcdc36a4ea180042ab67405651a78a7f497`.
- `container-deployment-resumability.json`: `acceptance.container-deployment-resumability` @ `sha256:ba6e3cc2b6aa36db11b8a26e08a4e05a153f6100b18cc018ca5335f83159e6fa`.
- `core-workspace-assets-governance.json`: `acceptance.core-workspace-assets-governance` @ `sha256:18c9535152c9df5cec1f16d0e4a58cc656b30e372e6a45a81503fa7d0b392180`.
- `downstream-mcp-gateway.json`: `acceptance.downstream-mcp-gateway` @ `sha256:a6a486f7b2d2a42ac1c73b2f40692e62b34f06f991d6cd59a79f9a8b32ebd229`.
- `execution-sandbox.json`: `acceptance.execution-sandbox` @ `sha256:1b4ddee5ac82c0150ef33d05e7972cdd3611c1d3bddb00c9b8b8e7ec8078bd38`.
- `jobs-work-queue-runtime.json`: `acceptance.jobs-work-queue-runtime` @ `sha256:1eb9458003b08c6c8bf80d0d012421c09d969f8ee9dd3ad3a93ff48f6b1efab1`.
- `maintenance-agent-collaboration.json`: `acceptance.maintenance-agent-collaboration` @ `sha256:d9d4f3fee78a51444529e4015a9e01d844ec380df155d9392baac08d5bada124`.
- `mcp-native-installer-process-identity.json`: `acceptance.mcp-native-installer-process-identity` @ `sha256:1998330a561d3ae46372d99dd7990c11d0ffb9c10f8058b1bcbd7b863228cd22`.
- `observability-alerts-reporting.json`: `acceptance.observability-alerts-reporting` @ `sha256:88d4c4faa00a9f92c2fa286f83395dc1194991ab774a66dd07fb3b5654261d66`.
- `operation-permission-authorization.json`: `acceptance.operation-permission-authorization` @ `sha256:acc63d5c72e7be108e3e1d118412248e8e6d69a06cc6183c125197aa0745c972`.
- `pactium-cryptographic-foundation.json`: `acceptance.pactium-cryptographic-foundation` @ `sha256:0fe3867249b6ef5c0ed96b04925cba55c1aeb677158ba8ff739a8144c3d9da7f`.
- `plugin-runtime-and-module-system.json`: `acceptance.plugin-runtime-and-module-system` @ `sha256:db2ba150cdb47825468ed323c4f24524db8611f5eb6d8f0c5e4c65bc7c420d88`.
- `state-machine-governance.json`: `acceptance.state-machine-governance` @ `sha256:79a8fcc7b64f44fa08079d6143834358e920d11c5c212aec0103935a6ae0a8be`.
- `storage-backup-runtime.json`: `acceptance.storage-backup-runtime` @ `sha256:3348357d569412706f51652d80912d2f5913ebafe5c39c7276a109d386f51018`.
- `strategy-management.json`: `acceptance.strategy-management` @ `sha256:fc33eea6645cae577062ebe3219383f48329e5c29a0e4eb3ea8997d71086acc5`.
- `upstream-mcp-passthrough.json`: `acceptance.upstream-mcp-passthrough` @ `sha256:b9af939a1dfaccb3d7ec6268cdbb2ef5cd17f7cc4f8ea835d517b1964c6dedf9`.
- `upstream-service-publishing.json`: `acceptance.upstream-service-publishing` @ `sha256:031cf2ac879e4029f72d68604084ccb37d2eda878e34fcd3b51113bac9276bf2`.
- `alert.lifecycle.json`: `alert.lifecycle` @ `sha256:4ad852cb858debea7edc76504f884edabbdbdec28d93730928efef5820d95bc1`.
- `deployment.lifecycle.json`: `deployment.lifecycle` @ `sha256:824311432b75f1d4f9dabc586f43b0b88200ab8491904fc65cf1a293713cbb82`.
- `operation.narrow.json`: `operation.narrow` @ `sha256:0eb5bfe9854399dd61117dba2af1c6f39d4f04b2d97bf7f0129952b200ecfda9`.
- `production.readiness.lifecycle.json`: `production.readiness.lifecycle` @ `sha256:3f14e7a8684f2b84f7406ba79175151527a78360cafcde6f2b87c8f5b1f4d167`.
- `storage.backup.lifecycle.json`: `storage.backup.lifecycle` @ `sha256:0b20188bf561075a701f18af89bc8db2452eba579825df2a77923e40f0d63448`.
- `version.artifact.lifecycle.json`: `version.artifact.lifecycle` @ `sha256:e6c1107913ecef1e1f9e544b59d3d8cc33aea3dd5fc3228deb11cc198221c2fb`.
- `version.transition.lifecycle.json`: `version.transition.lifecycle` @ `sha256:1733230948674675ec30094608f7293980ca004cde5a95de8a985e9b9bd6f402`.

## Design rules

1. **Matrix totality** — every `State × Event` cell must exist in `totalMatrix`.
2. **Stateless core** — definitions encode pure transitions; persistence belongs to runtime services.
3. **Secret redaction** — definitions must not contain secrets or absolute host paths.

Regenerate projections with:

```bash
node tools/generators/generate-state-machine-integrity-registry.mjs
node tools/generators/generate-state-machine-docs.mjs
```
