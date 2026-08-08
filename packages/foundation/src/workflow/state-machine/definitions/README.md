# State Machine Definitions

<!-- GENERATED: tools/generators/generate-state-machine-docs.ts — DO NOT EDIT BY HAND -->

This directory holds machine-readable state-machine definition JSON. Documentation under `docs/architecture/` is projection-only and cannot redefine these digests.

Integrity registry: `tools/registry/state-machines/state-machine-integrity.registry.json` (v0.0.1:registry:state-machine-integrity-1).

## Files

- `agent-gateway-model-routing.json`: `acceptance.agent-gateway-model-routing` @ `sha256:8291e94b933c7a7d970673ba8f0536fd05af8c00d62065538a70f70e2776fe4d`.
- `approval-governance.json`: `acceptance.approval-governance` @ `sha256:b5a918a7c0c491216ab29b3696a80bd3428653a140f162026dd82ee4ade9f8cb`.
- `console-administration.json`: `acceptance.console-administration` @ `sha256:244383535c9ede809b9a143882f402d81fdfc68466e79bc7009fc608a79e8566`.
- `container-deployment-resumability.json`: `acceptance.container-deployment-resumability` @ `sha256:732701212974d4847c559e633b1f6a5b2253a42fff1cb0de8e44ec74e5e7ab8d`.
- `core-workspace-assets-governance.json`: `acceptance.core-workspace-assets-governance` @ `sha256:8cefb9e24e65549f24b3e2bf16ae22991353f81ceab640e2afb4bfb6bfdff383`.
- `downstream-mcp-gateway.json`: `acceptance.downstream-mcp-gateway` @ `sha256:ac253218ad590e04efa9e12ce6ec546c00b91782c7b52d7c7b9dfabdfea64371`.
- `execution-sandbox.json`: `acceptance.execution-sandbox` @ `sha256:21c20d4007aaf9fa4fedce563b9f510cedb66936be572fe31acde66dba5b1c77`.
- `jobs-work-queue-runtime.json`: `acceptance.jobs-work-queue-runtime` @ `sha256:e70166f348820344aa2cbb33530b26a70772019995ca1983dde5b221c329df96`.
- `maintenance-agent-collaboration.json`: `acceptance.maintenance-agent-collaboration` @ `sha256:6411ce513e99d38d885ffac593abf36b3c96d76c803c4abee2ab57e28fd2b6b4`.
- `mcp-native-installer-process-identity.json`: `acceptance.mcp-native-installer-process-identity` @ `sha256:ce3225eee3c0643cb8506b69b1ad76e1e2b33af66bf2f2bdfefbfcf349951338`.
- `observability-alerts-reporting.json`: `acceptance.observability-alerts-reporting` @ `sha256:7b29ace9374ad882bdd34c095283ba6e9dd998e60c44ba9b00517514848f641c`.
- `operation-permission-authorization.json`: `acceptance.operation-permission-authorization` @ `sha256:944050d50d85081a3eb91ea49e10db2e51075a2fcdf32431547e8e6dd85bcf8f`.
- `pactium-cryptographic-foundation.json`: `acceptance.pactium-cryptographic-foundation` @ `sha256:29971392f3a3479ed7ec5ee6f0f6dbe5d4ed4bfa9099636b579d1f3bc46b0ea9`.
- `plugin-runtime-and-module-system.json`: `acceptance.plugin-runtime-and-module-system` @ `sha256:d70ada51e1653e1ce168749d73eacb0dc251756e2dbcf061ebb02d7e4febb68a`.
- `state-machine-governance.json`: `acceptance.state-machine-governance` @ `sha256:1b89f6d34bec725d866000137fe14acfa3a01f9c02563e7d3f32aee50b568c72`.
- `storage-backup-runtime.json`: `acceptance.storage-backup-runtime` @ `sha256:7bce6ab6881eb65f9fe0528334cffc9c9a35ef1fe6ad366f97cefd0ba514ac73`.
- `strategy-management.json`: `acceptance.strategy-management` @ `sha256:687b915fbfc4069d55b25ccd6d74daf8698cef67bc4f53aaa54d55c4c37afea6`.
- `upstream-mcp-passthrough.json`: `acceptance.upstream-mcp-passthrough` @ `sha256:f68d5ae6ae077e102aa8861cb1e64f6faf6d55190983311aacf4dfba8b94d07f`.
- `upstream-service-publishing.json`: `acceptance.upstream-service-publishing` @ `sha256:e533580288ea55888ff32c0cdf232200219002c7134dee0bfff13514751dfaac`.
- `alert.lifecycle.json`: `alert.lifecycle` @ `sha256:4ad852cb858debea7edc76504f884edabbdbdec28d93730928efef5820d95bc1`.
- `deployment.lifecycle.json`: `deployment.lifecycle` @ `sha256:418191bb87702bc98e0640b9c337128b37be1a64eb0958e74f80a3ff10a565bd`.
- `operation.narrow.json`: `operation.narrow` @ `sha256:b8b9c2e58678a125db10910688bebcb26aa903dd1579807a64225ea411ba6986`.
- `production.readiness.lifecycle.json`: `production.readiness.lifecycle` @ `sha256:3f14e7a8684f2b84f7406ba79175151527a78360cafcde6f2b87c8f5b1f4d167`.
- `storage.backup.lifecycle.json`: `storage.backup.lifecycle` @ `sha256:dd59a37c93ddb4e78bdfa0fd0d7b8a685a51ef1e4f6d78a945bb0c9b1c859aa6`.
- `version.artifact.lifecycle.json`: `version.artifact.lifecycle` @ `sha256:e6c1107913ecef1e1f9e544b59d3d8cc33aea3dd5fc3228deb11cc198221c2fb`.
- `version.transition.lifecycle.json`: `version.transition.lifecycle` @ `sha256:1733230948674675ec30094608f7293980ca004cde5a95de8a985e9b9bd6f402`.

## Design rules

1. **Matrix totality** — every `State × Event` cell must exist in `totalMatrix`.
2. **Stateless core** — definitions encode pure transitions; persistence belongs to runtime services.
3. **Secret redaction** — definitions must not contain secrets or absolute host paths.

Regenerate projections with:

```bash
node tools/generators/generate-state-machine-integrity-registry.ts
node tools/generators/generate-state-machine-docs.ts
```
