# `@meshrix/gateway`

`@meshrix/gateway` is the small, embeddable Meshrix gateway kernel. It owns
route snapshots, policy-bound invocation, protocol-neutral results,
continuations, admission, and lifecycle. Network clients, credentials, and
platform stores are injected through ports.

The factory is synchronous and side-effect free. Call `start()` to activate
owned resources and `close()` to drain or cancel them. A platform composition
may supply the existing authorization and credential implementations without
making them dependencies of this package.
