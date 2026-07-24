# Foundation Package

The foundation package owns reusable infrastructure primitives for configuration, security, storage, workflow, observability, proof, and module composition.

## Boundaries

- Foundation primitives must not depend on product composition or console behavior.
- Security-sensitive primitives fail closed when required identity, policy, or durable state is absent.
- Domain capabilities remain in their owning packages and consume foundation through explicit exports.

## Verification

```bash
npm test -- --suite domains.manifest
npm run server:verify:state-machines
npm run verify:security
```
