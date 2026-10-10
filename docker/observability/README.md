# Meshrix operator observability

Standard traffic monitoring for a self-hosted Meshrix deployment:

- The private relay worker exposes `GET /admin/metrics?tenant=<tenantId>` —
  a Prometheus text exposition that aggregates every Durable Object counter
  for the tenant (session, mailbox, directory, and explicitly-listed vault
  objects via repeated `&vault=<id>` params). Admin bearer auth, same token
  as `/admin/counters`.
- The private endpoint exposes `GET /metrics` on its loopback service with
  the same text format.
- This overlay runs Prometheus (time-series storage) and Grafana
  (provisioned datasource + starter dashboard) alongside the deployed stack.

## Deploy

```bash
export RELAY_ADMIN_TOKEN_FILE=/path/to/relay-admin-token   # file, not the value
export MESHRIX_CORE_NETWORK=meshrix-src_meshrix-core        # network the relay is on
docker compose -f docker-compose.yml -f docker-compose.windows.yml \
  -f docker/observability/docker-compose.observability.yml up -d
```

Edit `prometheus/prometheus.yml` for your tenant id and scrape interval,
then open Grafana at `http://127.0.0.1:3000` (default `admin`/`admin` —
change it; the UI binds loopback only).

## Semantics

- `meshrix_relay_*{scope="durable"}` — counters flushed to Durable Object
  SQLite at bounded transitions; survive eviction.
- `meshrix_relay_*{scope="ephemeral"}` — in-memory per-message/byte/event
  counters; reset to zero on Durable Object eviction. `rate()` panels handle
  resets; absolute panels can drop on hibernate — that is honest, not a bug.
- Labels carry only `object`, `tenant`, `route`, `device`, `scope`. No
  payload, plaintext, digest, nonce or credential material is ever exported.
- Fan-out per scrape is bounded by `RELAY_RUNTIME_LIMITS`
  (maxRoutesPerTenant / maxDevicesPerTenant). Raising `scrape_interval`
  directly lowers Durable Object wake cost.
