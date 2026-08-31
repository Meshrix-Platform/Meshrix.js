---
name: meshrix-js-offline-pack
description: Build a privacy-scanned, self-contained Meshrix.js runtime-ui archive for an authorized Linux release platform.
---

# Meshrix.js Offline Pack

Use this skill when an authorized local workflow needs a latest-version Meshrix.js Server and Web Console bundle that starts on Linux without host Node.js, npm, a compiler, a registry, or a container runtime.

## Command

```sh
bash skills/meshrix-js-offline-pack/pack-offline.sh \
  --platform linux/amd64 \
  --out <private-output-root>
```

`--platform` is required and accepts only `linux/amd64` or `linux/arm64`. `--out` is optional and defaults to the repository-local `build/offline-pack` directory. `--dry-run` validates the release definition and prints the bounded build plan without writing output or invoking the builder.

The build host requires Node.js, Docker Buildx, BSD tar or GNU tar, the `file` utility, and any network access needed by the existing `runtime-ui` build. The packer preserves the exact `NODE_BASE_IMAGE` digest declared by the Dockerfile while resolving that immutable official Node image through `public.ecr.aws/docker/library/node`. It never substitutes a tag or a different digest. The unpacked target requires a compatible Linux system, but no host Node.js, npm, compiler, registry, or container runtime.

## Contract

The script reads `tools/registry/release-definition.registry.json` and requires the selected platform plus the `runtime-ui` container target. It derives the version and writes:

- `meshrix-js-<version>-linux-<architecture>.tar.gz`
- `result.json`, containing exactly `artifactName`, `version`, and `platform`

The archive contains one `meshrix-js/` directory. Run `meshrix-js/start`; it resolves its own directory, creates `data/` there, and starts the bundled Node.js runtime on `0.0.0.0:7228`. The Web Console is `/`, the API is `/api/`, and health is `/api/healthz` on that one origin. The entrypoint accepts no passthrough arguments.

Assembly starts from an export of the existing `runtime-ui` target and admits only the bundled Node executable, the shell and directory utility required by the fixed entrypoint, their native runtime libraries, production `node_modules`, compiled JavaScript, required package manifests and runtime configuration, the built Web Console, the fixed start entrypoint, and `bundle.json`. Project source, TypeScript, declarations, source maps, build tools and caches, reports, data, backups, logs, and Git state are excluded.

No product, protocol identifier, header, or compiled behavior is rewritten. The output root and unpublished staging tree are private, and archive ownership is normalized to `root:root` rather than recording the build account. Before publication, the packer verifies the selected architecture of the bundled Node executable and `better-sqlite3` native module. Before and after archive creation, it rejects absolute or escaping links, dangling links, special files, unsafe archive paths, forbidden entries, credential-shaped literals, developer paths, and personal or machine identity. It reports only a safe category and archive-relative entry. The completed archive and closed metadata are each atomically renamed after validation, with metadata published last; a failed build never publishes a partial archive.

## Verification

```sh
bash skills/meshrix-js-offline-pack/test-offline-pack.sh --contract

bash skills/meshrix-js-offline-pack/pack-offline.sh \
  --platform linux/amd64 \
  --out build/offline-pack-dry-run \
  --dry-run

bash skills/meshrix-js-offline-pack/test-offline-pack.sh \
  --real linux/amd64 linux/arm64
```

The real verifier builds each requested platform once, checks the bundled Node executable and `better-sqlite3` native module architecture, imports the archive itself as a matching-platform `scratch` target, and starts it with networking disabled. It pulls no separate harness image and mounts no host content. The target contains only the bundle, with no host Node.js, npm, source checkout, registry, compiler, or container runtime. The verifier checks the Console root, health endpoint, single listener on port `7228`, one server process after probes, and clean termination.
