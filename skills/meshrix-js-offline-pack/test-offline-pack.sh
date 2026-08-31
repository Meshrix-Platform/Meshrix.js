#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PACK_SCRIPT="$SKILL_DIR/pack-offline.sh"
MODE="${1:-}"
TEST_PRIVATE_ROOT=""
REAL_IMAGES=()
REAL_CONTAINERS=()
VERIFY_IDENTITIES=()

for identity in "${HOME:-}" "$(hostname 2>/dev/null || true)" "$(git -C "$SKILL_DIR/../.." config --get user.email 2>/dev/null || true)"; do
  case "$identity" in ""|root|node|runner|build|localhost) continue ;; esac
  VERIFY_IDENTITIES+=("$identity")
done

cleanup_test_root() {
  local resource
  for resource in "${REAL_CONTAINERS[@]}"; do
    docker rm -f "$resource" >/dev/null 2>&1 || true
  done
  for resource in "${REAL_IMAGES[@]}"; do
    docker image rm "$resource" >/dev/null 2>&1 || true
  done
  if [ -n "$TEST_PRIVATE_ROOT" ] && [ -d "$TEST_PRIVATE_ROOT" ]; then
    rm -rf -- "$TEST_PRIVATE_ROOT" >/dev/null 2>&1 || true
  fi
}

interrupt_test() {
  cleanup_test_root
  trap - EXIT
  exit 130
}

fail() {
  printf 'offline-pack-test: failed: %s\n' "$1" >&2
  exit 1
}

assert_status() {
  local expected="$1" actual
  shift
  if "$@"; then actual=0; else actual=$?; fi
  [ "$actual" = "$expected" ]
}

assert_existing_fails() {
  local supplied_root="$1" platform="$2" fake_bin="$3" log="$4" status
  set +e
  env PATH="$fake_bin:$PATH" bash "$SKILL_DIR/test-offline-pack.sh" --existing-output --platform "$platform" "$supplied_root" > /dev/null 2>"$log"
  status=$?
  set -e
  [ "$status" = "1" ] || fail "existing-output-unexpected-status"
  grep -Eq '^offline-pack-test: failed: [a-z0-9_-]+$' "$log" || fail "existing-output-unsafe-error"
  ! grep -Fq -- "$supplied_root" "$log" || fail "existing-output-path-disclosed"
}

make_fake_export() {
  local destination="$1"
  mkdir -p \
    "$destination/usr/local/bin" \
    "$destination/bin" \
    "$destination/lib64" \
    "$destination/lib/x86_64-linux-gnu" \
    "$destination/lib/aarch64-linux-gnu" \
    "$destination/usr/lib/x86_64-linux-gnu" \
    "$destination/usr/lib/aarch64-linux-gnu" \
    "$destination/app/node_modules/@meshrix" \
    "$destination/app/node_modules/example" \
    "$destination/app/node_modules/better-sqlite3/build/Release" \
    "$destination/app/dist/tools/server-scripts" \
    "$destination/app/build/dist" \
    "$destination/app/packages/foundation/dist" \
    "$destination/app/packages/foundation/config" \
    "$destination/app/apps/server" \
    "$destination/app/apps/console" \
    "$destination/app/tools/registry/state-machines"
  case "${OFFLINE_PACK_FAKE_EXPORT_PLATFORM:-linux/amd64}:${OFFLINE_PACK_FAKE_WRONG_ARCH:-0}" in
    linux/amd64:0|linux/arm64:1) printf 'fake-elf-amd64\n' >"$destination/usr/local/bin/node" ;;
    *) printf 'fake-elf-arm64\n' >"$destination/usr/local/bin/node" ;;
  esac
  printf '#!/bin/sh\nexit 0\n' >"$destination/bin/sh"
  printf '#!/bin/sh\nexit 0\n' >"$destination/bin/mkdir"
  chmod 755 "$destination/usr/local/bin/node"
  chmod 755 "$destination/bin/sh" "$destination/bin/mkdir"
  printf 'loader\n' >"$destination/lib64/ld-linux-x86-64.so.2"
  printf 'loader\n' >"$destination/lib/ld-linux-aarch64.so.1"
  printf 'library\n' >"$destination/lib/x86_64-linux-gnu/libc.so.6"
  printf 'library\n' >"$destination/lib/aarch64-linux-gnu/libc.so.6"
  printf 'library\n' >"$destination/usr/lib/x86_64-linux-gnu/libstdc++.so.6"
  printf 'library\n' >"$destination/usr/lib/aarch64-linux-gnu/libstdc++.so.6"
  printf '{"name":"example"}\n' >"$destination/app/node_modules/example/package.json"
  printf 'export const preserved = "Valorius x-valorius-operation";\n' >"$destination/app/node_modules/example/index.js"
  ln -s "index.js" "$destination/app/node_modules/example/runtime.js"
  ln -s "../../plugins/agents/unshipped" "$destination/app/node_modules/@meshrix/unshipped-agent"
  printf '{"name":"better-sqlite3"}\n' >"$destination/app/node_modules/better-sqlite3/package.json"
  cp "$destination/usr/local/bin/node" "$destination/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
  printf 'export {};\n' >"$destination/app/dist/tools/server-scripts/start-server.js"
  printf 'export {};\n' >"$destination/app/dist/source.ts"
  printf '{}\n' >"$destination/app/dist/source.js.map"
  printf '<!doctype html><html><title>Meshrix.js</title></html>\n' >"$destination/app/build/dist/index.html"
  printf '{"name":"meshrix-js","type":"module"}\n' >"$destination/app/package.json"
  printf 'license\n' >"$destination/app/LICENSE"
  printf '{"name":"@meshrix/foundation","type":"module"}\n' >"$destination/app/packages/foundation/package.json"
  printf 'export {};\n' >"$destination/app/packages/foundation/dist/index.js"
  printf '{}\n' >"$destination/app/packages/foundation/config/runtime.json"
  printf '{"name":"@meshrix/server","type":"module"}\n' >"$destination/app/apps/server/package.json"
  printf '{"name":"@meshrix/console","type":"module"}\n' >"$destination/app/apps/console/package.json"
  printf '{}\n' >"$destination/app/tools/registry/state-machines/state-machine-integrity.registry.json"
  if [ "${OFFLINE_PACK_FAKE_PRIVACY_FIXTURE:-0}" = "1" ]; then
    printf 'private path: <user-home>/offline-pack/work\n' >"$destination/app/dist/private.js"
  fi
  if [ "${OFFLINE_PACK_FAKE_SECRET_FILE:-0}" = "1" ]; then
    printf 'synthetic=true\n' >"$destination/app/dist/.env"
  fi
  if [ "${OFFLINE_PACK_FAKE_SECRET_LITERAL:-0}" = "1" ]; then
    printf '%s%s\n' 'AKIA' 'TEST-CASE-EXAMPLE' >"$destination/app/dist/credential.js"
  fi
  if [ "${OFFLINE_PACK_FAKE_FORBIDDEN_DIR:-0}" = "1" ]; then
    mkdir -p "$destination/app/dist/reports"
    printf '{}\n' >"$destination/app/dist/reports/result.json"
  fi
  if [ "${OFFLINE_PACK_FAKE_UNSAFE_LINK:-0}" = "1" ]; then
    ln -s "/private/offline-pack-fixture" "$destination/app/node_modules/example/escape"
  fi
  if [ "${OFFLINE_PACK_FAKE_SPECIAL_ENTRY:-0}" = "1" ]; then
    mkfifo "$destination/app/node_modules/example/runtime.pipe"
  fi
}

run_contract() {
  local root fake_repo fake_bin out out_arm64 log success_log artifact artifact_arm64 digest_before digest_after extracted normalized identity_log secret_file_log secret_literal_log forbidden_dir_log unsafe_log special_log architecture_log symlink_log symlink_out invalid_existing invalid_log wrong_existing wrong_tree unsafe_existing unsafe_tree blocked_log blocked_status session_log session_status ordinary_log ordinary_status
  root="$(mktemp -d "${TMPDIR:-/tmp}/meshrix-offline-contract.XXXXXX" 2>/dev/null)" || fail "private-root"
  TEST_PRIVATE_ROOT="$root"
  trap cleanup_test_root EXIT
  trap interrupt_test INT TERM
  fake_repo="$root/repo"
  fake_bin="$root/bin"
  out="$root/out"
  log="$root/builder.log"
  mkdir -p "$fake_repo/skills/meshrix-js-offline-pack" "$fake_repo/tools/registry" "$fake_bin" "$out"
  cp "$PACK_SCRIPT" "$fake_repo/skills/meshrix-js-offline-pack/pack-offline.sh"
  cp "$SKILL_DIR/validate-runtime-tree.mjs" "$fake_repo/skills/meshrix-js-offline-pack/validate-runtime-tree.mjs"
  chmod 755 "$fake_repo/skills/meshrix-js-offline-pack/pack-offline.sh"
  cat >"$fake_repo/tools/registry/release-definition.registry.json" <<'JSON'
{"release":{"version":"9.8.7"},"container":{"target":"runtime-ui","platforms":["linux/amd64","linux/arm64"]}}
JSON
  printf '%s\n' 'ARG NODE_BASE_IMAGE=node:24.16.0-bookworm-slim@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' >"$fake_repo/Dockerfile"
  cat >"$fake_bin/docker" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
if { printf '%s\n' 'private descriptor detail' >&3; } 2>/dev/null; then :; fi
if [ "${1:-}" = "buildx" ] && [ "${2:-}" = "version" ]; then exit 0; fi
[ "${1:-}" = "buildx" ] && [ "${2:-}" = "build" ] || exit 91
printf '%s\n' "$*" >>"$OFFLINE_PACK_FAKE_LOG"
case "${OFFLINE_PACK_FAKE_BUILDER_RESULT:-success}" in
  transfer-blocked) printf '%s\n' 'failed to resolve source metadata: private transfer detail' >&2; exit 86 ;;
  session-blocked) printf '%s\n' 'rpc error: code = Unavailable desc = error reading from server: EOF' >&2; exit 85 ;;
  ordinary-failure) printf '%s\n' 'ordinary private builder diagnostic' >&2; exit 87 ;;
  success) ;;
  *) exit 88 ;;
esac
destination=""
platform=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--platform" ]; then
    platform="$2"
  fi
  if [ "$1" = "--output" ]; then
    destination="${2#type=local,dest=}"
    break
  fi
  shift
done
[ -n "$destination" ] || exit 92
[ -n "$platform" ] || exit 93
source "$OFFLINE_PACK_FAKE_HELPER"
OFFLINE_PACK_FAKE_EXPORT_PLATFORM="$platform" make_fake_export "$destination"
FAKE
  chmod 755 "$fake_bin/docker"
  cat >"$fake_bin/file" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
candidate="${!#}"
case "$(sed -n '1p' "$candidate")" in
  fake-elf-amd64) printf '%s\n' 'ELF 64-bit LSB executable, x86-64' ;;
  fake-elf-arm64) printf '%s\n' 'ELF 64-bit LSB executable, ARM aarch64' ;;
  *) exit 1 ;;
esac
FAKE
  chmod 755 "$fake_bin/file"
  export OFFLINE_PACK_FAKE_LOG="$log"
  export OFFLINE_PACK_FAKE_HELPER="$SKILL_DIR/test-offline-pack.sh"

  PATH="$fake_bin:$PATH" "$fake_repo/skills/meshrix-js-offline-pack/pack-offline.sh" --platform linux/amd64 --out "$out" --dry-run >"$root/dry-amd64"
  PATH="$fake_bin:$PATH" "$fake_repo/skills/meshrix-js-offline-pack/pack-offline.sh" --platform linux/arm64 --out "$out" --dry-run >"$root/dry-arm64"
  grep -Fx 'builder=docker buildx build --platform linux/amd64 --target runtime-ui --build-arg NODE_BASE_IMAGE=node:24.16.0-bookworm-slim@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --output type=local,dest=<private-temp> <repo-root>' "$root/dry-amd64" >/dev/null || fail "dry-run-builder-vector"
  grep -Fx 'artifact=meshrix-js-9.8.7-linux-arm64.tar.gz' "$root/dry-arm64" >/dev/null || fail "dry-run-artifact"

  assert_status 1 "$fake_repo/skills/meshrix-js-offline-pack/pack-offline.sh" >/dev/null 2>&1 || fail "missing-platform-status"
  assert_status 1 "$fake_repo/skills/meshrix-js-offline-pack/pack-offline.sh" --platform darwin/arm64 >/dev/null 2>&1 || fail "unsupported-platform-status"
  assert_status 1 "$fake_repo/skills/meshrix-js-offline-pack/pack-offline.sh" --platform linux/amd64 --deps >/dev/null 2>&1 || fail "invalid-option-status"
  assert_status 1 "$fake_repo/skills/meshrix-js-offline-pack/pack-offline.sh" --platform linux/amd64 --out >/dev/null 2>&1 || fail "missing-output-status"
  mkdir -p "$root/symlink-target"
  symlink_out="$root/symlink-out"
  ln -s "$root/symlink-target" "$symlink_out"
  symlink_log="$root/symlink-output.log"
  assert_status 1 env PATH="$fake_bin:$PATH" "$fake_repo/skills/meshrix-js-offline-pack/pack-offline.sh" --platform linux/amd64 --out "$symlink_out" >/dev/null 2>"$symlink_log" || fail "symlink-output-status"
  grep -Fx 'offline-pack: invalid-output-root: configured-output' "$symlink_log" >/dev/null || fail "symlink-output-category"
  ! grep -Eq 'docker[[:space:]]+pull' "$SKILL_DIR/test-offline-pack.sh" || fail "real-harness-pulls-image"
  grep -Fq 'docker import --platform' "$SKILL_DIR/test-offline-pack.sh" || fail "real-harness-not-self-contained"
  grep -Fq -- '--network none' "$SKILL_DIR/test-offline-pack.sh" || fail "real-harness-network"
  ! grep -Eq -- '--mou[n]t' "$SKILL_DIR/test-offline-pack.sh" || fail "real-harness-mount"

  success_log="$root/success.log"
  PATH="$fake_bin:$PATH" "$fake_repo/skills/meshrix-js-offline-pack/pack-offline.sh" --platform linux/amd64 --out "$out" >/dev/null 2>"$success_log"
  [ ! -s "$success_log" ] || fail "builder-private-channel"
  artifact="$out/meshrix-js-9.8.7-linux-amd64.tar.gz"
  [ -f "$artifact" ] || fail "contract-artifact-missing"
  [ -f "$out/result.json" ] || fail "contract-result-missing"
  node - "$out" <<'NODE'
const fs = require("node:fs");
if ((fs.statSync(process.argv[2]).mode & 0o777) !== 0o700) process.exit(1);
NODE
  node - "$out/result.json" <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const keys = Object.keys(value);
if (keys.join(",") !== "artifactName,version,platform") process.exit(1);
if (value.artifactName !== "meshrix-js-9.8.7-linux-amd64.tar.gz" || value.version !== "9.8.7" || value.platform !== "linux/amd64") process.exit(1);
NODE
  [ "$(wc -l <"$log" | tr -d ' ')" = "1" ] || fail "builder-count"
  normalized="$(sed -E 's#type=local,dest=[^ ]+#type=local,dest=<private-temp>#; s# [^ ]+/repo$# <repo-root>#' "$log")"
  [ "$normalized" = 'buildx build --platform linux/amd64 --target runtime-ui --build-arg NODE_BASE_IMAGE=node:24.16.0-bookworm-slim@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --output type=local,dest=<private-temp> <repo-root>' ] || fail "builder-vector"
  out_arm64="$root/out-arm64"
  mkdir "$out_arm64"
  blocked_log="$root/blocked.log"
  set +e
  OFFLINE_PACK_FAKE_BUILDER_RESULT=transfer-blocked PATH="$fake_bin:$PATH" "$fake_repo/skills/meshrix-js-offline-pack/pack-offline.sh" --platform linux/arm64 --out "$out_arm64" >/dev/null 2>"$blocked_log"
  blocked_status=$?
  set -e
  [ "$blocked_status" = "75" ] || fail "blocked-builder-status"
  grep -Fx 'offline-pack: blocked-by-environment: linux/arm64' "$blocked_log" >/dev/null || fail "blocked-builder-category"
  ! grep -Fq 'private transfer detail' "$blocked_log" || fail "blocked-builder-diagnostic-disclosed"
  session_log="$root/session.log"
  set +e
  OFFLINE_PACK_FAKE_BUILDER_RESULT=session-blocked PATH="$fake_bin:$PATH" "$fake_repo/skills/meshrix-js-offline-pack/pack-offline.sh" --platform linux/arm64 --out "$out_arm64" >/dev/null 2>"$session_log"
  session_status=$?
  set -e
  [ "$session_status" = "75" ] || fail "blocked-session-status"
  grep -Fx 'offline-pack: blocked-by-environment: linux/arm64' "$session_log" >/dev/null || fail "blocked-session-category"
  ! grep -Fq 'rpc error' "$session_log" || fail "blocked-session-diagnostic-disclosed"
  ordinary_log="$root/ordinary.log"
  set +e
  OFFLINE_PACK_FAKE_BUILDER_RESULT=ordinary-failure PATH="$fake_bin:$PATH" "$fake_repo/skills/meshrix-js-offline-pack/pack-offline.sh" --platform linux/arm64 --out "$out_arm64" >/dev/null 2>"$ordinary_log"
  ordinary_status=$?
  set -e
  [ "$ordinary_status" = "1" ] || fail "ordinary-builder-status"
  grep -Fx 'offline-pack: builder-failed: linux/arm64' "$ordinary_log" >/dev/null || fail "ordinary-builder-category"
  ! grep -Fq 'ordinary private builder diagnostic' "$ordinary_log" || fail "ordinary-builder-diagnostic-disclosed"
  ! grep -Fq 'private descriptor detail' "$blocked_log" "$session_log" "$ordinary_log" || fail "builder-private-channel"
  prove_start() { :; }
  PATH="$fake_bin:$PATH" verify_existing_output "$out" linux/amd64 >/dev/null
  [ "$(wc -l <"$log" | tr -d ' ')" = "4" ] || fail "existing-output-called-packer"
  PATH="$fake_bin:$PATH" "$fake_repo/skills/meshrix-js-offline-pack/pack-offline.sh" --platform linux/arm64 --out "$out_arm64" >/dev/null 2>"$success_log"
  [ ! -s "$success_log" ] || fail "builder-private-channel"
  artifact_arm64="$out_arm64/meshrix-js-9.8.7-linux-arm64.tar.gz"
  PATH="$fake_bin:$PATH" verify_existing_output "$out_arm64" linux/arm64 >/dev/null
  [ "$(wc -l <"$log" | tr -d ' ')" = "5" ] || fail "existing-output-called-packer"
  normalized="$(sed -E 's#type=local,dest=[^ ]+#type=local,dest=<private-temp>#; s# [^ ]+/repo$# <repo-root>#' "$log" | sed -n '2,5p' | sort -u)"
  [ "$normalized" = 'buildx build --platform linux/arm64 --target runtime-ui --build-arg NODE_BASE_IMAGE=node:24.16.0-bookworm-slim@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --output type=local,dest=<private-temp> <repo-root>' ] || fail "builder-vector-arm64"

  invalid_existing="$root/invalid-existing"
  invalid_log="$root/invalid-existing.log"
  mkdir "$invalid_existing"
  cp "$artifact" "$invalid_existing/$(basename "$artifact")"
  printf '%s\n' '{"artifactName":"../private","version":"9.8.7","platform":"linux/amd64"}' >"$invalid_existing/result.json"
  assert_existing_fails "$invalid_existing" linux/amd64 "$fake_bin" "$invalid_log"
  printf '%s\n' 'null' >"$invalid_existing/result.json"
  assert_existing_fails "$invalid_existing" linux/amd64 "$fake_bin" "$invalid_log"
  head -c 5000 /dev/zero | tr '\0' x >"$invalid_existing/result.json"
  assert_existing_fails "$invalid_existing" linux/amd64 "$fake_bin" "$invalid_log"
  rm "$invalid_existing/result.json"
  ln -s "$out/result.json" "$invalid_existing/result.json"
  assert_existing_fails "$invalid_existing" linux/amd64 "$fake_bin" "$invalid_log"
  rm "$invalid_existing/result.json" "$invalid_existing/$(basename "$artifact")"
  cp "$out/result.json" "$invalid_existing/result.json"
  ln -s "$artifact" "$invalid_existing/$(basename "$artifact")"
  assert_existing_fails "$invalid_existing" linux/amd64 "$fake_bin" "$invalid_log"

  wrong_existing="$root/wrong-architecture-existing"
  wrong_tree="$root/wrong-architecture-tree"
  mkdir "$wrong_existing" "$wrong_tree"
  tar -xzf "$artifact" -C "$wrong_tree"
  node - "$wrong_tree/meshrix-js/bundle.json" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const value = JSON.parse(fs.readFileSync(file, "utf8"));
value.platform = "linux/arm64";
fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
NODE
  tar -czf "$wrong_existing/meshrix-js-9.8.7-linux-arm64.tar.gz" -C "$wrong_tree" meshrix-js
  printf '%s\n' '{"artifactName":"meshrix-js-9.8.7-linux-arm64.tar.gz","version":"9.8.7","platform":"linux/arm64"}' >"$wrong_existing/result.json"
  assert_existing_fails "$wrong_existing" linux/arm64 "$fake_bin" "$invalid_log"

  unsafe_existing="$root/unsafe-existing"
  unsafe_tree="$root/unsafe-tree"
  mkdir "$unsafe_existing" "$unsafe_tree"
  tar -xzf "$artifact" -C "$unsafe_tree"
  printf '%s%s\n' 'ghp_' 'AAAAAAAAAAAAAAAAAAAA' >"$unsafe_tree/meshrix-js/app/dist/credential.js"
  tar -czf "$unsafe_existing/$(basename "$artifact")" -C "$unsafe_tree" meshrix-js
  cp "$out/result.json" "$unsafe_existing/result.json"
  assert_existing_fails "$unsafe_existing" linux/amd64 "$fake_bin" "$invalid_log"
  rm -rf "$unsafe_tree"
  mkdir "$unsafe_tree"
  tar -xzf "$artifact" -C "$unsafe_tree"
  printf '%s\n' 'unexpected' >"$unsafe_tree/extra-entry"
  tar -czf "$unsafe_existing/$(basename "$artifact")" -C "$unsafe_tree" meshrix-js extra-entry
  assert_existing_fails "$unsafe_existing" linux/amd64 "$fake_bin" "$invalid_log"
  [ "$(wc -l <"$log" | tr -d ' ')" = "5" ] || fail "existing-output-called-packer"
  if tar -tzf "$artifact" | grep -Eq '(^|/)(source|runtime-deps|SHA256SUMS|README-PACKING\.md)(/|$)|\.(ts|d\.ts|map)$'; then
    fail "legacy-or-source-entry"
  fi
  tar -tvzf "$artifact" | awk '$2 == "root/root" || ($3 == "root" && $4 == "root") { next } { exit 1 }' || fail "archive-owner-not-normalized"
  extracted="$root/extracted"
  mkdir -p "$extracted"
  tar -xzf "$artifact" -C "$extracted"
  grep -F 'Valorius x-valorius-operation' "$extracted/meshrix-js/app/node_modules/example/index.js" >/dev/null || fail "behavior-not-preserved"
  [ "$(readlink "$extracted/meshrix-js/app/node_modules/example/runtime.js")" = "index.js" ] || fail "safe-link-not-preserved"
  [ ! -e "$extracted/meshrix-js/app/node_modules/@meshrix/unshipped-agent" ] || fail "missing-plugin-workspace-link-preserved"
  [ ! -L "$extracted/meshrix-js/app/node_modules/@meshrix/unshipped-agent" ] || fail "missing-plugin-workspace-link-preserved"
  grep -Fq 'CDPATH= cd -- "$ROOT"' "$extracted/meshrix-js/start" || fail "runtime-working-directory"
  grep -Fq '"$LOADER" --library-path "$LIBRARY_PATH" "$ROOT/runtime-root/bin/mkdir"' "$extracted/meshrix-js/start" || fail "mkdir-not-bundled"
  node - "$extracted/meshrix-js/bundle.json" <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const expected = ["product", "version", "platform", "target", "defaultPort", "surfaces", "startEntrypoint"];
if (Object.keys(value).join(",") !== expected.join(",")) process.exit(1);
if (value.target !== "runtime-ui" || value.defaultPort !== 7228 || value.startEntrypoint !== "./start") process.exit(1);
if (JSON.stringify(value.surfaces) !== JSON.stringify({console:"/",api:"/api/",health:"/api/healthz"})) process.exit(1);
NODE
  digest_before="$(shasum -a 256 "$artifact" | awk '{print $1}')"
  identity_log="$root/identity.log"
  assert_status 1 env OFFLINE_PACK_FAKE_PRIVACY_FIXTURE=1 PATH="$fake_bin:$PATH" "$fake_repo/skills/meshrix-js-offline-pack/pack-offline.sh" --platform linux/amd64 --out "$out" >/dev/null 2>"$identity_log" || fail "developer-identity-status"
  grep -Fx 'offline-pack: developer-identity: app/dist/private.js' "$identity_log" >/dev/null || fail "developer-identity-category"
  ! grep -Fq '<user-home>/offline-pack/work' "$identity_log" || fail "developer-identity-disclosed"
  digest_after="$(shasum -a 256 "$artifact" | awk '{print $1}')"
  [ "$digest_before" = "$digest_after" ] || fail "prior-artifact-replaced-on-failure"
  secret_file_log="$root/secret-file.log"
  assert_status 1 env OFFLINE_PACK_FAKE_SECRET_FILE=1 PATH="$fake_bin:$PATH" "$fake_repo/skills/meshrix-js-offline-pack/pack-offline.sh" --platform linux/amd64 --out "$out" >/dev/null 2>"$secret_file_log" || fail "secret-file-status"
  grep -Fx 'offline-pack: forbidden-entry: app/dist/.env' "$secret_file_log" >/dev/null || fail "secret-file-category"
  secret_literal_log="$root/secret-literal.log"
  assert_status 1 env OFFLINE_PACK_FAKE_SECRET_LITERAL=1 PATH="$fake_bin:$PATH" "$fake_repo/skills/meshrix-js-offline-pack/pack-offline.sh" --platform linux/amd64 --out "$out" >/dev/null 2>"$secret_literal_log" || fail "secret-literal-status"
  grep -Fx 'offline-pack: secret-literal: app/dist/credential.js' "$secret_literal_log" >/dev/null || fail "secret-literal-category"
  ! grep -Fq 'AKIATEST-CASE-EXAMPLE' "$secret_literal_log" || fail "secret-literal-disclosed"
  forbidden_dir_log="$root/forbidden-directory.log"
  assert_status 1 env OFFLINE_PACK_FAKE_FORBIDDEN_DIR=1 PATH="$fake_bin:$PATH" "$fake_repo/skills/meshrix-js-offline-pack/pack-offline.sh" --platform linux/amd64 --out "$out" >/dev/null 2>"$forbidden_dir_log" || fail "forbidden-directory-status"
  grep -Fx 'offline-pack: forbidden-entry: app/dist/reports' "$forbidden_dir_log" >/dev/null || fail "forbidden-directory-category"
  digest_after="$(shasum -a 256 "$artifact" | awk '{print $1}')"
  [ "$digest_before" = "$digest_after" ] || fail "prior-artifact-replaced-on-privacy-failure"
  unsafe_log="$root/unsafe-link.log"
  assert_status 1 env OFFLINE_PACK_FAKE_UNSAFE_LINK=1 PATH="$fake_bin:$PATH" "$fake_repo/skills/meshrix-js-offline-pack/pack-offline.sh" --platform linux/amd64 --out "$out" >/dev/null 2>"$unsafe_log" || fail "unsafe-link-status"
  grep -Fx 'offline-pack: unsafe-runtime-entry: runtime-tree' "$unsafe_log" >/dev/null || fail "unsafe-link-category"
  ! grep -Fq '/private/offline-pack-fixture' "$unsafe_log" || fail "unsafe-link-disclosed"
  digest_after="$(shasum -a 256 "$artifact" | awk '{print $1}')"
  [ "$digest_before" = "$digest_after" ] || fail "prior-artifact-replaced-on-unsafe-link"
  special_log="$root/special-entry.log"
  assert_status 1 env OFFLINE_PACK_FAKE_SPECIAL_ENTRY=1 PATH="$fake_bin:$PATH" "$fake_repo/skills/meshrix-js-offline-pack/pack-offline.sh" --platform linux/amd64 --out "$out" >/dev/null 2>"$special_log" || fail "special-entry-status"
  grep -Fx 'offline-pack: unsafe-runtime-entry: runtime-tree' "$special_log" >/dev/null || fail "special-entry-category"
  digest_after="$(shasum -a 256 "$artifact" | awk '{print $1}')"
  [ "$digest_before" = "$digest_after" ] || fail "prior-artifact-replaced-on-special-entry"
  architecture_log="$root/architecture.log"
  assert_status 1 env OFFLINE_PACK_FAKE_WRONG_ARCH=1 PATH="$fake_bin:$PATH" "$fake_repo/skills/meshrix-js-offline-pack/pack-offline.sh" --platform linux/amd64 --out "$out" >/dev/null 2>"$architecture_log" || fail "wrong-architecture-status"
  grep -Fx 'offline-pack: architecture-mismatch: bin/node' "$architecture_log" >/dev/null || fail "wrong-architecture-category"
  digest_after="$(shasum -a 256 "$artifact" | awk '{print $1}')"
  [ "$digest_before" = "$digest_after" ] || fail "prior-artifact-replaced-on-wrong-architecture"
  printf 'offline-pack-test: contract: passed\n'
}

assert_architecture() {
  local path="$1" platform="$2" description arch
  case "$platform" in
    linux/amd64) arch="amd64" ;;
    linux/arm64) arch="arm64" ;;
    *) fail "unsupported-real-platform" ;;
  esac
  description="$(file -b "$path" 2>/dev/null)" || fail "elf-inspection-$arch"
  case "$platform" in
    linux/amd64) printf '%s' "$description" | grep -Eqi 'ELF 64-bit.*(x86-64|x86_64)' || fail "elf-architecture-amd64" ;;
    linux/arm64) printf '%s' "$description" | grep -Eqi 'ELF 64-bit.*(ARM aarch64|aarch64)' || fail "elf-architecture-arm64" ;;
  esac
}

prove_start() {
  local bundle="$1" platform="$2" proof_root arch image_name container_name
  local loader library_path shell_path exit_status process_count mounts running
  arch="${platform#linux/}"
  proof_root="$TEST_PRIVATE_ROOT/$arch/proof-rootfs"
  image_name="meshrix-offline-proof-${arch}-$$"
  container_name="meshrix-offline-proof-${arch}-$$"
  mkdir -p "$proof_root/bundle" 2>/dev/null || fail "target-setup-$arch"
  if ! (cd "$bundle" && COPYFILE_DISABLE=1 tar -cf - .) 2>/dev/null \
    | (cd "$proof_root/bundle" && COPYFILE_DISABLE=1 tar -xf -) 2>/dev/null; then
    fail "target-setup-$arch"
  fi

  case "$platform" in
    linux/amd64)
      loader="/bundle/runtime-root/lib64/ld-linux-x86-64.so.2"
      library_path="/bundle/runtime-root/lib/x86_64-linux-gnu:/bundle/runtime-root/usr/lib/x86_64-linux-gnu"
      ;;
    linux/arm64)
      loader="/bundle/runtime-root/lib/ld-linux-aarch64.so.1"
      library_path="/bundle/runtime-root/lib/aarch64-linux-gnu:/bundle/runtime-root/usr/lib/aarch64-linux-gnu"
      ;;
    *) fail "unsupported-real-platform" ;;
  esac
  shell_path="/bundle/runtime-root/bin/sh"

  if ! COPYFILE_DISABLE=1 tar -cf - -C "$proof_root" . 2>/dev/null \
    | docker import --platform "$platform" - "$image_name" >/dev/null 2>&1; then
    fail "target-import-$arch"
  fi
  REAL_IMAGES+=("$image_name")
  docker create --platform "$platform" --network none --name "$container_name" \
    --entrypoint "$loader" "$image_name" \
    --library-path "$library_path" "$shell_path" /bundle/start >/dev/null 2>&1 \
    || fail "target-create-$arch"
  REAL_CONTAINERS+=("$container_name")
  mounts="$(docker inspect --format '{{json .Mounts}}' "$container_name" 2>/dev/null)" || fail "target-inspect-$arch"
  [ "$mounts" = "[]" ] || fail "target-has-mounts-$arch"
  docker start "$container_name" >/dev/null 2>&1 || fail "target-start-$arch"

  while ! docker exec "$container_name" "$loader" --library-path "$library_path" \
    /bundle/bin/node -e 'fetch("http://127.0.0.1:7228/api/healthz").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' \
    >/dev/null 2>&1; do
    running="$(docker inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null)" || fail "target-inspect-$arch"
    [ "$running" = "true" ] || fail "target-start-$arch"
    sleep 1
  done

  docker exec "$container_name" "$loader" --library-path "$library_path" /bundle/bin/node -e '
    const fs = require("node:fs");
    const request = async () => {
      const [root, health] = await Promise.all([
        fetch("http://127.0.0.1:7228/"),
        fetch("http://127.0.0.1:7228/api/healthz")
      ]);
      if (!root.ok || !health.ok || !(await root.text()).toLowerCase().includes("html")) process.exit(1);
      const listeners = ["/proc/net/tcp", "/proc/net/tcp6"].flatMap((file) => {
        try { return fs.readFileSync(file, "utf8").trim().split("\n").slice(1); } catch { return []; }
      }).map((line) => line.trim().split(/\s+/)).filter((fields) => fields[3] === "0A");
      if (listeners.length !== 1 || !listeners[0][1].endsWith(":1C3C")) process.exit(1);
    };
    request().catch(() => process.exit(1));
  ' >/dev/null 2>&1 || fail "target-origin-$arch"

  process_count="$(docker top "$container_name" -eo pid 2>/dev/null | sed '1d; /^[[:space:]]*$/d' | wc -l | tr -d ' ')" \
    || fail "target-process-inspection-$arch"
  [ "$process_count" = "1" ] || fail "target-process-count-$arch"
  docker kill --signal TERM "$container_name" >/dev/null 2>&1 || fail "target-termination-$arch"
  exit_status="$(docker wait "$container_name" 2>/dev/null)" || fail "target-termination-$arch"
  [ "$exit_status" = "0" ] || fail "target-termination-$arch"
}

scan_existing_tree() {
  local root="$1"
  node - "$root" "${VERIFY_IDENTITIES[@]}" <<'NODE' >/dev/null 2>&1 || fail "existing-output-invalid"
const fs = require("node:fs");
const path = require("node:path");

const [rootInput, ...identities] = process.argv.slice(2);
const root = fs.realpathSync(rootInput);
const forbiddenDirectories = new Set([".git", ".cache", "coverage", "reports", "backups", "logs", "data"]);
const forbiddenFiles = new Set([".npmrc", "credentials.json", "id_rsa", "id_ed25519"]);
const forbiddenExtensions = [".ts", ".tsx", ".d.ts", ".map", ".log", ".bak", ".tmp", ".pem", ".key"];
const decoder = new TextDecoder("utf-8", { fatal: true });
const normalizedIdentities = identities.filter(Boolean).map((value) => value.toLowerCase());

const invalid = () => process.exit(1);
const walk = (directory) => {
  for (const name of fs.readdirSync(directory).sort()) {
    const candidate = path.join(directory, name);
    const entry = fs.lstatSync(candidate);
    if (entry.isDirectory()) {
      if (forbiddenDirectories.has(name)) invalid();
      walk(candidate);
      continue;
    }
    if (!entry.isFile()) continue;
    if (
      name === ".env" || name.startsWith(".env.") || forbiddenFiles.has(name) ||
      forbiddenExtensions.some((extension) => name.endsWith(extension))
    ) invalid();
    const bytes = fs.readFileSync(candidate);
    if (bytes.includes(0)) continue;
    let text;
    try {
      text = decoder.decode(bytes);
    } catch {
      continue;
    }
    if (
      /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]{40,}?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(text) ||
      /(?:^|[^A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?:[^A-Z0-9]|$)/.test(text) ||
      /(?:^|[^A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,})(?:[^A-Za-z0-9]|$)/.test(text)
    ) invalid();
    if (/\/Users\/[^/\s]+\//.test(text) || /[A-Za-z]:\\Users\\[^\\\s]+\\/i.test(text)) invalid();
    const normalized = text.toLowerCase();
    if (normalizedIdentities.some((identity) => normalized.includes(identity))) invalid();
  }
};

walk(root);
NODE
}

verify_existing_output() {
  local supplied_root="$1" expected_platform="$2" result_fields artifact_name version platform archive archive_list extracted bundle native_module
  case "$expected_platform" in linux/amd64|linux/arm64) ;; *) fail "existing-output-invalid" ;; esac
  [ -n "$supplied_root" ] && [ -d "$supplied_root" ] && [ ! -L "$supplied_root" ] || fail "existing-output-invalid"
  supplied_root="$(CDPATH= cd -- "$supplied_root" 2>/dev/null && pwd -P)" || fail "existing-output-invalid"
  [ ! -L "$supplied_root/result.json" ] && [ -f "$supplied_root/result.json" ] || fail "existing-output-invalid"
  result_fields="$({ node - "$supplied_root/result.json" "$expected_platform" <<'NODE'
const fs = require("node:fs");
const [file, expectedPlatform] = process.argv.slice(2);
let value;
try {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 4096) process.exit(1);
  value = JSON.parse(fs.readFileSync(file, "utf8"));
} catch { process.exit(1); }
if (Object.keys(value).sort().join(",") !== "artifactName,platform,version") process.exit(1);
if (value.platform !== expectedPlatform || typeof value.version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(value.version)) process.exit(1);
const arch = expectedPlatform.slice("linux/".length);
if (value.artifactName !== `meshrix-js-${value.version}-linux-${arch}.tar.gz`) process.exit(1);
process.stdout.write(`${value.artifactName}\n${value.version}\n${value.platform}\n`);
NODE
  } 2>/dev/null)" || fail "existing-output-invalid"
  artifact_name="$(printf '%s\n' "$result_fields" | sed -n '1p')"
  version="$(printf '%s\n' "$result_fields" | sed -n '2p')"
  platform="$(printf '%s\n' "$result_fields" | sed -n '3p')"
  archive="$supplied_root/$artifact_name"
  [ -s "$archive" ] && [ ! -L "$archive" ] || fail "existing-output-invalid"
  [ "$(CDPATH= cd -- "$(dirname -- "$archive")" && pwd -P)" = "$supplied_root" ] || fail "existing-output-invalid"
  archive_list="$(mktemp "$TEST_PRIVATE_ROOT/existing-archive-list.XXXXXX" 2>/dev/null)" || fail "existing-output-invalid"
  tar -tzf "$archive" >"$archive_list" 2>/dev/null || fail "existing-output-invalid"
  while IFS= read -r entry; do
    case "$entry" in /*|../*|*/../*|*/..|*//*) fail "existing-output-invalid" ;; esac
    case "$entry" in meshrix-js|meshrix-js/|meshrix-js/*) ;; *) fail "existing-output-invalid" ;; esac
  done <"$archive_list"
  extracted="$(mktemp -d "$TEST_PRIVATE_ROOT/existing-extracted.XXXXXX" 2>/dev/null)" || fail "existing-output-invalid"
  tar -xzf "$archive" -C "$extracted" >/dev/null 2>&1 || fail "existing-output-invalid"
  bundle="$extracted/meshrix-js"
  [ -d "$bundle" ] && [ ! -L "$bundle" ] || fail "existing-output-invalid"
  node "$SKILL_DIR/validate-runtime-tree.mjs" validate "$bundle" "$bundle" >/dev/null 2>&1 || fail "existing-output-invalid"
  [ -x "$bundle/start" ] && [ -x "$bundle/bin/node" ] && [ -f "$bundle/bundle.json" ] || fail "existing-output-invalid"
  node - "$bundle/bundle.json" "$version" "$platform" <<'NODE' >/dev/null 2>&1 || fail "existing-output-invalid"
const fs = require("node:fs");
const [file, version, platform] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(file, "utf8"));
const keys = ["product","version","platform","target","defaultPort","surfaces","startEntrypoint"];
if (Object.keys(value).join(",") !== keys.join(",")) process.exit(1);
if (value.product !== "Meshrix.js" || value.version !== version || value.platform !== platform || value.target !== "runtime-ui" || value.defaultPort !== 7228 || value.startEntrypoint !== "./start") process.exit(1);
if (JSON.stringify(value.surfaces) !== JSON.stringify({console:"/",api:"/api/",health:"/api/healthz"})) process.exit(1);
NODE
  scan_existing_tree "$bundle"
  assert_architecture "$bundle/bin/node" "$platform"
  native_module="$(find "$bundle/app/node_modules/better-sqlite3" -type f -name 'better_sqlite3.node' -print -quit 2>/dev/null || true)"
  [ -n "$native_module" ] || fail "existing-output-invalid"
  assert_architecture "$native_module" "$platform"
  prove_start "$bundle" "$platform"
  printf 'offline-pack-test: existing-output: passed\n'
}

run_existing_output() {
  shift
  [ "$#" -eq 3 ] && [ "$1" = "--platform" ] || fail "existing-output-invalid"
  command -v docker >/dev/null 2>&1 || fail "docker-unavailable"
  command -v file >/dev/null 2>&1 || fail "file-unavailable"
  local root supplied_root="$3" platform="$2"
  root="$(mktemp -d "${TMPDIR:-/tmp}/meshrix-offline-existing.XXXXXX" 2>/dev/null)" || fail "existing-output-invalid"
  TEST_PRIVATE_ROOT="$root"
  trap cleanup_test_root EXIT
  trap interrupt_test INT TERM
  verify_existing_output "$supplied_root" "$platform"
}

run_real() {
  shift
  [ "$#" -gt 0 ] || fail "missing-real-platform"
  command -v docker >/dev/null 2>&1 || fail "docker-unavailable"
  command -v file >/dev/null 2>&1 || fail "file-unavailable"
  local root platform arch out artifact extracted bundle native_module version pack_log pack_status
  root="$(mktemp -d "${TMPDIR:-/tmp}/meshrix-offline-real.XXXXXX" 2>/dev/null)" || fail "private-root"
  TEST_PRIVATE_ROOT="$root"
  trap cleanup_test_root EXIT
  trap interrupt_test INT TERM
  version="$(node -p 'require(process.argv[1]).release.version' "$SKILL_DIR/../../tools/registry/release-definition.registry.json" 2>/dev/null)" || fail "release-definition"

  for platform in "$@"; do
    case "$platform" in linux/amd64|linux/arm64) ;; *) fail "unsupported-real-platform" ;; esac
    arch="${platform#linux/}"
    out="$root/$arch/out"
    pack_log="$root/$arch/pack.log"
    mkdir -p "$out" 2>/dev/null || fail "real-output-$arch"
    set +e
    "$PACK_SCRIPT" --platform "$platform" --out "$out" >/dev/null 2>"$pack_log"
    pack_status=$?
    set -e
    if [ "$pack_status" = "75" ]; then
      printf 'offline-pack-test: real: %s: blocked_by_environment\n' "$platform" >&2
      exit 75
    fi
    [ "$pack_status" = "0" ] || fail "real-build-$arch"
    artifact="$out/meshrix-js-$version-linux-$arch.tar.gz"
    [ -f "$artifact" ] || fail "real-artifact-$arch"
    extracted="$root/$arch/extracted"
    mkdir -p "$extracted" 2>/dev/null || fail "real-extract-$arch"
    tar -xzf "$artifact" -C "$extracted" >/dev/null 2>&1 || fail "real-extract-$arch"
    bundle="$extracted/meshrix-js"
    assert_architecture "$bundle/bin/node" "$platform"
    native_module="$(find "$bundle/app/node_modules/better-sqlite3" -type f -name 'better_sqlite3.node' -print -quit 2>/dev/null || true)"
    [ -n "$native_module" ] || fail "native-module-missing-$arch"
    assert_architecture "$native_module" "$platform"
    prove_start "$bundle" "$platform"
    printf 'offline-pack-test: real: %s: passed\n' "$platform"
  done
}

if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  return 0
fi

case "$MODE" in
  --contract) run_contract ;;
  --real) run_real "$@" ;;
  --existing-output) run_existing_output "$@" ;;
  *) printf 'Usage: test-offline-pack.sh --contract | --real linux/amd64 [linux/arm64] | --existing-output --platform linux/amd64|linux/arm64 ROOT\n' >&2; exit 2 ;;
esac
