#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  MCP_CONNECTOR_PACKAGE_NAME,
  MCP_CONNECTOR_VERSION
} from "../../packages/protocols/mcp/adapter/http-mcp-adapter.mjs";
import {
  MCP_STABLE_TOOL_NAME
} from "../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/constants.mjs";
import {
  MCP_SUPPORTED_TARGETS
} from "../../packages/protocols/mcp/adapter/mcp-release-targets.mjs";
import {
  connectorRoot,
  projectRoot,
  readJson,
  sha256,
  writeReleaseChecksumIndex
} from "./lib/mcp-release-common.mjs";
import {
  createPortableBundle,
  loadNodeRuntimeLock,
  verifyNodeRuntimeSignedChecksums,
  resolveBundledNodeVersion
} from "./lib/mcp-release-portable.mjs";
import { scanPublicArtifact } from "./lib/public-artifact-boundary.mjs";

const execFileAsync = promisify(execFile);

const REPORT_PATH = "build/reports/mcp-release-portable-assembly.json";
const PLATFORM_REPORT_PATH = `build/reports/mcp-release-portable-assembly-${currentPortableTarget()}.json`;
const VERIFIER = "tools/server-scripts/verify-mcp-release-portable-assembly.mjs";
const SCHEMA_VERSION = "v0.0.1:mcp:release-portable-assembly-report-1";
const RELEASE_SCRIPT = "tools/server-scripts/mcp-release.mjs";

function currentPortableTarget() {
  const platformMap = {
    darwin: "macos",
    linux: "linux",
    win32: "windows"
  };
  const archMap = {
    x64: "x64",
    arm64: "arm64"
  };
  return `${platformMap[process.platform] || process.platform}-${archMap[process.arch] || process.arch}`;
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lico-mcp-release-portable-assembly-"));
const report = {
  schemaVersion: SCHEMA_VERSION,
  verifier: VERIFIER,
  platformTarget: currentPortableTarget(),
  startedAt: new Date().toISOString(),
  sourceOfTruth: {
    releaseTargets: "packages/protocols/mcp/adapter/mcp-release-targets.mjs",
    portableBuilder: "tools/server-scripts/lib/mcp-release-portable.mjs",
    connectorPackage: "packages/protocols/mcp/adapter/gateway-installer/package.json"
  },
  tests: [],
  summary: {}
};

const pathNeedles = [...new Set([
  tempRoot,
  await fs.realpath(tempRoot),
  os.homedir(),
  await fs.realpath(os.homedir()),
  projectRoot,
  await fs.realpath(projectRoot)
].filter(Boolean))].sort((left, right) => right.length - left.length);

function safeEvidence(value = {}) {
  return JSON.parse(JSON.stringify(value, (_, child) => {
    if (typeof child !== "string") return child;
    let redacted = child;
    for (const needle of pathNeedles) {
      if (needle) redacted = redacted.split(needle).join("[redacted-local-path]");
    }
    if (/Bearer\s+\S+/i.test(redacted) || /lico_[A-Za-z0-9_-]{12,}=/.test(redacted)) return "[redacted-secret]";
    return redacted;
  }));
}

function assertNoLeakText(text = "", label = "text") {
  const value = String(text);
  for (const needle of pathNeedles) {
    assert.equal(needle ? value.includes(needle) : false, false, `${label} leaked local path`);
  }
  assert.equal(/Bearer\s+\S+/i.test(value), false, `${label} leaked bearer token`);
  assert.equal(/lico_[A-Za-z0-9_-]{12,}=/.test(value), false, `${label} leaked local grant token`);
}

function assertNoLeak(value, label = "payload") {
  assertNoLeakText(JSON.stringify(value), label);
}

function record(name, status, evidence = {}) {
  report.tests.push({ name, status, evidence: safeEvidence(evidence) });
}

function failureEvidence(error) {
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    code: String(error?.code || ""),
    message: String(error?.message || "")
  };
}

async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    const evidence = await fn();
    record(name, "passed", evidence);
    console.log("ok");
  } catch (error) {
    record(name, "failed", failureEvidence(error));
    console.log("FAIL");
    throw error;
  }
}

async function runPortable(executable, args = []) {
  const isolatedHome = path.join(tempRoot, "isolated-home");
  const powershellScript = process.platform === "win32" && executable.toLowerCase().endsWith(".ps1");
  const command = powershellScript ? "powershell.exe" : executable;
  const commandArgs = powershellScript
    ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", executable, ...args]
    : args;
  const result = await execFileAsync(command, commandArgs, {
    cwd: path.dirname(executable),
    env: {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
      APPDATA: path.join(isolatedHome, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(isolatedHome, "AppData", "Local"),
      ANTIGRAVITY_MCP_CONFIG_ROOT: path.join(isolatedHome, "antigravity"),
      LICO_MCP_DISCOVERY_FILE: path.join(tempRoot, "isolated", "servers.json"),
      LICO_MCP_TOKEN: "",
      LICO_TOOL_TOKEN: ""
    },
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}

async function extractTarball(archivePath, extractDir) {
  await fs.mkdir(extractDir, { recursive: true });
  await execFileAsync("tar", ["-xzf", archivePath, "-C", extractDir], {
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024
  });
}

async function listFiles(root) {
  const files = [];
  async function visit(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(child);
        continue;
      }
      files.push(path.relative(root, child).split(path.sep).join("/"));
    }
  }
  await visit(root);
  return files.sort();
}

async function createNodeRuntimeFixture() {
  const distributionRoot = path.join(tempRoot, "node-runtime-fixture");
  const executablePath = path.join(distributionRoot, "bin", "node");
  await fs.mkdir(path.dirname(executablePath), { recursive: true });
  await fs.copyFile(process.execPath, executablePath);
  await fs.writeFile(
    path.join(distributionRoot, "LICENSE"),
    "Node.js distribution license fixture for portable assembly verification.\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(distributionRoot, "NOTICE"),
    "Node.js distribution notice fixture for portable assembly verification.\n",
    "utf8"
  );
  return {
    distributionRoot,
    executablePath
  };
}

async function writeReport() {
  report.finishedAt = new Date().toISOString();
  report.summary.testCount = report.tests.length;
  report.summary.failedCount = report.tests.filter((item) => item.status !== "passed").length;
  report.summary.releaseReady = report.summary.failedCount === 0;
  report.summary.reportLeakScan = true;
  assertNoLeak(report, "mcp release portable assembly report");
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  await Promise.all([
    fs.writeFile(REPORT_PATH, reportText, "utf8"),
    fs.writeFile(PLATFORM_REPORT_PATH, reportText, "utf8")
  ]);
}

try {
  const outputDir = path.join(tempRoot, "out");
  const extractDir = path.join(tempRoot, "extract");
  const packageJson = await readJson(path.join(connectorRoot, "package.json"));
  const target = currentPortableTarget();
  const bundledVersion = await resolveBundledNodeVersion();
  let bundle = null;
  let extractedRoot = "";
  let executable = "";
  let nodeRuntimeFixture = null;

  await test("connector package metadata matches runtime constants", async () => {
    assert.equal(packageJson.name, MCP_CONNECTOR_PACKAGE_NAME);
    assert.equal(packageJson.version, MCP_CONNECTOR_VERSION);
    for (const keyword of ["claude-code", "antigravity", "codex", "openclaw", "opencode", "pi"]) {
      assert.equal(packageJson.keywords?.includes(keyword), true, `missing package keyword: ${keyword}`);
    }
    return {
      packageName: packageJson.name,
      packageVersion: packageJson.version,
      releaseTargets: MCP_SUPPORTED_TARGETS
    };
  });

  await test("portable Node runtime lock rejects unpinned versions and unsigned targets", async () => {
    const lock = await loadNodeRuntimeLock();
    await assert.rejects(() => resolveBundledNodeVersion("v0.0.0"), /node_runtime_version_not_locked/u);
    assert.equal(Object.hasOwn(lock.targets, "linux-x64-musl"), false);
    assert.throws(
      () => verifyNodeRuntimeSignedChecksums({ lock, checksumsText: "tampered\n" }),
      /node_runtime_checksums_digest_mismatch/u
    );
    const nodeRuntime = await createNodeRuntimeFixture();
    await assert.rejects(
      () => createPortableBundle({
        outputDir,
        packageJson,
        target: "linux-x64-musl",
        bundledVersion,
        nodeRuntime
      }),
      /node_runtime_target_not_locked/u
    );
    await assert.rejects(
      () => execFileAsync(process.execPath, [RELEASE_SCRIPT, "--node-version=v0.0.0", "--json"], {
        cwd: projectRoot,
        timeout: 10000,
        maxBuffer: 1024 * 1024
      }),
      (error) => String(error?.stderr || "").includes("node_runtime_version_override_not_supported")
    );
    return {
      lockedVersion: lock.version,
      lockedTargetCount: Object.keys(lock.targets).length,
      unsignedMuslTargetRejected: true,
      releaseCliVersionOverrideRejected: true,
      tamperedChecksumsRejected: true
    };
  });

  await test("portable bundle builds for current platform without client config writes", async () => {
    await fs.mkdir(outputDir, { recursive: true });
    nodeRuntimeFixture = await createNodeRuntimeFixture();
    bundle = await createPortableBundle({
      outputDir,
      packageJson,
      target,
      bundledVersion,
      nodeRuntime: nodeRuntimeFixture
    });
    assert.equal(bundle.includesNodeRuntime, true);
    assert.equal(bundle.bundledNodeVersion, bundledVersion);
    assert.ok(bundle.archiveName.endsWith(".tar.gz"));
    assert.equal(await sha256(bundle.archivePath), bundle.sha256);
    assert.deepEqual(bundle.nodeLegalFiles, [
      "licenses/node/LICENSE",
      "licenses/node/NOTICE"
    ]);
    await assert.rejects(
      () => fs.access(path.join(outputDir, bundle.rootName)),
      { code: "ENOENT" },
      "portable assembly must not leave an unpacked staging directory in release output"
    );
    return {
      platform: bundle.platform,
      archiveName: bundle.archiveName,
      archiveSha256: bundle.sha256.slice(0, 12),
      sizeBytes: bundle.sizeBytes,
      bundledNodeVersion: bundle.bundledNodeVersion,
      stagingDirectoryRemoved: true
    };
  });

  await test("portable tar and zip archives are reproducible", async () => {
    const secondOutputDir = path.join(tempRoot, "out-reproducible");
    await fs.mkdir(secondOutputDir, { recursive: true });
    const repeatedBundle = await createPortableBundle({
      outputDir: secondOutputDir,
      packageJson,
      target,
      bundledVersion,
      nodeRuntime: nodeRuntimeFixture
    });
    assert.equal(repeatedBundle.sha256, bundle.sha256);
    assert.equal(repeatedBundle.sizeBytes, bundle.sizeBytes);
    assert.equal(repeatedBundle.zipSha256, bundle.zipSha256);
    assert.equal(repeatedBundle.zipSizeBytes, bundle.zipSizeBytes);
    return {
      tarDigestStable: true,
      zipDigestStable: bundle.zipArchiveName ? true : "not-applicable",
      archiveEntryOrder: "lexical",
      normalizedOwnerGroup: true,
      normalizedMtime: true
    };
  });

  await test("portable archive extracts with executable and runtime files", async () => {
    await extractTarball(bundle.archivePath, extractDir);
    extractedRoot = path.join(extractDir, bundle.rootName);
    executable = path.join(extractedRoot, bundle.executable);
    const stat = await fs.stat(executable);
    assert.equal(stat.isFile(), true);
    if (process.platform !== "win32") {
      assert.notEqual(stat.mode & 0o111, 0, "portable executable bit missing");
    }
    const files = await listFiles(extractedRoot);
    const platformEntrypoints = target.startsWith("windows-")
      ? ["lico-mcp.ps1", "lico-mcp-install.ps1", "lico-mcp-uninstall.ps1"]
      : ["lico-mcp", "lico-mcp-install.sh", "lico-mcp-uninstall.sh"];
    if (target.startsWith("macos-")) {
      platformEntrypoints.push("install.command", "uninstall.command", "doctor.command");
    }
    for (const required of [
      bundle.executable,
      "mcp-identity.mjs",
      "package.json",
      "app/bin/lico-mcp.mjs",
      "app/mcp-release-targets.mjs",
      "app/package.json",
      "app/vendor/contracts/mcp-catalog-delivery.mjs",
      "app/vendor/contracts/serialization/canonical-json.mjs",
      "app/README.md",
      "app/LICENSE",
      "LICENSE",
      "THIRD_PARTY_NOTICES.txt",
      "licenses/node/NODE_RUNTIME.lock.json",
      "licenses/node/LICENSE",
      "licenses/node/NOTICE",
      ...platformEntrypoints,
      "README.txt"
    ]) {
      assert.equal(files.includes(required), true, `missing portable file: ${required}`);
    }
    assert.equal(files.some((file) => file.startsWith("runtime/")), true);
    const portablePackageJson = await readJson(path.join(extractedRoot, "app", "package.json"));
    assert.equal(portablePackageJson.dependencies?.["@lico/contracts"], "0.0.1");
    assert.equal(
      portablePackageJson.imports?.["#lico/contracts/*"],
      "./vendor/contracts/*.mjs"
    );
    const portableRootPackageJson = await readJson(path.join(extractedRoot, "package.json"));
    assert.equal(portableRootPackageJson.private, true);
    assert.equal(
      portableRootPackageJson.imports?.["#lico/contracts/*"],
      "./app/vendor/contracts/*.mjs"
    );
    const [canonicalSource, bundledCanonicalSource] = await Promise.all([
      fs.readFile(path.join(projectRoot, "packages", "contracts", "src", "serialization", "canonical-json.mjs")),
      fs.readFile(path.join(
        extractedRoot,
        "app",
        "vendor",
        "contracts",
        "serialization",
        "canonical-json.mjs"
      ))
    ]);
    assert.equal(
      Buffer.compare(canonicalSource, bundledCanonicalSource),
      0,
      "portable canonical JSON dependency must be copied from the contracts authority"
    );
    return {
      rootName: bundle.rootName,
      fileCount: files.length,
      executable: bundle.executable,
      contractsDependencyReady: true
    };
  });

  await test("portable native entrypoints delegate to the bundled verified connector", async () => {
    const windowsTarget = target.startsWith("windows-");
    const installer = path.join(
      extractedRoot,
      windowsTarget ? "lico-mcp-install.ps1" : "lico-mcp-install.sh"
    );
    const installSource = await fs.readFile(installer, "utf8");
    if (windowsTarget) {
      assert.match(installSource, /lico-mcp\.ps1/u);
      assert.equal(/Invoke-Expression|\biex\b/iu.test(installSource), false);
    } else {
      assert.match(installSource, /SCRIPT_DIR\/lico-mcp/u);
      assert.equal(installSource.includes("eval "), false);
      if (target.startsWith("macos-")) {
        const installCommand = await fs.readFile(path.join(extractedRoot, "install.command"), "utf8");
        assert.match(installCommand, /lico-mcp-install\.sh/u);
      }
    }
    const { stdout, stderr } = await runPortable(
      installer,
      windowsTarget ? ["-Command", "version", "-Json"] : ["version", "--json"]
    );
    assertNoLeakText(stdout, "portable native version stdout");
    assertNoLeakText(stderr, "portable native version stderr");
    const payload = JSON.parse(stdout);
    assert.equal(payload.packageName, MCP_CONNECTOR_PACKAGE_NAME);
    assert.equal(payload.packageVersion, MCP_CONNECTOR_VERSION);
    return {
      delegatedToBundledConnector: true,
      rawEvalAbsent: true
    };
  });

  await test("Windows portable archive exposes PowerShell-only native entrypoints", async () => {
    const windowsOutputDir = path.join(tempRoot, "out-windows-contract");
    const windowsExtractDir = path.join(tempRoot, "extract-windows-contract");
    await fs.mkdir(windowsOutputDir, { recursive: true });
    const windowsBundle = await createPortableBundle({
      outputDir: windowsOutputDir,
      packageJson,
      target: "windows-x64",
      bundledVersion,
      nodeRuntime: nodeRuntimeFixture
    });
    await extractTarball(windowsBundle.archivePath, windowsExtractDir);
    const windowsRoot = path.join(windowsExtractDir, windowsBundle.rootName);
    const files = await listFiles(windowsRoot);
    for (const required of ["lico-mcp.ps1", "lico-mcp-install.ps1", "lico-mcp-uninstall.ps1"]) {
      assert.equal(files.includes(required), true, `missing Windows PowerShell entrypoint: ${required}`);
    }
    for (const prohibited of [
      "lico-mcp",
      "lico-mcp-install.sh",
      "lico-mcp-uninstall.sh",
      "install.command",
      "uninstall.command",
      "doctor.command"
    ]) {
      assert.equal(files.includes(prohibited), false, `unexpected Windows entrypoint: ${prohibited}`);
    }
    const readme = await fs.readFile(path.join(windowsRoot, "README.txt"), "utf8");
    assert.match(readme, /Windows PowerShell install:/u);
    assert.equal(readme.includes("./lico-mcp-install.sh"), false);
    return {
      powershellEntrypoints: 3,
      posixEntrypointsAbsent: true,
      batchAliasesAbsent: files.every((file) => !file.endsWith(".cmd"))
    };
  });

  await test("portable archive preserves project and Node distribution legal files", async () => {
    assert.equal(
      await sha256(path.join(extractedRoot, "LICENSE")),
      await sha256(path.join(projectRoot, "LICENSE"))
    );
    assert.equal(
      await sha256(path.join(extractedRoot, "app", "LICENSE")),
      await sha256(path.join(connectorRoot, "LICENSE"))
    );
    for (const filename of ["LICENSE", "NOTICE"]) {
      assert.equal(
        await sha256(path.join(extractedRoot, "licenses", "node", filename)),
        await sha256(path.join(nodeRuntimeFixture.distributionRoot, filename))
      );
    }
    return {
      projectLicensePresent: true,
      connectorLicensePresent: true,
      nodeLegalFileCount: bundle.nodeLegalFiles.length,
      thirdPartyNoticeIndexPresent: true
    };
  });

  await test("release checksum index is deterministic and rejects ambiguous asset names", async () => {
    const checksum = await writeReleaseChecksumIndex(outputDir);
    const text = await fs.readFile(checksum.checksumFilePath, "utf8");
    assert.match(text, new RegExp(`^[a-f0-9]{64}  ${bundle.archiveName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "mu"));
    const ambiguousPath = path.join(outputDir, "ambiguous asset.tar.gz");
    await fs.writeFile(ambiguousPath, "fixture", "utf8");
    await assert.rejects(() => writeReleaseChecksumIndex(outputDir), /release_asset_filename_not_checksum_safe/u);
    await fs.rm(ambiguousPath, { force: true });
    return {
      indexedAssetCount: checksum.assetCount,
      archiveDigestMatched: true,
      ambiguousAssetNameRejected: true
    };
  });

  await test("portable unpacked artifact passes privacy-safe public boundary scan", async () => {
    const scan = await scanPublicArtifact(extractedRoot, {
      localNeedles: [projectRoot, tempRoot]
    });
    assert.deepEqual(scan.findings, []);
    assert.equal(scan.ok, true);
    return {
      scannedFileCount: scan.summary.scannedFileCount,
      scannedTextFileCount: scan.summary.scannedTextFileCount,
      skippedBinaryOrOversizedFileCount: scan.summary.skippedBinaryOrOversizedFileCount,
      findingCount: scan.summary.findingCount
    };
  });

  await test("portable lico-mcp help exposes the release target set", async () => {
    const { stdout, stderr } = await runPortable(executable, ["help"]);
    assertNoLeakText(stdout, "portable help stdout");
    assertNoLeakText(stderr, "portable help stderr");
    for (const targetName of MCP_SUPPORTED_TARGETS) {
      assert.equal(stdout.includes(targetName), true, `help missing target ${targetName}`);
    }
    return {
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: Buffer.byteLength(stderr),
      targetCount: MCP_SUPPORTED_TARGETS.length
    };
  });

  await test("portable lico-mcp version json matches stable MCP identity", async () => {
    const { stdout, stderr } = await runPortable(executable, ["version", "--json"]);
    assertNoLeakText(stdout, "portable version stdout");
    assertNoLeakText(stderr, "portable version stderr");
    const payload = JSON.parse(stdout);
    assert.equal(payload.packageName, MCP_CONNECTOR_PACKAGE_NAME);
    assert.equal(payload.packageVersion, MCP_CONNECTOR_VERSION);
    assert.equal(payload.stableToolName, MCP_STABLE_TOOL_NAME);
    return {
      packageName: payload.packageName,
      packageVersion: payload.packageVersion,
      stableToolName: payload.stableToolName
    };
  });

  await test("portable lico-mcp scan no-scan returns every release target without install", async () => {
    const { stdout, stderr } = await runPortable(executable, ["scan", "--json", "--no-scan"]);
    assertNoLeakText(stdout, "portable scan stdout");
    assertNoLeakText(stderr, "portable scan stderr");
    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    const targets = (payload.candidates || []).map((candidate) => candidate.target).sort();
    assert.deepEqual(targets, [...MCP_SUPPORTED_TARGETS].sort());
    assert.equal((payload.candidates || []).every((candidate) => candidate.installed === false), true);
    return {
      candidateCount: targets.length,
      targets
    };
  });
} catch (error) {
  process.exitCode = 1;
  if (!report.tests.some((item) => item.status === "failed")) {
    record("verifier failed before a named test completed", "failed", failureEvidence(error));
  }
  console.error(safeEvidence(failureEvidence(error)).message || "portable verifier failed");
} finally {
  try {
    await writeReport();
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}
