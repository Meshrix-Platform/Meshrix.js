# Skill Hub Service

Skill Hub is an independently deployable HTTP service. It is the sole owner of
the skill contribution registry, package custody, lifecycle state, adoption,
permission relations, usage statistics, revocation, and rollback evidence.
Meshrix connects to it through the published upstream-service contract and the
default-disabled `skill-hub` adapter plugin.

The service does not import Meshrix runtime code. The adapter obtains a
digest-bound package from the service only for an authorized scan, build, or
execute operation, submits it to Meshrix controlled execution, and commits the
terminal receipt back to this service. The service never reports a sandbox
operation as successful without that receipt.

## API

- `GET /healthz` reports process health.
- `GET /readyz` reports service readiness and protocol version.
- `POST /v1/operations/<skill_hub.operation>` executes the versioned Skill Hub
  application contract. Transport success is HTTP 200; the response contains
  the application `statusCode` and bounded `body` so Meshrix can preserve
  domain failures across its governed upstream gateway.
- `GET /v1/events` opens the authenticated Skill Hub change stream. Successful
  lifecycle mutations append a bounded, persistent revision event. Consumers
  resume with `Last-Event-ID` or `?cursor=`. Events contain no request input,
  actor, workspace, package, credential, or command.

Request bodies are bounded to 2 MiB. Skill packages are strict Base64 with a
decoded limit of 1 MiB. Package bytes and registry state are stored under
`SKILL_HUB_DATA_ROOT` with private modes. Application logs never contain
packages, request bodies, actor identifiers, or storage paths.

Every operation request requires `Authorization: Bearer <token>`. Configure the
service with `SKILL_HUB_AUTH_TOKEN` (32–512 bytes), store the same value in the
Meshrix secret store, and add the resulting `secretRef` to the operator-owned
service publication. The portable example intentionally contains neither the
token nor a deployment-specific secret reference.

Meshrix Core owns this credentialed event connection. The Skill Hub plugin
receives only its opaque `serviceRef`; it never receives the service URL or
token.

## Run

```sh
npm test
PORT=8080 SKILL_HUB_DATA_ROOT=./data \
  SKILL_HUB_AUTH_TOKEN='<operator-supplied-token>' npm start
```

Build and run the container:

```sh
docker build -t meshrix-skill-hub:local .
docker run --rm -p 127.0.0.1:18080:8080 \
  -v meshrix-skill-hub-data:/var/lib/skill-hub \
  meshrix-skill-hub:local
```

When Meshrix and the service share the Compose network, import
`docs/examples/skill-hub.upstream.json`, publish it, and put the returned
server-owned service id in the plugin configuration:

```json
{
  "enabled": true,
  "service": {
    "serviceRef": "svc_...",
    "timeoutMs": 30000
  }
}
```
