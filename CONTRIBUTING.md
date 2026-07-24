# Contributing To Meshrix

Meshrix is an open, private-deployable gateway platform for agent access, upstream service forwarding, governed operations, and auditable collaboration.

Contributions must keep the repository serious, calm, pragmatic, and accurate. Changes should improve current runtime behavior, documentation accuracy, tests, or deployability. Do not add private product capabilities, secrets, local machine details, or speculative product claims.

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Development Setup

Requirements are declared in `package.json`. Use the current Node.js range from `engines.node`.

```bash
npm install
npm run dev
```

The default local server URL is `http://127.0.0.1:7228`.

## Change Rules

- Keep each change scoped to one capability, protocol boundary, verifier, or documentation area.
- Follow [Source File Organization](docs/architecture/ARCHITECTURE.md#source-file-organization): choose the smallest cohesive boundary that reduces coupling, and never split or reject a source file solely because of its line count.
- Preserve existing user changes in the working tree.
- Prefer registered operations, generated registries, and existing domain helpers over parallel implementations.
- Do not keep old compatibility paths when a refactor is meant to replace the old implementation.
- Name extracted modules by stable responsibility and ownership; do not create numeric, stage-named, or pass-through shards.
- Update documentation when public behavior, configuration, commands, or verification changes.
- Add or update tests for behavior changes.

## Documentation Rules

- Write technical facts, not intent narratives.
- Keep documents tied to code paths, runtime behavior, configuration fields, protocol surfaces, or verification commands.
- Record durable technical decisions in the canonical public architecture, protocol, functionality, registry, or verifier source that owns the affected behavior.
- Use placeholders such as `<repo-root>`, `<server-url>`, `<server-data-dir>`, `<input-file>`, and `<output-file>`.
- Do not write secrets, tokens, local absolute paths, private hosts, production payloads, or private runtime state.

## Validation

Run the narrowest verifier that covers the change, then run broader checks when the change crosses public boundaries.

```bash
npm run typecheck
npm test -- --suite domains.manifest
npm test
```

For documentation-only changes, run at least:

```bash
npm test
git diff --check
```

## Pull Requests

A pull request should state the changed capability, the runtime or documentation surface affected, the validation commands run, and any objective blocker. A code-organization refactor should also state the new responsibility and owner, dependency and public API effects, and why the result can be changed and tested independently. Security issues must not be reported through public issues; use the security reporting path in `SECURITY.md`.
