# Artifact and Packet Contracts

Read this reference when implementing persistence, generating Agent prompts, or building the Reducer. Fields may be extended, but identity consistency, ordered completeness, and privacy isolation are invariant.

## 1. Route

Use reviewable YAML:

```yaml
schema_version: 1
route_id: publish-and-use-real-service
route_version: 1
title: Publish and use one real service
persona: organization-admin-and-business-user
goal: Publish a real service, approve its invocation, and obtain a usable result
starting_state: signed-in admin is at the Console home; real client is closed
final_value: business user can open the correct generated artifact
surfaces:
  meshrix-console:
    kind: web
    entry_origin: <server-url>
    driver_profile: web-component
    qualification_ref: qualifications/web-component.json
  real-mcp-client:
    kind: agent-client
    driver_profile: <client-driver-profile>
    qualification_ref: qualifications/<client-driver-profile>.json
policy:
  max_repair_cycles: 3
  product_change_restart: route_start
  external_unblock_resume: same_checkpoint_if_unchanged
checkpoints:
  - id: CP-00
    title: Published candidate is reachable
    actor: rider
    surface: meshrix-console
    action:
      operation: observe
      target:
        stable_id: app-shell
        role: main
    expect:
      target:
        stable_id: app-shell
      state:
        visible: true
    evidence: screenshot
    required: true
    side_effect: none
  - id: CP-01
    title: Workbench opens
    actor: rider
    surface: meshrix-console
    action:
      operation: click
      target:
        stable_id: workbench-open
        role: link
        name: Workbench
    expect:
      target:
        stable_id: workbench-home
      state:
        visible: true
    evidence: screenshot
    required: true
    side_effect: none
```

`actor` is `rider`, `user`, or `orchestrator`. After a non-Rider action, the Rider still observes the resulting state through the real UI and emits the Receipt.

Every action names one declared `surface`. For a web target, resolve `stable_id` first, then accessible `role` plus `name`, associated `label`, and exact visible `text`. Use the fallback fields only to preserve human meaning or when the product does not yet own a stable identifier. Never use generated CSS classes, DOM ancestry, coordinates, or translated text as the durable contract.

Use only `none`, `reversible`, and `committing` for `side_effect`. Never automatically retry an uncertain `committing` action.

Do not store real accounts, secrets, machine paths, private hosts, or identifying sample data in a Route.

## 2. Attempt manifest

```json
{
  "schema_version": 1,
  "attempt_id": "attempt-003",
  "route_id": "publish-and-use-real-service",
  "route_version": 1,
  "candidate_id": "candidate-002",
  "environment_label": "staging-like",
  "surface_bindings": [
    {
      "surface_id": "meshrix-console",
      "driver_kind": "web-component",
      "qualification_ref": "qualifications/web-component.json"
    },
    {
      "surface_id": "real-mcp-client",
      "driver_kind": "<client-driver-kind>",
      "qualification_ref": "qualifications/<client-driver-profile>.json"
    }
  ],
  "status": "riding",
  "next_checkpoint": "CP-00",
  "repair_cycle": 1,
  "started_at": "RFC3339 timestamp"
}
```

`candidate_id` is an explicit label managed by the Orchestrator. Do not introduce a repository-wide content hash. Create a new label whenever product source, runtime configuration, build output, or deployment changes.

## 3. Checkpoint Receipt

```json
{
  "event": "checkpoint_recorded",
  "attempt_id": "attempt-003",
  "route_id": "publish-and-use-real-service",
  "route_version": 1,
  "candidate_id": "candidate-002",
  "checkpoint_id": "CP-04",
  "ordinal": 4,
  "status": "pass",
  "surface_id": "meshrix-console",
  "driver_kind": "web-component",
  "action_target": {
    "stable_id": "tool-catalog-entry",
    "resolved_by": "stable_id",
    "match_count": 1,
    "visible": true,
    "enabled": true,
    "actionable": true
  },
  "action_taken": "Opened the tool catalog from normal navigation.",
  "observed": "The published conversion tool is visible with the expected input fields.",
  "expectation": {
    "target": {
      "stable_id": "tool-catalog-entry",
      "resolved_by": "stable_id",
      "match_count": 1,
      "visible": true
    },
    "state_matches": true
  },
  "evidence_refs": ["evidence/CP-04.png"],
  "recorded_at": "RFC3339 timestamp"
}
```

`action_target` and `expectation` are copied from the qualified Surface Driver result rather than inferred by the Rider. `observed` states visible facts only. Evidence references are relative to the Attempt directory.

## 4. Failure Packet

```json
{
  "schema_version": 1,
  "failure_id": "failure-002",
  "attempt_id": "attempt-003",
  "route_id": "publish-and-use-real-service",
  "route_version": 1,
  "candidate_id": "candidate-002",
  "checkpoint_id": "CP-08",
  "classification": "product_bug",
  "surface_id": "meshrix-console",
  "driver_kind": "web-component",
  "action_target": {
    "stable_id": "approval-submit",
    "resolved_by": "stable_id",
    "match_count": 1,
    "actionable": true
  },
  "expectation": {
    "target": {
      "stable_id": "approval-completed",
      "match_count": 0
    },
    "state_matches": false
  },
  "action_taken": "Approved the pending request through the Console.",
  "expected": "Exactly one upstream conversion starts.",
  "observed": "The request remains pending and no result appears.",
  "last_passed_checkpoint": "CP-07",
  "side_effect_state": "No upstream effect is visible.",
  "evidence_refs": ["evidence/CP-07.png", "evidence/CP-08-failed.png"],
  "notes": "Screen facts only; no source-code hypothesis."
}
```

Do not send the complete Rider transcript to the Mechanic. If another UI observation is genuinely required, the Orchestrator creates one bounded probe that remains on the same Route.

## 5. Repair Result

```json
{
  "schema_version": 1,
  "failure_id": "failure-002",
  "classification": "product_bug",
  "root_cause": "A concise, evidence-backed cause.",
  "changed_scope": ["repo-relative/module"],
  "verification": ["Focused owning checks completed before the real rerun."],
  "risk": "low",
  "requires_user_decision": false,
  "new_candidate_id": "candidate-003",
  "restart_from": "route_start"
}
```

When the Mechanic classifies the failure as route or environment, leave `new_candidate_id` absent and state the next action. Do not fabricate a product repair.

## 6. Attempt ledger

Store one append-only JSONL ledger per Attempt:

```text
attempt_started
checkpoint_recorded
checkpoint_recorded
attempt_frozen | attempt_completed | attempt_blocked
```

Store the Repair Result and later Attempt separately and link them through `failure_id`. This preserves history while preventing cross-Attempt Receipt composition.

Minimum artifact layout:

```text
.real-validation/
  routes/<route-id>.yaml
  qualifications/<driver-profile>.json
  runs/<attempt-id>/attempt.json
  runs/<attempt-id>/events.jsonl
  runs/<attempt-id>/evidence/<checkpoint-id>.png
  failures/<failure-id>.json
  repairs/<failure-id>.json
  reports/<route-id>.html
```

Runtime evidence is Git-ignored. Stable Routes may be tracked. Never copy raw screenshots into durable documentation.

## 7. Reducer pseudocode

```text
expected = required checkpoints in route order
cursor = 0

for event in this attempt's ordered ledger:
  reject if route, version, candidate, or attempt identity differs
  if event freezes or blocks the attempt: return non-pass(event.status)
  ignore non-checkpoint lifecycle events
  reject if cursor is past expected or event.checkpoint_id != expected[cursor].id
  reject if event.surface_id is undeclared or its driver qualification is missing
  reject if action or expectation targets do not match the Route targets
  reject if action-target uniqueness, visibility, or expectation failed
  reject if an input action did not prove actionability
  reject if event.status != pass or required evidence is missing
  cursor += 1

pass only if cursor == expected.length and attempt ended as completed
```

With an ordered ledger, this is `O(n)` time and `O(1)` additional state. Do not add complex hashes, distributed consensus, or probabilistic judgment.

## 8. Prompt isolation

### Route Packet: Orchestrator to Rider

Include only the Route, Attempt and Candidate identities, qualified Surface Driver bindings and tool handles, starting state, checkpoint definitions, status output shape, and evidence destination. Exclude source, failure history, repair summaries, and Mechanic hypotheses.

### Failure Packet: Orchestrator to Mechanic

Include only the Failure Packet above, the Route, the authorized repository scope, and explicit mutation authority. Exclude secrets, the complete screenshot history, and Rider reasoning.

### Restart Packet: Orchestrator to new Rider

Use the same Route Packet as the first Attempt with new Attempt and Candidate identities. Do not say what changed or where the earlier run failed.
