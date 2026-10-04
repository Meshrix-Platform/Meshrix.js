# Meshrix.js Project Release Runbook

Use the repository-owned `.github/workflows/release.yml` to publish the two npm
packages, `meshrix.js` and `@meshrix/gateway`. The workflow accepts a `v*` tag
push or a manual run with an existing tag selected.

## Prepare and release

1. Set the next version with `npm run release:prepare -- <version>`. Review the
   version diff, then run `npm run release:prepare -- --check` and
   `npm run verify:release-definition`.
2. Commit and push the prepared version. Push its `v<version>` tag to start the
   release, or dispatch `release.yml` from the existing tag:
   `gh workflow run release.yml --ref vX.Y.Z`.
3. The workflow checks the tag against package metadata, installs dependencies,
   runs `npm run ci:local`, publishes the prepared package
   archives, and creates a GitHub Release with generated notes. The default engineering
   scope builds and tests the products, packs the archives, and checks that
   consumers can install and smoke-test them.

Optional deployment, real-machine, platform-matrix, and performance runs are
separate from npm publication.

## Configure npm

The first publication uses the temporary `NPM_BOOTSTRAP_TOKEN` GitHub
environment secret, mapped to `NODE_AUTH_TOKEN` for the npm publish command.
The secret belongs to the repository's `release-candidate` environment.

After both packages exist on npm, open each package's **Settings → Trusted
Publisher** and add a **GitHub Actions** publisher with:

- Organization or user: `Meshrix-Platform`
- Repository: `Meshrix.js`
- Workflow filename: `release.yml`
- Environment: `release-candidate`
- Allowed action: `npm publish`

Enable account-level two-factor authentication before changing npm publisher
settings. The workflow sets the publish dist-tag as part of `npm publish`, so
the separate dist-tag permission is unnecessary. Once the publisher is set for
both packages, delete the GitHub environment secret and revoke the temporary
npm token. Ongoing releases use npm's standard GitHub Actions OIDC publishing.

See [docs/RUNBOOK.md](../../../../../../docs/RUNBOOK.md#release-definition-and-publication)
for the full release procedure and npm settings links.
