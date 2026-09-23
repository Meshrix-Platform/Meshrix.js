# Gateway examples

These examples use the public gateway contract and local in-memory ports. They
do not start the Console, plugins, or an external service.

Run them after the source build with the repository's Node source conditions:

```bash
node --conditions=source docs/examples/gateway/faithful-tool-proxy.ts
node --conditions=source docs/examples/gateway/mrtr-input.ts
node --conditions=source docs/examples/gateway/shared-artifact.ts
```
