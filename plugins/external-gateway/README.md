# External Gateway

External Gateway is a default-disabled Meshrix Runtime Plugin that contributes
optional downstream and upstream transport channels backed by
operator-provided Caddy, Nginx, or direct endpoints.

The plugin does not install, configure, start, stop, or monitor an external
proxy. It receives no Workspace port and cannot select a channel, change an
operation's traffic model, reinterpret an operation, bypass either mandatory
Gateway stage, or provide authorization. Meshrix Core retains the selected
channel generation for each direction, and only an explicit governed Console
operation changes that selection.

Activation requires closed configuration for both directions. Endpoint
references resolve through Host-owned configuration; the plugin does not
contain endpoint addresses or credentials.

```json
{
  "enabled": true,
  "downstream": {
    "adapter": "caddy",
    "endpointRefs": ["gateway.downstream.primary"],
    "maxConcurrency": 32,
    "maxRatePerSecond": 100,
    "maxQueueDepth": 64,
    "timeoutMs": 30000,
    "circuitFailureThreshold": 5,
    "circuitResetMs": 10000
  },
  "upstream": {
    "adapter": "nginx",
    "endpointRefs": ["gateway.upstream.primary"],
    "maxConcurrency": 32,
    "maxRatePerSecond": 100,
    "maxQueueDepth": 64,
    "timeoutMs": 30000,
    "circuitFailureThreshold": 5,
    "circuitResetMs": 10000
  }
}
```

`timeoutMs` is an optional operator-selected channel budget; omission adds no
channel timeout. The per-envelope `deadlineMs` is an explicit request budget and
also bounds time in the local queue; it must be a positive safe-integer number
of milliseconds. Non-integer or non-finite budgets are rejected before transport.
The smaller configured/channel or request
budget aborts active transport and returns a timeout result, while the channel
retains its active slot until the transport actually settles. Explicit caller
cancellation also reaches the transport and keeps the slot occupied until
settlement. `runtime.close()` is awaitable: it stops new admission, signals
cancellation to queued and active requests, and resolves only after every active
transport has settled. The Host lifecycle awaits this result before releasing
the plugin runtime.

Run `npm run verify:local-runtime-plugins` from the Meshrix.js repository root
to validate, build, package, and smoke-test the runtime plugin catalog.
