import { validateBuildManifest } from "../../apps/entry-native/tools/package-linux.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildNativeHost, nativeHostTarget, publicDependencyEvidence, builderCommand, fetchCommand, validatePublicBuildProvenance, validateToolchainMount, requireLocalDockerContext } from "../../apps/entry-native/tools/build-linux.mjs";
import { loadNativeReleaseConfig, nativeTargets } from "../../apps/entry-native/tools/native-release-config.mjs";

const packages = ["a4aa", "a4aa-dialects", "agents-with-profiles"].map(name => ({ name, version: "0.1.0", source: "registry+https://github.com/rust-lang/crates.io-index" }));
const rustc = "rustc test\nhost: x86_64-unknown-linux-gnu\n";

test("host targets are native GNU only, with no cross-architecture claim", () => {
  assert.equal(nativeHostTarget(rustc, "linux", "x64"), "x86_64-unknown-linux-gnu");
  assert.equal(nativeHostTarget("host: aarch64-unknown-linux-gnu", "linux", "arm64"), "aarch64-unknown-linux-gnu");
  assert.throws(() => nativeHostTarget(rustc, "darwin", "x64"), /native Linux/);
  assert.throws(() => nativeHostTarget(rustc, "linux", "arm64"), /observed/);
  assert.throws(() => nativeHostTarget("host: x86_64-unknown-linux-musl", "linux", "x64"), /native GNU/);
});

test("host evidence refuses missing, duplicate and privately patched dependencies", () => {
  assert.equal(publicDependencyEvidence({ packages }).length, 3);
  assert.throws(() => publicDependencyEvidence({ packages: [] }), /public registry/);
  assert.throws(() => publicDependencyEvidence({ packages: [...packages, packages[0]] }), /public registry/);
  assert.throws(() => publicDependencyEvidence({ packages: packages.map(p => ({ ...p, source: null })) }), /development-source/);
  assert.throws(() => publicDependencyEvidence({ packages: packages.map(p => ({ ...p, source: "registry+https://private.example/index" })) }), /public registry/);
});

async function fixture(callback) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-host-build-"));
  try {
    await fs.writeFile(path.join(workspace, "Cargo.lock"), "locked test inputs\n");
    await callback(workspace);
  } finally { await fs.rm(workspace, { recursive: true, force: true }); }
}

function inspector(calls) {
  return async (command, args) => {
    calls.push([command, ...args]);
    if (command === "rustc") return rustc;
    if (command === "which") return `/usr/bin/${args[0]}`;
    if (command === "readlink") return args[1];
    if (args[0] === "metadata") return JSON.stringify({ packages });
    return `${command} test`;
  };
}

test("host build uses locked public inputs, builds both binaries and separates host outputs", async () => fixture(async workspace => {
  const calls = [];
  const executed = [];
  const result = await buildNativeHost({ workspace, platform: "linux", arch: "x64", environment: { PROTOC: "test-protoc", CARGO_BUILD_JOBS: "2" }, inspect: inspector(calls), execute: async (command, args, options) => {
    executed.push([command, ...args]);
    if (command === "cargo") {
      assert.deepEqual(args, ["fetch", "--locked"]);
      return;
    }
    assert.equal(command, "bwrap");
    const buildArgs = args.slice(args.indexOf("--") + 1);
    assert.deepEqual(buildArgs, ["cargo", "build", "--release", "--locked", "--offline", "--bins", "--target", "x86_64-unknown-linux-gnu"]);
    assert.ok(args.includes("--unshare-all") && args.includes("--ro-bind"));
    const stateDir = path.dirname(options.env.CARGO_HOME);
    const target = path.join(stateDir, "cargo-target", "x86_64-unknown-linux-gnu", "release");
    await fs.mkdir(target, { recursive: true });
    for (const name of ["meshrix-entry", "meshrix-entry-gui"]) await fs.writeFile(path.join(target, name), name);
  }});
  assert.deepEqual(executed[0], ["cargo", "fetch", "--locked"]);
  assert.ok(calls.some(c => c[0] === "bwrap" && c.includes("--version")));
  assert.ok(calls.some(c => c[0] === "test-protoc"));
  assert.ok(calls.some(c => c.includes("metadata") && c.includes("--locked")));
  assert.equal(result.manifest.qualification, "native-host-only");
  assert.equal(result.manifest.portableArchiveQualified, false);
  assert.match(result.manifest.lockSha256, /^[a-f0-9]{64}$/);
  assert.equal(await fs.readFile(path.join(result.destination, "meshrix-entry-gui"), "utf8"), "meshrix-entry-gui");
  assert.equal(JSON.parse(await fs.readFile(path.join(result.destination, "host-build-manifest.json"))).schemaVersion, "meshrix-native-host-build-1");
  await assert.rejects(fs.access(path.join(workspace, "dist", "linux")));
}));

test("host build strips ambient secrets from the Cargo executor environment", async () => fixture(async workspace => {
  const calls = [];
  let built;
  let sandboxArgs;
  await buildNativeHost({
    workspace,
    platform: "linux",
    arch: "x64",
    environment: {
      PROTOC: "test-protoc",
      CARGO_BUILD_JOBS: "2",
      NPM_TOKEN: "sentinel-secret",
      AWS_SECRET_ACCESS_KEY: "sentinel-secret",
      GITHUB_TOKEN: "sentinel-secret",
      SSH_AUTH_SOCK: "sentinel-secret",
    },
    inspect: inspector(calls),
    execute: async (command, args, options) => {
      built = options.env;
      if (command !== "bwrap") return;
      sandboxArgs = args;
      const stateDir = path.dirname(options.env.CARGO_HOME);
      const target = path.join(stateDir, "cargo-target", "x86_64-unknown-linux-gnu", "release");
      await fs.mkdir(target, { recursive: true });
      for (const name of ["meshrix-entry", "meshrix-entry-gui"]) await fs.writeFile(path.join(target, name), name);
    },
  });
  for (const secret of ["NPM_TOKEN", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "SSH_AUTH_SOCK"]) {
    assert.equal(built[secret], undefined, `${secret} must not reach dependency build code`);
  }
  assert.equal(Object.values(built).includes("sentinel-secret"), false);
  assert.equal(built.CARGO_BUILD_JOBS, "2");
  assert.equal(built.PROTOC, "test-protoc");
  assert.match(built.CARGO_HOME, /linux-host-sandbox[/\\]build[/\\]cargo-home$/);
  assert.match(built.HOME, /linux-host-sandbox[/\\]build[/\\]home$/);
  const targetSetenv = sandboxArgs.indexOf("CARGO_TARGET_DIR");
  assert.ok(targetSetenv > 0 && sandboxArgs[targetSetenv - 1] === "--setenv");
  assert.equal(sandboxArgs[targetSetenv + 1], "/build/cargo-target");
}));

test("host build executes dependency code inside a sealed bubblewrap sandbox", async () => fixture(async workspace => {
  const executed = [];
  await buildNativeHost({ workspace, platform: "linux", arch: "x64", environment: { PROTOC: "test-protoc" }, inspect: inspector([]), execute: async (command, args, options) => {
    executed.push([command, ...args]);
    if (command !== "bwrap") return;
    const stateDir = path.dirname(options.env.CARGO_HOME);
    const target = path.join(stateDir, "cargo-target", "x86_64-unknown-linux-gnu", "release");
    await fs.mkdir(target, { recursive: true });
    for (const name of ["meshrix-entry", "meshrix-entry-gui"]) await fs.writeFile(path.join(target, name), name);
  }});
  assert.deepEqual(executed[0], ["cargo", "fetch", "--locked"]);
  const bwrap = executed[1];
  assert.equal(bwrap[0], "bwrap");
  assert.ok(bwrap.includes("--unshare-all"), "sandbox must isolate mount/network namespaces");
  const stagedBind = bwrap.indexOf("/workspace");
  assert.ok(stagedBind > 0 && bwrap[stagedBind - 2] === "--ro-bind", "staged workspace must be read-only");
  const inner = bwrap.slice(bwrap.indexOf("--") + 1);
  assert.deepEqual(inner, ["cargo", "build", "--release", "--locked", "--offline", "--bins", "--target", "x86_64-unknown-linux-gnu"]);
}));

test("host build fails closed when no filesystem and network sandbox exists", async () => fixture(async workspace => {
  const calls = [];
  const inspect = async (command, args) => {
    calls.push(command);
    if (command === "bwrap") throw new Error("bwrap unavailable");
    if (command === "rustc") return rustc;
    if (args[0] === "metadata") return JSON.stringify({ packages });
    return `${command} test`;
  };
  const executed = [];
  await assert.rejects(buildNativeHost({ workspace, platform: "linux", arch: "x64", environment: { PROTOC: "test-protoc" }, inspect, execute: async (command, args) => { executed.push([command, ...args]); } }), /bubblewrap/);
  assert.ok(calls.includes("bwrap"));
  assert.equal(executed.length, 0, "no fetch or build may run without the sandbox");
}));

test("build failure preserves last good host outputs and does not stage partial binaries", async () => fixture(async workspace => {
  const destination = path.join(workspace, "dist", "linux-host");
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, "meshrix-entry"), "previous");
  await assert.rejects(buildNativeHost({ workspace, platform: "linux", arch: "x64", inspect: inspector([]), execute: async (_command, args) => { if (args.includes("build")) throw new Error("compiler failed"); } }), /compiler failed/);
  assert.equal(await fs.readFile(path.join(destination, "meshrix-entry"), "utf8"), "previous");
}));

test("missing GUI output cannot replace an earlier complete host installation", async () => fixture(async workspace => {
  const destination = path.join(workspace, "dist", "linux-host");
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, "meshrix-entry"), "previous");
  await assert.rejects(buildNativeHost({ workspace, platform: "linux", arch: "x64", inspect: inspector([]), execute: async (command, _args, options) => {
    if (command !== "bwrap") return;
    const stateDir = path.dirname(options.env.CARGO_HOME);
    const target = path.join(stateDir, "cargo-target", "x86_64-unknown-linux-gnu", "release");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "meshrix-entry"), "new");
  }}), /ENOENT/);
  assert.equal(await fs.readFile(path.join(destination, "meshrix-entry"), "utf8"), "previous");
  const leftovers = await fs.readdir(path.join(workspace, "target", "linux-host-sandbox", "build", "cargo-target"));
  assert.equal(leftovers.some(name => name.startsWith("stage-")), false);
}));

test("missing compiler prerequisite fails before Cargo build or output replacement", async () => fixture(async workspace => {
  let executed = false;
  const inspect = inspector([]);
  await assert.rejects(buildNativeHost({ workspace, platform: "linux", arch: "x64", environment: {}, inspect: async (command, args) => {
    if (command === "protoc") throw new Error("protoc unavailable");
    return inspect(command, args);
  }, execute: async () => { executed = true; } }), /protoc unavailable/);
  assert.equal(executed, false);
  await assert.rejects(fs.access(path.join(workspace, "dist", "linux-host")));
}));


test("portable builder keeps all four locked targets offline after a separate fetch phase", () => {
  const fetch = fetchCommand(2);
  assert.match(fetch, /cargo fetch .*--locked/);
  const command = builderCommand(2, "x86_64");
  assert.match(command, /cargo metadata .*--locked --offline --format-version 1/);
  assert.match(command, /public-cargo-home/);
  // Writable build state mounts at /build-state, outside the read-only
  // /workspace source mount — nothing writes into the staged tree.
  assert.match(command, /CARGO_HOME=\/build-state\//);
  assert.match(command, /CARGO_TARGET_DIR=\/build-state\//);
  assert.match(command, /> \/build-state\/public-dependencies\.json/);
  assert.doesNotMatch(command, /\/workspace\/apps\/entry-native\/target/);
  assert.doesNotMatch(command, /cargo fetch|dependency-snapshot|patch.crates-io|MESHRIX_A4AA_SOURCE/);
  for (const target of nativeTargets("linux")) {
    assert.ok(command.includes(`--release --locked --offline --target ${target.buildTarget}`));
  }
});

// The Dockerfile keeps a literal pinned FROM default for bare `docker build`
// (the parameterised build-arg covers the other architecture); the shared
// registry remains the authority, so the fallback must stay identical.
test("Dockerfile fallback pins match the shared native release configuration", async () => {
  const dockerfile = await fs.readFile(new URL("../../apps/entry-native/tools/linux-builder/Dockerfile", import.meta.url), "utf8");
  const profile = loadNativeReleaseConfig().linuxBuilders.aarch64;
  assert.ok(dockerfile.includes(profile.base), "FROM default must be the configured aarch64 base image pin");
  assert.ok(dockerfile.includes(`PROTOC_PACKAGE=${profile.protocPackage}`));
  assert.ok(dockerfile.includes(`PROTOC_SHA256=${profile.protocSha256}`));
});

test("toolchain mounts refuse the invoking home and arbitrary inside-home paths", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-fake-home-"));
  try {
    const rustup = path.join(home, ".rustup", "toolchains", "stable");
    const cargoBin = path.join(home, ".cargo", "bin");
    await fs.mkdir(rustup, { recursive: true });
    await fs.mkdir(cargoBin, { recursive: true });
    await fs.mkdir(path.join(home, "tools"), { recursive: true });
    assert.equal(validateToolchainMount("/usr/bin", "toolchain", home), "/usr/bin");
    assert.equal(validateToolchainMount(rustup, "toolchain", home), await fs.realpath(rustup));
    assert.equal(validateToolchainMount(cargoBin, "toolchain", home), await fs.realpath(cargoBin));
    for (const dir of [home, "/", path.join(home, "tools")]) {
      assert.throws(() => validateToolchainMount(dir, "RUSTUP_HOME", home), /refusing/);
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("portable provenance requires a lock hash and public metadata, not a label alone", () => {
  const manifest = { lockSha256: "a".repeat(64), dependencies: packages };
  assert.equal(validatePublicBuildProvenance(manifest).length, 3);
  assert.throws(() => validatePublicBuildProvenance({ ...manifest, lockSha256: "" }), /lock_hash/);
  assert.throws(() => validatePublicBuildProvenance({ ...manifest, dependencies: [] }), /public registry/);
  assert.throws(() => validatePublicBuildProvenance({ ...manifest, dependencies: packages.map(p => ({ ...p, source: null })) }), /development-source/);
});


test("Docker endpoint validation follows CLI precedence: DOCKER_CONTEXT overrides DOCKER_HOST", async () => {
  // A remote DOCKER_CONTEXT must reject even when DOCKER_HOST is local:
  // the docker CLI ignores DOCKER_HOST whenever a context is selected.
  await assert.rejects(requireLocalDockerContext({
    environment: { DOCKER_HOST: "unix:///var/run/docker.sock", DOCKER_CONTEXT: "remote" },
    inspect: async () => '"tcp://builder.example:2375"',
  }), /DOCKER_CONTEXT selects a remote endpoint/);
  await requireLocalDockerContext({
    environment: { DOCKER_HOST: "tcp://builder.example:2375", DOCKER_CONTEXT: "local" },
    inspect: async () => '"unix:///var/run/docker.sock"',
  });
  await assert.rejects(requireLocalDockerContext({
    environment: { DOCKER_HOST: "tcp://builder.example:2375" },
    inspect: async () => '"unix:///var/run/docker.sock"',
  }), /DOCKER_HOST/);
});

test("Docker endpoint validation inspects the current context only when no variables override it", async () => {
  const calls = [];
  const inspect = async (command, args) => {
    calls.push(args.join(" "));
    if (args[1] === "show") return "default\n";
    return '"unix:///var/run/docker.sock"';
  };
  await requireLocalDockerContext({ environment: {}, inspect });
  assert.ok(calls.some(args => args === "context show"));
  await assert.rejects(requireLocalDockerContext({
    environment: {},
    inspect: async (_command, args) => (args[1] === "show" ? "remote\n" : '"tcp://builder.example:2375"'),
  }), /selected context is remote/);
});

test("portable packager accepts public provenance without relaxing the four-target contract", () => {
  const manifest = {
    schemaVersion: 1, lockSha256: "a".repeat(64), dependencies: packages,
    builder: { image: "meshrix-test:arm64", platform: "linux/arm64", readelf: "/usr/bin/readelf", patchelf: "/usr/bin/patchelf", sysroots: { x86_64: "/sysroot", aarch64: "/" } },
    artifacts: ["cli-tui", "gui"].flatMap(component => ["x86_64", "aarch64"].map(arch => ({
      component, arch, libc: component === "gui" ? "gnu" : "musl",
      rustTarget: `${arch}-unknown-linux-${component === "gui" ? "gnu" : "musl"}`,
      binary: `bin/${arch}/meshrix-entry${component === "gui" ? "-gui" : ""}`,
      buildSource: "public-registry-locked",
    }))),
  };
  assert.equal(validateBuildManifest(manifest).artifacts.length, 4);
  assert.throws(() => validateBuildManifest({ ...manifest, artifacts: manifest.artifacts.slice(1) }), /four_targets/);
  assert.throws(() => validateBuildManifest({ ...manifest, artifacts: manifest.artifacts.map(a => ({ ...a, buildSource: "current-local-development-sources" })) }), /source_qualification/);
  assert.throws(() => validateBuildManifest({ ...manifest, dependencies: [] }), /public registry/);
});

test("staging refuses a tracked path beneath a symlinked parent directory", async () => {
  const { stageWorkspace } = await import("../../apps/entry-native/tools/build-linux.mjs");
  const { execFileSync } = await import("node:child_process");
  const fsSync = await import("node:fs");
  await fixture(async (workspace) => {
    // A miniature git fixture: sub/file.txt is tracked, then sub/ is swapped
    // for a symlink to a directory outside the repository.
    const rootDir = path.join(workspace, "repo");
    const external = path.join(workspace, "external");
    fsSync.mkdirSync(path.join(rootDir, "sub"), { recursive: true });
    fsSync.mkdirSync(external, { recursive: true });
    fsSync.writeFileSync(path.join(rootDir, "sub", "file.txt"), "tracked");
    fsSync.writeFileSync(path.join(external, "secret.txt"), "secret");
    execFileSync("git", ["init", "-q", rootDir]);
    execFileSync("git", ["-C", rootDir, "add", "sub/file.txt"]);
    fsSync.rmSync(path.join(rootDir, "sub"), { recursive: true });
    fsSync.symlinkSync(external, path.join(rootDir, "sub"));
    const stageDir = path.join(workspace, "stage");
    await assert.rejects(
      stageWorkspace(stageDir, ["sub"], rootDir),
      /staged_source_symlink/
    );
    assert.ok(!fsSync.existsSync(path.join(stageDir, "sub", "secret.txt")));
  });
});
