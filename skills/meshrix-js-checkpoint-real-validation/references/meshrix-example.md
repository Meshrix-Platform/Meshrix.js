# Meshrix.js Golden Route Example

## User story

An organization administrator uses the published Meshrix.js Console to publish a real file-conversion service and gives a real MCP client scoped access. A business user submits a privacy-safe real sample. After administrator approval, Meshrix.js causes exactly one upstream conversion and the user opens the correct artifact. After a service restart, the capability remains discoverable and usable, and the audit chain remains complete and redacted.

This is one continuous journey. The identifiers below are checkpoints, not twelve independent test cases.

| Checkpoint | Business state | Observable evidence |
| --- | --- | --- |
| CP-00 | The declared published Candidate is reachable through its single origin. | Workbench or Console shows the expected candidate and entry state. |
| CP-01 | The administrator has entered Workbench. | The real UI loads without a development shell or substitute page. |
| CP-02 | The correct organization and permission context is active. | Organization, role, and permitted management entry points are visible. |
| CP-03 | The real conversion service is published and healthy. | Console shows published and healthy state. |
| CP-04 | The published tool is visible to the organization. | Tool catalog shows the expected operation and input contract. |
| CP-05 | An independent real MCP client discovers the tool. | The client lists it through its normal Meshrix.js connection. |
| CP-06 | The business user submits a real file and creates a pending approval. | Console and client expose the same pending business request. |
| CP-07 | Upstream side effects remain zero before approval. | The request is pending and no conversion result or duplicate call is visible. |
| CP-08 | Approval produces exactly one real upstream conversion. | State advances through execution and produces one result. |
| CP-09 | The user obtains and opens the correct converted artifact. | The artifact opens and matches the declared content and format expectation. |
| CP-10 | The audit chain is complete and redacted. | Actor, request, approval, call, and result are traceable with no plaintext secret. |
| CP-11 | Capability survives service restart. | The client rediscovers and can continue using the same published capability. |

## Surface bindings

Bind every Console checkpoint to the `meshrix-console` Web Surface and its qualified `web-component` driver. Route landmarks and actions should expose stable product-owned identifiers. A minimal target set includes semantic identities for the application shell, Workbench home, organization context, service publication action and status, tool catalog entry, approval request and decision, and recent-call audit entry.

CP-05 belongs to the declared real MCP client Surface, not the Console browser. Use that client's qualified adapter; require native Computer Use only when the selected client exposes no bounded tool interface and the Route explicitly requires its native UI. CP-09 may use another declared web or native artifact-viewer Surface. Never switch surfaces implicitly.

## Authority handoffs

- Pause Rider evidence while an API Key is issued, displayed, or entered into the real client. The user handles the secret; the Rider observes only the later non-sensitive connected state.
- If restart is not exposed through the product UI, an authorized Orchestrator or user performs it. The Rider then observes continuity through the real client.
- If approval incurs real external cost or an irreversible side effect, obtain confirmation immediately before that action.

## Candidate and rerun example

If `candidate-001` fails at CP-08:

1. Freeze `attempt-001`. Its CP-00 through CP-07 Receipts remain historical only.
2. Give a new Mechanic only the CP-08 Failure Packet, this Route, and the authorized source scope.
3. After repair, build, and deployment, register `candidate-002`.
4. Start a new Rider and `attempt-002` at CP-00.
5. Render both Attempts separately. Never combine `candidate-001` CP-00 through CP-07 with `candidate-002` CP-08 through CP-11.

If CP-05 merely waits for the user to place the API Key into the real client, use `blocked`, not `product_bug`. The Route may resume at CP-05 only when Candidate, Route, environment identity, and committed side effects remain unchanged.

## Final result

The Route passes only when one Candidate, within one Attempt, produces ordered pass Receipts for CP-00 through CP-11. CP-09 must prove usable final value, CP-10 must prove redacted traceability, and CP-11 must prove restart continuity.
