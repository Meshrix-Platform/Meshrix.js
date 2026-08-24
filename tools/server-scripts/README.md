# Meshrix.js Deployment Script Design

This document is the maintenance authority for deployment scripts under
`tools/server-scripts/`. Read it before changing a deployment entry point,
stage catalog, stage script, activation path, upgrade path, or deployment
verification controller.

## Core Decision

Meshrix.js deployment scripts close only the capabilities owned by the
Meshrix.js Core platform. Their responsibility is to deliver and activate the
Server and Web Console, their Core runtime packages, Core configuration,
storage, security, permission, protocol, lifecycle, and health contracts.

Deployment must not install, start, configure, verify, wait for, or report the
readiness of:

- optional plugin implementations or plugin bundles;
- independent services under `services/`;
- external providers, datastores, parsers, gateways, or model services;
- Agent or client products and their local adapters;
- operator-supplied images, repositories, accounts, credentials, or endpoints;
- optional integration or interoperability scenarios.

Those components have separate opt-in integration workflows. Their absence or
failure must not block, promote, or alter a Meshrix.js Core deployment result.
A Core deployment may expose the governed contracts used to connect them, but
it must not adopt their implementation lifecycle.

## List-Driven Workflow

A deployment entry point is an orchestrator, not an implementation container.
It must activate an explicit source-controlled list of stage scripts.

Every stage entry must declare:

- one stable functional identifier;
- one repository-relative stage script;
- its explicit prerequisite stage identifiers.

Every stage script must own one independently traceable deployment outcome and
return `completed` or `resumed`. The orchestrator must reject missing
prerequisites, unloadable scripts, mismatched identifiers, and unknown result
states. It must not hide additional deployment work behind an unlisted child
script.

The native OrbStack deployment currently activates these nine stage scripts in
order:

1. `runtime`
2. `candidate`
3. `transfer`
4. `dependencies`
5. `build`
6. `native-runtime`
7. `configure`
8. `activate`
9. `verify`

The canonical list is
`tools/server-scripts/lib/native-orb-deployment/catalog.ts`. The entry point is
`tools/server-scripts/native-orb-deploy.ts`. Stage implementations live under
`tools/server-scripts/lib/native-orb-deployment/stages/`.

## Origin Selection

The deployment entry point takes a `--origin` argument that is environment-
specific. There is no universally correct origin; the value depends on the
target machine, its network topology, and how the host reaches it. The
operator or agent running the deployment must determine a reachable origin
for the current environment and pass it explicitly.

In particular, the `verify` stage probes the given origin and fails when it
is not reachable from the host. A plausible-looking origin (for example a
`.orb.local` name) may not be reachable unless the environment forwards the
service port. Choose an origin that is known to answer on the service port,
and confirm it before relying on deployment verification.

## Resume And Evidence

Expensive stages must detect their own candidate-bound completed state and
resume without repeating valid transfer, dependency, or build work. A resumed
run may execute cheap prerequisite inspection, but must not repeat the entire
deployment merely to reach a later stage.

Output is limited to the candidate identifier, bounded status, public
`<server-url>` placeholder, health status classes, and the ordered stage result
list. Deployment scripts must not emit credentials, private paths, machine
identity, runtime payloads, or backend logs.

## Maintenance Rules

When changing deployment automation:

1. Preserve the Core-only boundary above.
2. Change the stage catalog before changing orchestration behavior.
3. Keep one stage implementation per declared stage script.
4. Update the package-script registry inputs and the owning deployment test.
5. Verify that every declared script loads, identifiers and prerequisites are
   exact, and no optional extension appears in the deployment list.
6. Run the narrowest deployment tests, then one final repository regression.

Optional integration workflows may reuse published Core contracts. They must
remain separately invoked and must not be added to a Core deployment stage
catalog.

## Optional External Startup

External services, runtime plugins, Agent adapters, and independent Agent
processes use the separate `npm run start:optional` entry point. Core
deployment never invokes this command. Running it without `--target` imports
no target script and starts nothing.

The target catalog is `tools/optional-startup/catalog.ts`. Every catalog entry
owns exactly one script under `tools/optional-startup/targets/`; a target
script must not start a sibling target. List the available ids without loading
them:

```bash
npm run start:optional -- --list
```

Select one or more targets by repeating the same parameter:

```bash
npm run start:optional -- \
  --target service:model-gateway \
  --target adapter:opencode
```

Selected target modules are imported concurrently and their start functions
are invoked concurrently. Service and independent Agent scripts start their
own foreground child process. Agent adapter scripts load only their selected
one-shot adapter module; they do not scan, install, verify, or modify an Agent
client. The entry point supervises every started child and forwards shutdown
signals. One failed target fails the optional startup result and stops its
started siblings without changing the Core deployment result.

A selected runtime plugin does not become a standalone process. Each plugin
script contributes exactly its own plugin id, and the entry point starts one
Core Host for the combined selection through the canonical signed-artifact
loader. `--runtime-config <file>` is required, and its
`runtime.enabledPlugins` array must exactly equal the selected plugin target
ids. This prevents an unselected plugin from being loaded through hidden
configuration.

Service and independent Agent processes inherit the operator environment. An
optional target-specific JSON environment file can override it without
placing values on the process command line:

```bash
npm run start:optional -- \
  --target service:model-gateway \
  --env-file "service:model-gateway=<environment-json>"
```

The JSON file must be an object whose keys are environment variable names and
whose values are strings. It is operator-custodied runtime input and must not
be committed. Separate environment files let services with overlapping native
variable names, such as `PORT`, start concurrently with distinct values.

Maintenance of optional startup automation must preserve these invariants:

1. The empty selection performs no dynamic import, process start, plugin Host
   start, client action, or configuration write.
2. Every service, runtime plugin, Agent adapter, and independent Agent target
   has one catalog entry and one target script.
3. Target selection is explicit; there is no `all`, default profile, implicit
   discovery, or dependency-driven auto-selection.
4. Selected targets run concurrently wherever their real lifecycle permits.
   Runtime plugins share one Host because the plugin contract requires it.
5. Optional startup remains outside every Core deployment stage list and never
   changes Core deployment success, promotion, or readiness.
