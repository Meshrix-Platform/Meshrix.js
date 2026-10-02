# Meshrix.js Project Release Runbook

This built-in runbook prepares a release candidate for the repository-owned
publication workflow. It does not commit, tag, push, upload, or publish. It is
not exposed to downstream agents (`allowDownstream: false`).

## Candidate Preparation

1. Use `npm run release:prepare -- <version>` to update the canonical
   release definition, package manifests, lockfile, and versioned consumers.
   Review the version diff and run `npm run release:prepare -- --check`.
2. The responsible Agent starts `npm run ci:local`. This single entry discovers
   the current device's supported Node.js environment and usable local Docker,
   selects applicable engineering checks, and retains their reports and logs.
   Unavailable optional environments are recorded as `not_run`; they are not
   simulated or replaced by a required remote or all-platform matrix.
3. Complete source review and scoped repairs, then use the same entry with
   `--scope release` for functional acceptance and qualification of the two
   actual npm archives. Every selected check must pass. Repair the workflow or
   product when a selected check fails, rerun affected checks, and reuse results
   whose inputs remain unchanged. Artifact review belongs in this local flow.
   Remove redundant or inapplicable restrictions without hiding a real failure.
4. Submit the reviewed candidate through the governed `nightly` → `stable` →
   `release` branch flow. The stable run binds the accepted candidate,
   functional receipt, and npm installability report to the exact revision.

One successfully qualified available environment establishes the npm
installation claim. Other platforms remain unmeasured until separately tested.
Containers, portable archives, offline delivery, and real-machine deployment
claims have their own applicable checks and are not prerequisites for npm
publication. A real Agent conversation is not a substitute for deterministic
engineering verification.

## Publication

`.github/workflows/release-branch.yml` validates the candidate and originating
stable authority when a version reaches `release`, creates or verifies its
canonical version tag, and dispatches `.github/workflows/release.yml`. The first
version uses the explicitly authorized bootstrap-token procedure documented in
`docs/RUNBOOK.md`; subsequent releases use npm trusted publishing through
GitHub Actions OIDC. Temporary bootstrap credentials are removed after use.

The release workflow validates the tag and authority, prepares `meshrix.js` and
`@meshrix/gateway`, and compares the exact archives with the existing npm
qualification report. Read-only registry preflight and publication use those
same archives. Gateway is published before the root package. The publisher
verifies registry integrity, signatures, provenance, and version tags, preserving
a newer `latest` or `next` tag. MCP support is included in `meshrix.js`.

After npm verification succeeds, the workflow uploads both archives, their
release-set manifest, the production dependency SBOM, third-party notices, and
the supply-chain manifest to a GitHub draft release. It verifies uploaded asset
digests, publishes the release, and verifies actual immutability. A rerun may
resume owned draft assets or reverify an identical published release. It must
not replace a conflicting immutable release. No separate container publication
or detached signature bundle is required for this npm release.

## Consumer Verification

Install the desired published package from npm and use `npm audit signatures`
to verify registry signatures and provenance. Downloaded GitHub archives can
be checked against the SHA-512 integrity values in `meshrix-release-set.json`;
the supply-chain manifest identifies the associated SBOM and notices. The
release uses Apache-2.0. `docs/RUNBOOK.md` owns the operational publication and
trusted-publisher setup procedure.
