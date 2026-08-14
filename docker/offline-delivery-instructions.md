# Offline Linux VM dual-architecture delivery

This sheet is the operator-facing instruction set for a candidate-bound
Meshrix.js Linux amd64 and arm64 OCI bundle. It does not establish native
Linux, Ubuntu, or Debian support, capacity, or publication.

The operator pack command is `npm run pack:offline`. It writes the signed
Server + Web Console dual-arch bundle to `build/offline-delivery-bundle` and
does not start, stop, or clean up a running instance. Contract-fixture bytes
are refused.

The signed bundle is also produced and byte-checked by
`node tools/server-scripts/offline-delivery-closure.ts`. The closure writes
privacy-safe evidence to `build/reports/offline-delivery-closure.json`. The
operator host may be macOS. Acceptance requires the disconnected lifecycle to
run on a reachable Linux virtual machine. Prefer Ubuntu; accept Debian. A
missing Linux VM, missing Linux builder, or missing candidate OCI layout fails
closed with `blocked_by_environment` and a finite reason. Contract-fixture
bytes never satisfy acceptance. The closure is the acceptance oracle, not the
daily pack or start command.

## Bundle contents

The signed layout contains:

- Server + Web Console OCI files for `linux/amd64` and `linux/arm64`
  (`runtime-ui`; API-only `runtime` images do not satisfy this bundle)
- inventory, SBOM, provenance, and signature metadata
- `compose/compose.yaml` activation with `pull_policy: never` and
  `MESHRIX_SERVER_WITH_UI=1`

Do not add, rebuild, or replace files in the transferred bundle.

## Linux VM sequence

Work only from the transferred bundle root on the Linux VM. Do not use
registry pull or `docker compose build`. The container engine may live inside
that VM.

1. **Import** the OCI layout from `files/` into the VM container engine. Network
   access is forbidden.
2. **Start** with the signed compose contract:
   `docker compose -f compose/compose.yaml up -d --no-build --pull never --wait meshrix-server`.
   The image must serve Server and Web Console. `GET /api/healthz` and the
   Console root must both succeed.
3. **First governed call** is MCP `tools/call` on `meshrix.discovery` /
   `system.health`.
4. **Stop** with
   `docker compose -f compose/compose.yaml stop meshrix-server`.
5. **Cleanup** with
   `docker compose -f compose/compose.yaml down --remove-orphans --volumes`.

Operator secret files stay outside Meshrix.js data and backup volumes and are
never written into reports.

## Non-claims

Linux amd64 and arm64 artifacts plus a passing Linux VM lifecycle are
functional-candidate delivery evidence. They are not an environment support
statement for this host or any other host.
