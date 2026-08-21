# Model Gateway

Model Gateway is a default-disabled, stateless Meshrix Runtime Plugin that
adapts an independently deployed Model Gateway Service into governed Meshrix
operations.

The plugin owns no model, provider, credential, route, pricing, usage,
settlement, persistence, or Service lifecycle state. It resolves one explicit
Host-owned `serviceRef`, calls the Service only after Meshrix authorization,
and exposes `model_gateway.call`, `models.list`, and `models.get`. Removing or
disabling the plugin leaves Meshrix startup, readiness, and non-model
operations independent of the Service.

```json
{
  "enabled": true,
  "serviceRef": "model-gateway.primary",
  "timeoutMs": 30000
}
```

Endpoint addresses and credentials remain behind the Host-owned service
reference and are not plugin configuration. Run
`npm run verify:local-runtime-plugins` from the Meshrix.js repository root to
validate, build, package, and smoke-test the runtime plugin catalog.
