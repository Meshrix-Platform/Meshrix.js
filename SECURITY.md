# Security Policy

Meshrix is designed for private deployment. Security reporting, authorization behavior, and audit evidence must be handled as operational facts, not public claims.

## Supported State

The repository is in pre-release state until the release gate is completed. Security fixes target the current source tree and documented release branch policy.

## Reporting A Vulnerability

Do not report vulnerabilities through public issues.

Use private vulnerability reporting in the repository host, or contact the maintainers through the published project contact channel. Include enough technical evidence for triage:

- affected component or operation;
- reproduction steps;
- expected and actual behavior;
- impact and required privileges;
- logs or traces with secrets removed;
- suggested fix, when available.

## In Scope

- HTTP, MCP, plugin-package, and console protocol boundaries.
- Operation Permission decisions, grants, approval, audit, and metrics.
- Tag policy enforcement for roles, skills, operations, documents, agents, upstream services, workspaces, and organizations.
- Upstream service forwarding, request redaction, response filtering, and egress control.
- Core workspace file access, upload handling, path containment, and executable-content policy.
- Verified plugin-package admission, content-addressed custody, activation, contribution publication, rollback, and console asset serving.
- Operation-scoped external-service requests, secret-reference custody, response projection, timeout, cancellation, and sanitized errors.
- Runtime storage, checkpoint, job, backup, restore, and public-boundary hygiene.
- Container and deployment defaults shipped in this repository.

## Out Of Scope

- Social engineering against maintainers or users.
- Attacks against infrastructure outside this repository.
- Modified forks or deployments with disabled security controls.
- Reports that require real secrets, private payloads, or private runtime data to be disclosed publicly.

## Security Requirements

- Every state-changing operation must pass subject resolution, Operation Permission, tag policy, risk policy, and approval when required.
- Raw secrets, bearer tokens, cookies, private keys, upstream request secrets, and grant tokens must not appear in source, documentation, logs, reports, or test fixtures.
- Public responses must not expose server absolute paths, machine identity, local user names, raw prompt contents, or private runtime state.
- Operation Permission grants are scoped, revocable, auditable, and separated from console credentials.
- Denials must be auditable without revealing unauthorized resource existence beyond the policy result.
- External-service request bodies may be decoded only by explicit server operation paths after authorization and redaction controls. Plugins receive bounded response projections, not secret material or transport internals.

## Verification

Use the security and hygiene checks that match the changed surface:

```bash
npm test
npm run security:hygiene
npm run test:security
node tools/server-scripts/verify-authorization-governance.mjs
node tools/server-scripts/verify-capability-binding-guard.mjs
node tools/server-scripts/verify-security-local-stdio-lockdown.mjs
```
