# Meshrix Domain Language

This glossary defines Meshrix-local vocabulary. It does not describe current
implementation, verification, release, support, or hosted operation.

| Term | Meaning |
| --- | --- |
| **Meshrix** | The full private-deployable governance platform for connecting operators, agent clients, services, plugins, workspaces, and governed effects. |
| **Meshrix repository** | The repository that implements the full Meshrix platform. The phrase is not a product named `Core` and never denotes MeshCore. |
| **Private deployment** | A Meshrix installation whose operator owns its configuration, credentials, data custody, runtime boundary, and operating decisions. |
| **Principal** | An authenticated subject whose current identity and authority are evaluated for an operation. |
| **Operation** | A named, bounded action exposed through a Meshrix-owned governance boundary. |
| **Operation catalog** | The authoritative set of operations and their governance-relevant definitions. |
| **Operation Permission** | The Meshrix domain that owns operation grouping, grants, policy evaluation, approval requirements, admission, execution authorization, audit, and metrics. |
| **Organization governance snapshot** | The single server-owned, revisioned aggregate that records a configured hierarchy, template-managed tags, and explicit restricted-empty scoped administrator roles. |
| **Organization governance template draft** | A server-normalized TOML hierarchy, tag, and scoped-role proposal that is not configured state until an administrator publishes it against the current snapshot revision. |
| **Organization node scope** | The group, recursive organization, department, or team node and its descendants within which an explicit organization-management action may be evaluated. A node name or administrator-role label is not authority. |
| **Grant** | Current, scoped authority for a principal to discover or request an operation. A grant is not an execution result. |
| **Approval** | A required human or policy decision attached to a specific proposed operation. Approval does not replace current identity, grant, or sink admission. |
| **Execution permit** | Short-lived, exact authority minted by the canonical governance path for one protected effect. |
| **Protected sink** | The final boundary that can read a protected resource or cause an external or durable effect and therefore must consume the exact execution permit. |
| **Governed execution** | The complete path from current identity and authority through admission, exact effect, outcome classification, and minimum evidence. |
| **Upstream service** | An operator-configured HTTP or MCP service reached through a governed Meshrix operation. |
| **Downstream client** | A client that discovers or invokes Meshrix operations through a published protocol boundary. Client implementation and product support remain independently owned. |
| **Plugin** | An optional package admitted through Meshrix Host contracts without becoming Meshrix policy authority. |
| **Workspace asset** | A resource held inside a workspace boundary and accessed only through its owning Meshrix capabilities. |
| **Governance evidence** | The bounded facts required to prove the decision, effect, and terminal outcome of a governed execution. |
| **Operational telemetry** | Bounded health, diagnostic, metric, log, or trace data used to operate a deployment. It is not governance authority. |
| **Candidate** | A specific source and artifact set being evaluated. Mutable source is not an accepted or released candidate. |
| **Functional acceptance** | A result for one immutable candidate after every mandatory repository-owned functional check succeeds. |
| **Environment support claim** | A claim that an accepted candidate passed the named workflow on one exact environment. It does not generalize to another environment. |
| **Independent same-origin product** | A product derived from related principles while owning separate source, runtime, contracts, evidence, release, and support. MeshCore has this relationship to Meshrix. |
