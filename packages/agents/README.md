# Agents Package

The agents package owns agent-facing runtime behavior that is not specific to one transport.

## Responsibilities

- Agent gateway configuration and model routing helpers.
- Agent workspace and session state.
- Workspace contribution primitives used by higher-level platform capabilities.
- Maintenance-agent runtime entry points that still pass through registered operations.

## Boundaries

- Protocol transport belongs in `packages/protocols/`.
- Shared storage primitives belong in `packages/foundation/`; generic workspace runtime ownership lives under `packages/agents/src/agent-workspace`.
- Permissions are evaluated through Operation Permission and tag policy.

## Model credential custody

Model records persist only encrypted credential references. Set
`LICO_MODEL_CREDENTIAL_MASTER_KEY` to deployment-managed key material of at
least 32 characters before saving or loading a model credential. The key is
never written to the registry; changing an agent provider or endpoint clears
the old credential binding and requires an explicit replacement.

## Verification

```bash
npm test -- --suite domains.manifest
npm test
```
