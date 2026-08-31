#!/usr/bin/env bash
set -euo pipefail
exec 3>&2

PRODUCT_ID="meshrix-js"
TARGET="runtime-ui"
DEFAULT_PORT=7228
SKILL_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SKILL_DIR/../.." && pwd)"
RELEASE_DEFINITION="$REPO_ROOT/tools/registry/release-definition.registry.json"
DOCKERFILE="$REPO_ROOT/Dockerfile"
PLATFORM=""
OUT_ROOT="$REPO_ROOT/build/offline-pack"
DRY_RUN=0
PRIVATE_ROOT=""
TREE_HELPER="$SKILL_DIR/validate-runtime-tree.mjs"
BUILD_IDENTITIES=()

for identity in "${HOME:-}" "$(hostname 2>/dev/null || true)" "$(git -C "$REPO_ROOT" config --get user.email 2>/dev/null || true)"; do
  case "$identity" in ""|root|node|runner|build|localhost) continue ;; esac
  BUILD_IDENTITIES+=("$identity")
done

usage() {
  cat <<'USAGE'
Usage: pack-offline.sh --platform linux/amd64|linux/arm64 [--out DIR] [--dry-run]
USAGE
}

fail() {
  local category="$1"
  local entry="${2:-none}"
  local status="${3:-1}"
  printf 'offline-pack: %s: %s\n' "$category" "$entry" >&3
  exit "$status"
}

cleanup() {
  if [ -n "$PRIVATE_ROOT" ] && [ -d "$PRIVATE_ROOT" ]; then
    rm -rf -- "$PRIVATE_ROOT" >/dev/null 2>&1 || true
  fi
}
interrupt() {
  cleanup
  trap - EXIT
  exit 130
}
trap cleanup EXIT
trap interrupt INT TERM

while [ "$#" -gt 0 ]; do
  case "$1" in
    --platform)
      [ "$#" -ge 2 ] || fail "invalid-option" "--platform"
      PLATFORM="$2"
      shift 2
      ;;
    --out)
      [ "$#" -ge 2 ] || fail "invalid-option" "--out"
      OUT_ROOT="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *) fail "invalid-option" "argument" ;;
  esac
done

case "$PLATFORM" in
  linux/amd64)
    ARCHITECTURE="amd64"
    GNU_TRIPLET="x86_64-linux-gnu"
    LOADER_PATH="lib64/ld-linux-x86-64.so.2"
    ;;
  linux/arm64)
    ARCHITECTURE="arm64"
    GNU_TRIPLET="aarch64-linux-gnu"
    LOADER_PATH="lib/ld-linux-aarch64.so.1"
    ;;
  "") fail "missing-platform" "platform-option" ;;
  *) fail "unsupported-platform" "platform" ;;
esac

[ -f "$RELEASE_DEFINITION" ] || fail "release-definition" "tools/registry/release-definition.registry.json"
[ -f "$DOCKERFILE" ] || fail "build-definition" "Dockerfile"
[ -f "$TREE_HELPER" ] || fail "runtime-validator" "validate-runtime-tree.mjs"
command -v node >/dev/null 2>&1 || fail "missing-build-tool" "node"

NODE_BASE_IMAGE="$(sed -nE 's/^ARG NODE_BASE_IMAGE=(node:[0-9][0-9A-Za-z.-]*@sha256:[0-9a-f]{64})$/\1/p' "$DOCKERFILE")"
[ "$(printf '%s\n' "$NODE_BASE_IMAGE" | sed '/^$/d' | wc -l | tr -d ' ')" = "1" ] || fail "build-definition" "NODE_BASE_IMAGE"
case "$NODE_BASE_IMAGE" in node:*@sha256:????????????????????????????????????????????????????????????????) ;; *) fail "build-definition" "NODE_BASE_IMAGE" ;; esac

release_fields="$({ node - "$RELEASE_DEFINITION" "$PLATFORM" <<'NODE'
const fs = require("node:fs");
const [definitionPath, selectedPlatform] = process.argv.slice(2);
let definition;
try {
  definition = JSON.parse(fs.readFileSync(definitionPath, "utf8"));
} catch {
  process.exit(10);
}
const version = definition?.release?.version;
const target = definition?.container?.target;
const platforms = definition?.container?.platforms;
if (typeof version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) process.exit(11);
if (target !== "runtime-ui") process.exit(12);
if (!Array.isArray(platforms) || !platforms.includes(selectedPlatform)) process.exit(13);
process.stdout.write(`${version}\n${target}\n`);
NODE
} 2>/dev/null)" || fail "release-definition" "tools/registry/release-definition.registry.json"
VERSION="$(printf '%s\n' "$release_fields" | sed -n '1p')"
RESOLVED_TARGET="$(printf '%s\n' "$release_fields" | sed -n '2p')"
[ "$RESOLVED_TARGET" = "$TARGET" ] || fail "release-target" "$RESOLVED_TARGET"
ARTIFACT_NAME="${PRODUCT_ID}-${VERSION}-linux-${ARCHITECTURE}.tar.gz"

if [ "$DRY_RUN" -eq 1 ]; then
  printf '%s\n' \
    "version=$VERSION" \
    "platform=$PLATFORM" \
    "target=$TARGET" \
    "artifact=$ARTIFACT_NAME" \
    "builder=docker buildx build --platform $PLATFORM --target $TARGET --build-arg NODE_BASE_IMAGE=$NODE_BASE_IMAGE --output type=local,dest=<private-temp> <repo-root>" \
    "result=result.json"
  exit 0
fi

command -v docker >/dev/null 2>&1 || fail "missing-build-tool" "docker"
docker buildx version 3>&- >/dev/null 2>&1 || fail "missing-build-tool" "docker-buildx"
command -v tar >/dev/null 2>&1 || fail "missing-build-tool" "tar"
command -v file >/dev/null 2>&1 || fail "missing-build-tool" "file"
case "$(LC_ALL=C tar --version 2>/dev/null | sed -n '1p')" in
  bsdtar*) TAR_OWNER_ARGS=(--uid 0 --gid 0 --uname root --gname root) ;;
  *"GNU tar"*) TAR_OWNER_ARGS=(--owner=0 --group=0 --numeric-owner) ;;
  *) fail "unsupported-build-tool" "tar" ;;
esac
[ -n "$OUT_ROOT" ] || fail "invalid-output-root" "configured-output"
[ ! -L "$OUT_ROOT" ] || fail "invalid-output-root" "configured-output"
mkdir -p -- "$OUT_ROOT" 2>/dev/null || fail "invalid-output-root" "configured-output"
[ -d "$OUT_ROOT" ] && [ ! -L "$OUT_ROOT" ] || fail "invalid-output-root" "configured-output"
chmod 700 "$OUT_ROOT" 2>/dev/null || fail "invalid-output-root" "configured-output"
PRIVATE_ROOT="$(mktemp -d "$OUT_ROOT/.meshrix-offline-pack.XXXXXX" 2>/dev/null)" || fail "private-staging" "unavailable"
chmod 700 "$PRIVATE_ROOT" 2>/dev/null || fail "private-staging" "unavailable"
exec 2>"$PRIVATE_ROOT/packer.log"
EXPORT_ROOT="$PRIVATE_ROOT/export"
ASSEMBLY_PARENT="$PRIVATE_ROOT/assembly"
BUNDLE_ROOT="$ASSEMBLY_PARENT/$PRODUCT_ID"
mkdir -p "$EXPORT_ROOT" "$BUNDLE_ROOT/app" "$BUNDLE_ROOT/bin" "$BUNDLE_ROOT/runtime-root"

builder=(docker buildx build --platform "$PLATFORM" --target "$TARGET" --build-arg "NODE_BASE_IMAGE=$NODE_BASE_IMAGE" --output "type=local,dest=$EXPORT_ROOT" "$REPO_ROOT")
if ! "${builder[@]}" 3>&- >"$PRIVATE_ROOT/builder.log" 2>&1; then
  if LC_ALL=C grep -Eiq -- 'unexpected EOF|error reading from server: EOF|rpc error: code = Unavailable|failed to (do request|resolve source metadata|copy)|connection reset|network is unreachable|no route to host|i/o timeout|TLS handshake timeout|blob.*(unknown|failed)|registry.*(unavailable|error)' "$PRIVATE_ROOT/builder.log"; then
    fail "blocked-by-environment" "$PLATFORM" 75
  fi
  fail "builder-failed" "$PLATFORM"
fi

require_file() {
  local relative="$1"
  [ -f "$EXPORT_ROOT/$relative" ] || fail "missing-runtime-entry" "$relative"
}

copy_tree() {
  local source_relative="$1"
  local destination_relative="$2"
  [ -d "$EXPORT_ROOT/$source_relative" ] || fail "missing-runtime-entry" "$source_relative"
  node "$TREE_HELPER" validate "$EXPORT_ROOT" "$EXPORT_ROOT/$source_relative" >/dev/null 2>&1 || fail "unsafe-runtime-entry" "runtime-tree"
  mkdir -p "$BUNDLE_ROOT/$destination_relative"
  (cd "$EXPORT_ROOT/$source_relative" && COPYFILE_DISABLE=1 tar -cf - .) | (cd "$BUNDLE_ROOT/$destination_relative" && COPYFILE_DISABLE=1 tar -xf -)
}

copy_file() {
  local source_relative="$1"
  local destination_relative="$2"
  require_file "$source_relative"
  node "$TREE_HELPER" copy-file "$EXPORT_ROOT" "$BUNDLE_ROOT" "$source_relative" "$destination_relative" >/dev/null 2>&1 || fail "unsafe-runtime-entry" "runtime-file"
}

prune_missing_plugin_workspace_links() {
  node - "$EXPORT_ROOT" "$EXPORT_ROOT/app/node_modules" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [exportInput, modulesInput] = process.argv.slice(2);
const exportRoot = fs.realpathSync(exportInput);
const modulesRoot = fs.realpathSync(modulesInput);
const pluginWorkspaceRoot = path.join(exportRoot, "app", "plugins", "agents");
const within = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);

const walk = (directory) => {
  for (const name of fs.readdirSync(directory)) {
    const candidate = path.join(directory, name);
    const entry = fs.lstatSync(candidate);
    if (entry.isDirectory()) {
      walk(candidate);
      continue;
    }
    if (!entry.isSymbolicLink()) continue;
    const target = fs.readlinkSync(candidate);
    if (path.isAbsolute(target)) continue;
    const lexicalTarget = path.resolve(path.dirname(candidate), target);
    if (!within(pluginWorkspaceRoot, lexicalTarget)) continue;
    try {
      fs.realpathSync(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      fs.unlinkSync(candidate);
    }
  }
};

walk(modulesRoot);
NODE
}

# Runtime allowlist: executable, its dynamic runtime, production dependencies,
# compiled server code, package metadata/runtime configuration, and built UI.
copy_file "usr/local/bin/node" "bin/node"
copy_file "bin/sh" "runtime-root/bin/sh"
copy_file "bin/mkdir" "runtime-root/bin/mkdir"
copy_file "$LOADER_PATH" "runtime-root/$LOADER_PATH"
copy_tree "lib/$GNU_TRIPLET" "runtime-root/lib/$GNU_TRIPLET"
copy_tree "usr/lib/$GNU_TRIPLET" "runtime-root/usr/lib/$GNU_TRIPLET"
prune_missing_plugin_workspace_links >/dev/null 2>&1 || fail "unsafe-runtime-entry" "runtime-tree"
copy_tree "app/node_modules" "app/node_modules"
copy_tree "app/dist" "app/dist"
copy_tree "app/build/dist" "app/build/dist"
copy_file "app/package.json" "app/package.json"
copy_file "app/LICENSE" "app/LICENSE"

for package_root in "$EXPORT_ROOT"/app/packages/*; do
  [ -d "$package_root" ] || continue
  package_name="$(basename "$package_root")"
  if [ -f "$package_root/package.json" ]; then
    copy_file "app/packages/$package_name/package.json" "app/packages/$package_name/package.json"
  fi
  if [ -f "$package_root/manifest.module.json" ]; then
    copy_file "app/packages/$package_name/manifest.module.json" "app/packages/$package_name/manifest.module.json"
  fi
  if [ -d "$package_root/dist" ]; then
    copy_tree "app/packages/$package_name/dist" "app/packages/$package_name/dist"
  fi
  for runtime_dir in config runtime-modules schemas; do
    if [ -d "$package_root/$runtime_dir" ]; then
      copy_tree "app/packages/$package_name/$runtime_dir" "app/packages/$package_name/$runtime_dir"
    fi
  done
done

for app_name in server console; do
  if [ -f "$EXPORT_ROOT/app/apps/$app_name/package.json" ]; then
    copy_file "app/apps/$app_name/package.json" "app/apps/$app_name/package.json"
  fi
done
if [ -d "$EXPORT_ROOT/app/tools/registry" ]; then
  copy_tree "app/tools/registry" "app/tools/registry"
fi

find "$BUNDLE_ROOT" -type f \( \
  -name '*.ts' -o -name '*.tsx' -o -name '*.d.ts' -o -name '*.map' -o \
  -name '*.c' -o -name '*.cc' -o -name '*.cpp' -o -name '*.h' -o -name '*.hpp' -o \
  -name '*.py' -o -name '*.log' -o -name '*.bak' -o -name '*.tmp' \
\) -delete
find "$BUNDLE_ROOT/app/node_modules" -type d \( \
  -name test -o -name tests -o -name coverage -o -name docs -o -name examples -o \
  -name .cache -o -name .github \
\) -prune -exec rm -rf {} +
find "$BUNDLE_ROOT/app/node_modules" -type f \( \
  -iname '*.md' -o -iname '*.markdown' -o -name '.package-lock.json' \
\) -delete

# Package metadata is runtime input, but authorship, funding, scripts, source
# locations, and registry provenance are not. Retain only Node resolution and
# platform-selection fields without changing their values.
node - "$BUNDLE_ROOT/app" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const retained = new Set([
  "name", "version", "type", "main", "module", "exports", "imports", "bin",
  "browser", "sideEffects", "cpu", "os", "libc", "binary"
]);
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walk(candidate);
    } else if (entry.name === "package.json") {
      const source = JSON.parse(fs.readFileSync(candidate, "utf8"));
      const output = {};
      for (const [key, value] of Object.entries(source)) {
        if (retained.has(key)) output[key] = value;
      }
      fs.writeFileSync(candidate, `${JSON.stringify(output)}\n`);
    }
  }
}
walk(root);
NODE
find "$BUNDLE_ROOT" -type d -empty -delete
chmod 755 "$BUNDLE_ROOT/bin/node"
chmod 755 "$BUNDLE_ROOT/runtime-root/bin/sh" "$BUNDLE_ROOT/runtime-root/bin/mkdir"

cat >"$BUNDLE_ROOT/start" <<EOF
#!/bin/sh
set -eu
[ "\$#" -eq 0 ] || { printf '%s\n' 'meshrix-js: unsupported-arguments' >&2; exit 2; }
umask 077
case "\$0" in
  */*) SCRIPT_DIR=\${0%/*} ;;
  *) SCRIPT_DIR=. ;;
esac
ROOT=\$(CDPATH= cd -- "\$SCRIPT_DIR" && pwd)
CDPATH= cd -- "\$ROOT"
LOADER="\$ROOT/runtime-root/$LOADER_PATH"
LIBRARY_PATH="\$ROOT/runtime-root/lib/$GNU_TRIPLET:\$ROOT/runtime-root/usr/lib/$GNU_TRIPLET"
"\$LOADER" --library-path "\$LIBRARY_PATH" "\$ROOT/runtime-root/bin/mkdir" -p "\$ROOT/data"
exec "\$LOADER" \\
  --library-path "\$LIBRARY_PATH" \\
  "\$ROOT/bin/node" "\$ROOT/app/dist/tools/server-scripts/start-server.js" \\
  --with-ui --host 0.0.0.0 --port $DEFAULT_PORT --data-dir "\$ROOT/data" --allow-public-console
EOF
chmod 755 "$BUNDLE_ROOT/start"

assert_architecture() {
  local candidate="$1"
  local entry="$2"
  local description
  description="$(file -b "$candidate" 2>/dev/null)" || fail "architecture-check" "$entry"
  case "$PLATFORM" in
    linux/amd64) printf '%s' "$description" | grep -Eqi 'ELF 64-bit.*(x86-64|x86_64)' || fail "architecture-mismatch" "$entry" ;;
    linux/arm64) printf '%s' "$description" | grep -Eqi 'ELF 64-bit.*(ARM aarch64|aarch64)' || fail "architecture-mismatch" "$entry" ;;
  esac
}

assert_architecture "$BUNDLE_ROOT/bin/node" "bin/node"
NATIVE_MODULE="$(find "$BUNDLE_ROOT/app/node_modules/better-sqlite3" -type f -name 'better_sqlite3.node' -print -quit 2>/dev/null || true)"
[ -n "$NATIVE_MODULE" ] || fail "missing-runtime-entry" "app/node_modules/better-sqlite3"
assert_architecture "$NATIVE_MODULE" "app/node_modules/better-sqlite3"

node - "$BUNDLE_ROOT/bundle.json" "$VERSION" "$PLATFORM" <<'NODE'
const fs = require("node:fs");
const [output, version, platform] = process.argv.slice(2);
const metadata = {
  product: "Meshrix.js",
  version,
  platform,
  target: "runtime-ui",
  defaultPort: 7228,
  surfaces: { console: "/", api: "/api/", health: "/api/healthz" },
  startEntrypoint: "./start"
};
fs.writeFileSync(output, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
NODE

scan_tree() {
  local root="$1"
  local scan_result="" category="" relative=""
  scan_result="$(node - "$root" "${BUILD_IDENTITIES[@]}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [rootInput, ...identities] = process.argv.slice(2);
const root = fs.realpathSync(rootInput);
const forbiddenDirectories = new Set([".git", ".cache", "coverage", "reports", "backups", "logs", "data"]);
const forbiddenFiles = new Set([".npmrc", "credentials.json", "id_rsa", "id_ed25519"]);
const forbiddenExtensions = [".ts", ".tsx", ".d.ts", ".map", ".log", ".bak", ".tmp", ".pem", ".key"];
const decoder = new TextDecoder("utf-8", { fatal: true });
const normalizedIdentities = identities.filter(Boolean).map((value) => value.toLowerCase());

const report = (category, candidate) => {
  process.stdout.write(`${category}\t${path.relative(root, candidate)}\n`);
  process.exit(0);
};

const textContent = (candidate) => {
  const bytes = fs.readFileSync(candidate);
  if (bytes.includes(0)) return null;
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
};

const walk = (directory) => {
  for (const name of fs.readdirSync(directory).sort()) {
    const candidate = path.join(directory, name);
    const entry = fs.lstatSync(candidate);
    if (entry.isDirectory()) {
      if (forbiddenDirectories.has(name)) report("forbidden-entry", candidate);
      walk(candidate);
      continue;
    }
    if (!entry.isFile()) continue;
    if (
      name === ".env" || name.startsWith(".env.") || forbiddenFiles.has(name) ||
      forbiddenExtensions.some((extension) => name.endsWith(extension))
    ) report("forbidden-entry", candidate);
    const text = textContent(candidate);
    if (text === null) continue;
    if (
      /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]{40,}?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(text) ||
      /(?:^|[^A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?:[^A-Z0-9]|$)/.test(text) ||
      /(?:^|[^A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,})(?:[^A-Za-z0-9]|$)/.test(text)
    ) report("secret-literal", candidate);
    if (/\/Users\/[^/\s]+\//.test(text) || /[A-Za-z]:\\Users\\[^\\\s]+\\/i.test(text)) {
      report("developer-identity", candidate);
    }
    const normalized = text.toLowerCase();
    if (normalizedIdentities.some((identity) => normalized.includes(identity))) {
      report("developer-identity", candidate);
    }
  }
};

walk(root);
NODE
)" || fail "scan-error" "runtime-tree"
  if [ -n "$scan_result" ]; then
    IFS=$'\t' read -r category relative <<<"$scan_result"
    case "$category" in forbidden-entry|secret-literal|developer-identity) fail "$category" "$relative" ;; esac
    fail "scan-error" "runtime-tree"
  fi
}

node "$TREE_HELPER" validate "$BUNDLE_ROOT" "$BUNDLE_ROOT" >/dev/null 2>&1 || fail "unsafe-runtime-entry" "runtime-tree"
scan_tree "$BUNDLE_ROOT"
CANDIDATE_ARCHIVE="$PRIVATE_ROOT/$ARTIFACT_NAME"
COPYFILE_DISABLE=1 tar -czf "$CANDIDATE_ARCHIVE" "${TAR_OWNER_ARGS[@]}" -C "$ASSEMBLY_PARENT" "$PRODUCT_ID"

while IFS= read -r archive_entry; do
  case "$archive_entry" in
    /*|../*|*/../*|*/..|*//* ) fail "unsafe-archive-entry" "$archive_entry" ;;
  esac
done < <(tar -tzf "$CANDIDATE_ARCHIVE")

VERIFY_ROOT="$PRIVATE_ROOT/verify"
mkdir -p "$VERIFY_ROOT"
tar -xzf "$CANDIDATE_ARCHIVE" -C "$VERIFY_ROOT"
node "$TREE_HELPER" validate "$VERIFY_ROOT/$PRODUCT_ID" "$VERIFY_ROOT/$PRODUCT_ID" >/dev/null 2>&1 || fail "unsafe-archive-entry" "runtime-tree"
scan_tree "$VERIFY_ROOT/$PRODUCT_ID"
[ -x "$VERIFY_ROOT/$PRODUCT_ID/start" ] || fail "missing-runtime-entry" "start"
[ -x "$VERIFY_ROOT/$PRODUCT_ID/bin/node" ] || fail "missing-runtime-entry" "bin/node"
[ -x "$VERIFY_ROOT/$PRODUCT_ID/runtime-root/bin/sh" ] || fail "missing-runtime-entry" "runtime-root/bin/sh"
[ -x "$VERIFY_ROOT/$PRODUCT_ID/runtime-root/bin/mkdir" ] || fail "missing-runtime-entry" "runtime-root/bin/mkdir"
[ -f "$VERIFY_ROOT/$PRODUCT_ID/app/dist/tools/server-scripts/start-server.js" ] || fail "missing-runtime-entry" "app/dist/tools/server-scripts/start-server.js"
[ -f "$VERIFY_ROOT/$PRODUCT_ID/app/build/dist/index.html" ] || fail "missing-runtime-entry" "app/build/dist/index.html"

RESULT_CANDIDATE="$PRIVATE_ROOT/result.json"
node - "$RESULT_CANDIDATE" "$ARTIFACT_NAME" "$VERSION" "$PLATFORM" <<'NODE'
const fs = require("node:fs");
const [output, artifactName, version, platform] = process.argv.slice(2);
fs.writeFileSync(output, `${JSON.stringify({ artifactName, version, platform })}\n`, { mode: 0o600 });
NODE
chmod 644 "$CANDIDATE_ARCHIVE" "$RESULT_CANDIDATE"
mv -f "$CANDIDATE_ARCHIVE" "$OUT_ROOT/$ARTIFACT_NAME"
mv -f "$RESULT_CANDIDATE" "$OUT_ROOT/result.json"
printf 'offline-pack: completed: %s\n' "$ARTIFACT_NAME"
