# Meshrix.js Project Release Runbook

This built-in runbook prepares a release candidate for the repository-owned
tag workflow. It does not publish packages, containers, tags, or GitHub Release
assets. It is not exposed to downstream agents (`allowDownstream: false`).

## Authority

- `npm run verify:acceptance` is the mandatory Functional Release Gate.
- `npm run server:verify:release-deployment` is the mandatory Release
  Deployment Verification for the exact stable candidate on `ubuntu-24.04`
  with bounded external deterministic synthetic requests and no real model
  dependency.
- `npm run verify:real-machine -- ...` runs remaining candidate-bound
  Real-Machine Verification Workflows. A passing receipt is the named
  Environment Support Claim for that exact environment
  and cannot block or promote project acceptance.
- `.github/workflows/release-branch.yml` promotes `release` only after the
  stable complete gate and external runtime-ui deployment verification.
- `.github/workflows/release.yml` is the only release publication path and
  accepts a version tag only when the tag commit equals the `release` branch
  tip and the release deployment authority exists for that exact commit.
- `.github/RELEASE_TEMPLATE.md` is the canonical release-notes template.

## Candidate Preparation

1. Update the root and every workspace package manifest to the same semantic
   version. Update protocol constants that deliberately mirror that package
   version, then refresh `package-lock.json` from the official npm registry.
2. Review the complete version diff. No package manifest or release protocol
   constant may retain the previous release version.
3. Run the local verification closure:

   ```bash
   npm ci
   npm run verify
   npm run test:audit
   npm audit --audit-level=high
   npm run verify:acceptance
   ```

4. Require every functional child report to pass. A missing implementation,
   simulation, failure case, or reproducible workflow script is a functional
   failure; project-level `blocked` is not a release result. Do not request or
   aggregate real-machine receipts in this decision.
5. Submit the reviewed version change through the governed branch flow from
   `stable` to `release`. This runbook does not commit, tag, push, upload, or
   call a package registry.

After functional acceptance, an operator may run any desired real-machine
workflow for the exact immutable candidate. Each workflow must preflight,
start, probe, stop, clean up, and emit a redacted receipt without source edits.
A `not_run`, `ineligible`, or `failed` workflow leaves only that environment's
qualification as remaining required work.

## Publication

An authorized maintainer creates the semantic version tag only after the
candidate commit is the exact `release` branch tip with a completed release
deployment authority. The tag workflow revalidates package versions, the
release deployment authority, and the exact tag-to-release-tip equality, then
assembles portable MCP assets, emits and verifies the production SBOM, stages
the multi-platform container, enforces immutable GHCR version-tag digests,
signs the container and the outer checksum authority with Sigstore, renders
the release-notes template, and creates the GitHub Release.

The workflow fails closed when the release already exists, the tag commit is
not exactly the `release` branch tip, any required gate or the release
deployment authority is missing, a GHCR version tag names a different manifest
digest, release asset basenames collide, or checksum signing and verification
do not complete.

## Consumer Verification

The published checksum authority is `RELEASE_SHA256SUMS`, accompanied by
`RELEASE_SHA256SUMS.sigstore.json`. Consumers first verify the bundle against
the exact `release.yml` workflow identity for the version tag and the GitHub
Actions OIDC issuer. Only then may they use the basename-keyed checksum file to
verify a downloaded asset. The MCP assembly-local `SHA256SUMS` is covered by
the signed outer checksum and is not a separate release authority.
