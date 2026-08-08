---
name: meshrix-js-privacy-evidence
description: Scan Meshrix.js source or evidence for secrets, machine identity, personal paths, and unsafe runtime disclosure, and produce minimum redacted receipts. Use before sharing logs, reports, workflow output, or repository artifacts.
---

# Meshrix.js Privacy Evidence

## Scan without redisclosure

Run `npm run repo:local-info-hygiene`. Treat findings as rule ID, repository-relative file, line number, severity, and an irreversible digest. Never include the matched value.

`privacy scan` checks a bounded working-tree target and is only a development
helper. It does not approve a commit or push. For repository publication, use
`npm run repo:local-info-hygiene` on the exact staged tree. The verified pre-push hook
invokes `npm run repo:local-info-hygiene` with Git's exact outgoing update set. Run
`npm run repo:local-info-hygiene` on the exact bytes of any manually
assembled output before sharing them.

The complete commit and push gates include the repository storage-boundary
scan. Use `npm run repo:local-info-hygiene` only as a standalone diagnosis of
untracked or ignored files, unexpected refs or reflogs, stale branch metadata,
sensitive local Git configuration, and unreachable objects. Neither a `HEAD`
scan nor a clean `git status` proves those surfaces are absent.

Scan source, fixtures, generated reports, and workflow tails before sharing them. Secret assignment findings must be either quoted credential-shaped literals or unquoted credential-shaped literals assigned to uppercase sensitive environment-variable names; variable references, function calls, interpolations, and ordinary prose are not secret literals.

Exclude known binary, dependency, build, and local-tool output, including logs,
local properties, and ephemeral platform output. Keep scanning first-party
`evidence`, `reports`, and `receipts` directories even when they are nested
under a generated-output path; do not suppress a finding because it is
inconvenient.

Treat public documentation URLs as ordinary source content, not privacy findings. For a full first-party repository audit, use that repository's canonical workflow or the independent audit profile; use this scanner for repository-local source and bounded evidence files.

## Minimize evidence

Prefer task IDs, capability names, booleans, counts, categories, timings, and digest prefixes. Replace home paths, repository roots, hostnames, local usernames, service URLs, tokens, credentials, cookies, account identifiers, ciphertext, raw documents, and backend runtime rows. A deliberately published project contact email, Git author identity, or GitHub username may remain when its owner has approved publication.

For public release artifacts, use a consumer-verification allowlist: artifact name, version, platform, byte size, cryptographic digest, detached signature, verification algorithm or key identifier, only the public verification key or certificate-chain fields required to validate that signature, and cryptographically bound provenance or attestation when it is itself part of verification. Omit publisher, account, team, tenant, device, profile, credential names and values, private-channel configuration, and internal signing or release metadata.

Do not store a second unredacted report. Fix the source or evidence producer, then rerun the scan.

All scanners fail closed on uninspectable, binary, invalidly encoded,
oversized, changing, or unresolved candidates. Do not use bypass flags,
allowlists for local values, baselines, or ignored findings as substitutes for
removing protected data.

## Bound the claim

The generic scanner detects only its implemented credential, secret-literal,
machine-path, and machine-identity patterns. It is not proof that arbitrary
hostnames, device identities, provider IDs, SSH or administrator metadata,
ciphertext, runtime rows, or backend records are absent. Generated directories,
binaries, and oversized artifacts also require their owner's dedicated gate.

For a repository-wide claim, run the canonical local-information hygiene task
and its self-test when available. Use this skill for repository-local source
and bounded evidence before sharing it; do not substitute it for the complete
privacy or security audit.
