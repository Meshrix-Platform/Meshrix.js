# Enterprise Recording

> **Meshrix.js trusted-forwarding requirements:** verifiable identity,
> non-amplifying authority, content integrity, and end-to-end traceability.
> [Governed Execution And Minimum Evidence](../architecture/GOVERNED-EXECUTION-AND-MINIMUM-EVIDENCE.md)
> owns their normative meaning.

The enterprise recording profile is the self-hosted governance and recording
surface of the Meshrix.js platform. The organization operates the gateway, the
server runtime and the local recording storage itself: recorded history stays
inside organization-controlled storage, recording policy and retention are
governed by the organization's own Console configurer roles, and no external
service is involved in capture or custody.

## Decryption And Custody Boundary

Recorded content is stored under the enterprise-local sink in encrypted form,
but **the organization can decrypt recorded content**. Decryption and audit
access are controlled by the organization at its own key boundary — this is
the deliberate purpose of the enterprise profile: the operator that runs the
platform retains the ability to review and decrypt what was recorded.

The recording governance authority reports `custody: "enterprise_local"` and
`decryptionAuthority: "organization"` on every policy snapshot and sink health
answer so Console operators see the custody fact where they govern policy.

## One Configuration Source

Recording configuration lives in exactly one place: the `recording` section of
the runtime-instance JSON (`runtime.recording`), or the equivalent
`runtimeOptions.recording` for embedding hosts that call `startHttpServer`,
`bootstrapServer` or `createServerCompositionRoot` directly. The composition
root is the single owner that normalizes and validates it; no second
configuration path exists downstream.

```json
{
  "runtime": {
    "recording": {
      "root": "recording",
      "sinkId": "recording-sink-local",
      "budgets": { "maxRecordBytes": 262144 },
      "reservationTtlMs": 30000,
      "policy": {
        "policyId": "recording-policy",
        "issuerRole": "system",
        "configurerRoles": ["owner", "maintainer"]
      }
    }
  }
}
```

- `root` resolves relative to the server data directory and owns every
  tenant's `recording-sink.sqlite` plus artifact custody beneath hashed
  `tenant-*` directories.
- `policy` controls only the genesis identity used when a tenant store is
  created fresh; an existing store reopens its persisted policy and a
  supplied revision is never silently replaced on restart.
- Malformed or unknown keys fail startup honestly rather than diverging from
  the stated intent.

## What Is Recorded

Recording is selected history, not operational state. A published tenant
policy selects categories — execution history, governance decisions, usage
aggregates, diagnostics and field-allowlisted content — and producers
(gateway dispatch, operation-permission runtime, Console governance) write
only what the live policy revision selects. A category turned off stops all
serialization and buffering for that category.

Mandatory operational correctness state is separate: the operation-audit
store keeps its own location under the data directory's security area and is
never placed inside the recording root. Recording failure can never rewrite a
settled operation outcome, replay an effect, or fabricate a record.

A category selected with `required_before_effect` obligation reserves durable
capacity before the protected effect runs; if the tenant store is unavailable
the effect is refused `recording_unavailable` while unrelated work continues.
A post-effect write that fails becomes a truthful pending obligation instead
of an operation failure.

## Retired Path Recognition

Startup runs a one-time, read-only recognition of retired recording locations
(flat-layout stores and superseded roots) and reports them for operator
reconciliation. It never deletes data, never migrates bytes implicitly, and
the check is not retained as a permanent startup gate.

## Verification

```bash
npm run vitest -- tests/vitest/server/enterprise-recording-profile.test.ts
```
