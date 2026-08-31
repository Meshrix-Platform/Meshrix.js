# Web Surface Driver Contract

Read this reference for any Meshrix.js Web Console route. The Route protocol is Agent-provider-neutral. Codex, Cursor, or any other Agent may be the Rider when it can call a driver that satisfies this contract.

## 1. Boundary

The driver operates the published Meshrix.js page in a real browser. It may inspect browser semantics to resolve targets and observe state. It must not:

- mutate the DOM or application state directly;
- call application components, stores, private browser globals, or internal Meshrix.js APIs;
- force a click past visibility, enabled-state, hit-testing, or overlay checks;
- insert validation-only elements into the page;
- replace the published page with a fixture, mock, or reconstructed surface.

A browser automation backend may implement this contract. The pass claim comes from the contract—real page, unique visible component, real input event, visible result—not from a particular framework or Agent brand.

## 2. Stable component targets

Each route action declares a semantic target. Resolve fields in this order:

1. `stable_id`: a product-owned stable component identifier such as `data-meshrix-id`;
2. `role` plus accessible `name`;
3. associated form `label`;
4. exact visible `text` as the least stable fallback.

Use `scope` to constrain a repeated component to a declared page region. Do not use generated CSS classes, DOM ancestry, element position, coordinates, or translated text when a stable product-owned identifier exists.

Add `data-meshrix-id` only to semantic route landmarks and actions that require a durable contract. It is a product component identity, not a checkpoint result and not an instruction to expose internal state.

Example:

```yaml
surface: meshrix-console
action:
  operation: click
  target:
    stable_id: upstream-service-publish
    role: button
    name: Publish
expect:
  target:
    stable_id: upstream-service-status
  state:
    visible: true
    semantic_state: healthy
```

`name` and `text` document the human meaning and may support diagnostics. `stable_id` remains the primary target across localization changes. A `semantic_state` must be a stable product-owned projection of a state that is also visible to the user; it must not expose hidden application internals as evidence.

## 3. Driver operations

A conforming driver exposes these logical operations through the Agent platform's normal tool protocol:

```text
capabilities()                  declare driver kind and supported operations
open(surface)                   open the declared real origin
observe(query)                  return bounded visible and accessibility facts
resolve(target)                 return one component and its match facts
act(operation, target, value?)  emit a browser input event
capture(checkpoint_id)          return a privacy-safe evidence reference
handoff(reason)                 pause for user-owned authority or secret entry
```

The transport may be MCP, JSON-RPC, stdio, or another bounded tool interface. The Route and Receipt contracts do not change by Agent vendor.

## 4. Resolution and actionability

Before acting, the driver must prove:

- the current browser origin matches the declared Surface;
- exactly one target matches within the declared scope;
- the target is attached, visible in the viewport, enabled, and accepts the requested operation;
- no overlay or different hit target intercepts the action point; and
- the action does not cross an undeclared external origin.

Then emit the normal browser input sequence for the operation. For example, `click` uses a genuine pointer click path; it must not invoke `HTMLElement.click()` or a component method directly.

After the action, observe the declared expectation from fresh page state. Never reuse a stale element handle or treat action completion alone as success.

## 5. Deterministic result shape

Return bounded facts to the Rider:

```json
{
  "surface_id": "meshrix-console",
  "driver_kind": "web-component",
  "action_target": {
    "stable_id": "upstream-service-publish",
    "resolved_by": "stable_id",
    "match_count": 1,
    "visible": true,
    "enabled": true,
    "actionable": true
  },
  "operation": "click",
  "expectation": {
    "target": {
      "stable_id": "upstream-service-status",
      "resolved_by": "stable_id",
      "match_count": 1,
      "visible": true
    },
    "semantic_state": "healthy",
    "state_matches": true
  },
  "evidence_ref": "evidence/CP-03.png"
}
```

Do not persist raw DOM snapshots, full accessibility trees, cookies, browser profiles, request payloads, or backend responses as route evidence.

## 6. Failure classification

| Driver result | Attempt result |
| --- | --- |
| Driver unavailable or unqualified | `blocked` with `surface_driver_unavailable` |
| Wrong origin, login wall, or user-owned secret step | `blocked` |
| Zero matches while the declared page state is otherwise confirmed | `product_bug` candidate; Orchestrator confirms route freshness first |
| More than one match | `stuck`; the Route target is ambiguous |
| Unique target is unexpectedly hidden, disabled, or intercepted | `product_bug` candidate |
| Real action occurs but the declared visible state does not appear | `product_bug` candidate |
| Result may have committed but is uncertain | `blocked`; never retry automatically |

The Rider reports driver facts. The Orchestrator decides whether a candidate result is a product defect, stale Route, or environment problem before dispatching the Mechanic.

## 7. Driver qualification

Preflight binds each Surface to a driver profile and a qualification receipt. Qualification proves only that the adapter can:

- control the declared real browser and origin;
- resolve stable and accessible component targets;
- enforce uniqueness and actionability;
- emit real browser input events;
- capture a privacy-safe post-action screenshot; and
- pause for user confirmation or handoff.

Qualification does not prove the product journey. A missing qualification blocks the Attempt before CP-00.

## 8. Other Agents and non-web surfaces

An Agent does not need built-in Computer Use. It may be the Rider if it can call the qualified Web Surface Driver and interpret its bounded observation results. Agents without tool invocation cannot be Riders, but may still serve as Mechanic when the surrounding platform can provide the isolated Failure Packet and repository scope.

Use an optional native Surface Driver only when a declared route segment leaves the browser for a system dialog or native client. Computer Use is one possible native adapter, not the route protocol. Bind the segment explicitly and return to the Web Surface Driver for the next Meshrix.js Console checkpoint.
