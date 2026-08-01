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
} from "../../packages/protocols/mcp/adapter/http-mcp-adapter.ts";
import {
  MCP_STABLE_TOOL_NAME
} from "../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/constants.ts";
import {
  MCP_SUPPORTED_TARGETS
} from "../../packages/protocols/mcp/adapter/mcp-release-targets.ts";
import {
  connectorRoot,
  projectRoot,
  readJson,
  sha256,
  writeReleaseChecksumIndex
} from "./lib/mcp-release-common.ts";
import {
  createPortableBundle,
  loadNodeRuntimeLock,
  verifyNodeRuntimeSignedChecksums,
  resolveBundledNodeVersion
} from "./lib/mcp-release-portable.ts";
import { scanPublicArtifact } from "./lib/public-artifact-boundary.ts";

const execFileAsync: any = promisify(execFile);

const REPORT_PATH: any = "build/reports/mcp-release-portable-assembly.json";
const PLATFORM_REPORT_PATH: any = `build/reports/mcp-release-portable-assembly-${currentPortableTarget()}.json`;
const VERIFIER: any = "tools/server-scripts/verify-mcp-release-portable-assembly.ts";
const SCHEMA_VERSION: any = "v0.0.1:mcp:release-portable-assembly-report-1";
const RELEASE_SCRIPT: any = "tools/server-scripts/mcp-release.ts";

function currentPortableTarget() : any {
  const platformMap: Record<string, any> = {
    darwin: "macos",
    linux: "linux",
    win32: "windows"
  };
  const archMap: Record<string, any> = {
    x64: "x64",
    arm64: "arm64"
  };
  return `${platformMap[process.platform] || process.platform}-${archMap[process.arch] || process.arch}`;
}

const tempRoot: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-mcp-release-portable-assembly-"));
const report: Record<string, any> = {
  schemaVersion: SCHEMA_VERSION,
  verifier: VERIFIER,
  platformTarget: currentPortableTarget(),
  startedAt: new Date().toISOString(),
  sourceOfTruth: {
    releaseTargets: "packages/protocols/mcp/adapter/mcp-release-targets.ts",
    portableBuilder: "tools/server-scripts/lib/mcp-release-portable.ts",
    connectorPackage: "packages/protocols/mcp/adapter/gateway-installer/package.json"
  },
  tests: [],
  summary: {}
};

const pathNeedles: any = [...new Set<any>([
  tempRoot,
  await fs.realpath(tempRoot),
  os.homedir(),
  await fs.realpath(os.homedir()),
  projectRoot,
  await fs.realpath(projectRoot)
].filter(Boolean))].sort((left?: any, right?: any) : any => right.length - left.length);

function safeEvidence(value: Record<string, any> = {}) : any {
  return JSON.parse(JSON.stringify(value, (_?: any, child?: any) : any => {
    if (typeof child !== "string") return child;
    let redacted: any = child;
    for (const needle of pathNeedles) {
      if (needle) redacted = redacted.split(needle).join("[redacted-local-path]");
    }
    if (/Bearer\s+\S+/i.test(redacted) || /meshrix_[A-Za-z0-9_-]{12,}=/.test(redacted)) return "[redacted-secret]";
    return redacted;
  }));
}

function assertNoLeakText(text: any = "", label: any = "text") : any {
  const value: any = String(text);
  for (const needle of pathNeedles) {
    assert.equal(needle ? value.includes(needle) : false, false, `${label} leaked local path`);
  }
  assert.equal(/Bearer\s+\S+/i.test(value), false, `${label} leaked bearer token`);
  assert.equal(/meshrix_[A-Za-z0-9_-]{12,}=/.test(value), false, `${label} leaked local grant token`);
}

function assertNoLeak(value?: any, label: any = "payload") : any {
  assertNoLeakText(JSON.stringify(value), label);
}

function record(name?: any, status?: any, evidence: Record<string, any> = {}) : any {
  report.tests.push({ name, status, evidence: safeEvidence(evidence) });
}

function failureEvidence(error?: any) : any {
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    code: String(error?.code || ""),
    message: String(error?.message || "")
  };
}

async function test(name?: any, fn?: any) : Promise<any> {
  process.stdout.write(`  ${name} ... `);
  try {
    const evidence: any = await fn();
    record(name, "passed", evidence);
    console.log("ok");
  } catch (error: any) {
    record(name, "failed", failureEvidence(error));
    console.log("FAIL");
    throw error;
  }
}

async function runPortable(executable?: any, args: any = []) : Promise<any> {
  const isolatedHome: any = path.join(tempRoot, "isolated-home");
  const powershellScript: any = process.platform === "win32" && executable.toLowerCase().endsWith(".ps1");
  const command: any = powershellScript ? "powershell.exe" : executable;
  const commandArgs: any = powershellScript
    ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", executable, ...args]
    : args;
  const result: any = await execFileAsync(command, commandArgs, {
    cwd: path.dirname(executable),
    env: {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
      APPDATA: path.join(isolatedHome, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(isolatedHome, "AppData", "Local"),
      ANTIGRAVITY_MCP_CONFIG_ROOT: path.join(isolatedHome, "antigravity"),
      MESHRIX_MCP_DISCOVERY_FILE: path.join(tempRoot, "isolated", "servers.json"),
      MESHRIX_MCP_TOKEN: "",
      MESHRIX_TOOL_TOKEN: ""
    },
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}

async function extractTarball(archivePath?: any, extractDir?: any) : Promise<any> {
  await fs.mkdir(extractDir, { recursive: true });
  await execFileAsync("tar", ["-xzf", archivePath, "-C", extractDir], {
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024
  });
}

async function listFiles(root?: any) : Promise<any> {
  const files: any[] = [];
  async function visit(dir?: any) : Promise<any> {
    const entries: any = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const child: any = path.join(dir, entry.name);
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

async function createNodeRuntimeFixture() : Promise<any> {
  const distributionRoot: any = path.join(tempRoot, "node-runtime-fixture");
  const executablePath: any = path.join(distributionRoot, "bin", "node");
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

async function writeReport() : Promise<any> {
  report.finishedAt = new Date().toISOString();
  report.summary.testCount = report.tests.length;
  report.summary.failedCount = report.tests.filter((item?: any) : any => item.status !== "passed").length;
  report.summary.releaseReady = report.summary.failedCount === 0;
  report.summary.reportLeakScan = true;
  assertNoLeak(report, "mcp release portable assembly report");
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  const reportText: any = `${JSON.stringify(report, null, 2)}\n`;
  await Promise.all([
    fs.writeFile(REPORT_PATH, reportText, "utf8"),
    fs.writeFile(PLATFORM_REPORT_PATH, reportText, "utf8")
  ]);
}

try {
  const outputDir: any = path.join(tempRoot, "out");
  const extractDir: any = path.join(tempRoot, "extract");
  const packageJson: any = await readJson(path.join(connectorRoot, "package.json"));
  const target: any = currentPortableTarget();
  const bundledVersion: any = await resolveBundledNodeVersion();
  let bundle: any = null;
  let extractedRoot: any = "";
  let executable: any = "";
  let nodeRuntimeFixture: any = null;

  await test("connector package metadata matches runtime constants", async () : Promise<any> => {
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

  await test("portable Node runtime lock rejects unpinned versions and unsigned targets", async () : Promise<any> => {
    const lock: any = await loadNodeRuntimeLock();
    await assert.rejects(() : any => resolveBundledNodeVersion("v0.0.0"), /node_runtime_version_not_locked/u);
    assert.equal(Object.hasOwn(lock.targets, "linux-x64-musl"), false);
    assert.throws(
      () : any => verifyNodeRuntimeSignedChecksums({ lock, checksumsText: "tampered\n" }),
      /node_runtime_checksums_digest_mismatch/u
    );
    const nodeRuntime: any = await createNodeRuntimeFixture();
    await assert.rejects(
      () : any => createPortableBundle({
        outputDir,
        packageJson,
        target: "linux-x64-musl",
        bundledVersion,
        nodeRuntime
      }),
      /node_runtime_target_not_locked/u
    );
    await assert.rejects(
      () : any => execFileAsync(process.execPath, [RELEASE_SCRIPT, "--node-version=v0.0.0", "--json"], {
        cwd: projectRoot,
        timeout: 10000,
        maxBuffer: 1024 * 1024
      }),
      (error?: any) : any => String(error?.stderr || "").includes("node_runtime_version_override_not_supported")
    );
    return {
      lockedVersion: lock.version,
      lockedTargetCount: Object.keys(lock.targets).length,
      unsignedMuslTargetRejected: true,
      releaseCliVersionOverrideRejected: true,
      tamperedChecksumsRejected: true
    };
  });

  await test("portable bundle builds for current platform without client config writes", async () : Promise<any> => {
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
      () : any => fs.access(path.join(outputDir, bundle.rootName)),
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

  await test("portable tar and zip archives are reproducible", async () : Promise<any> => {
    const secondOutputDir: any = path.join(tempRoot, "out-reproducible");
    await fs.mkdir(secondOutputDir, { recursive: true });
    const repeatedBundle: any = await createPortableBundle({
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

  await test("portable archive extracts with executable and runtime files", async () : Promise<any> => {
    await extractTarball(bundle.archivePath, extractDir);
    extractedRoot = path.join(extractDir, bundle.rootName);
    executable = path.join(extractedRoot, bundle.executable);
    const stat: any = await fs.stat(executable);
    assert.equal(stat.isFile(), true);
    if (process.platform !== "win32") {
      assert.notEqual(stat.mode & 0o111, 0, "portable executable bit missing");
    }
    const files: any = await listFiles(extractedRoot);
    const platformEntrypoints: any = target.startsWith("windows-")
      ? ["meshrix-mcp.ps1", "meshrix-mcp-install.ps1", "meshrix-mcp-uninstall.ps1"]
      : ["meshrix-mcp", "meshrix-mcp-install.sh", "meshrix-mcp-uninstall.sh"];
    if (target.startsWith("macos-")) {
      platformEntrypoints.push("install.command", "uninstall.command", "doctor.command");
    }
    for (const required of [
      bundle.executable,
      "mcp-identity.ts",
      "package.json",
      "app/mcp-identity.ts",
      "app/bin/meshrix-mcp.ts",
      "app/mcp-release-targets.ts",
      "app/package.json",
      "app/vendor/contracts/mcp-catalog-delivery.ts",
      "app/vendor/contracts/serialization/canonical-json.ts",
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
    assert.equal(files.some((file?: any) : any => file.startsWith("runtime/")), true);
    const portablePackageJson: any = await readJson(path.join(extractedRoot, "app", "package.json"));
    assert.equal(portablePackageJson.dependencies?.["@meshrix/contracts"], "0.0.1");
    assert.equal(
      portablePackageJson.imports?.["#meshrix/contracts/*"],
      "./vendor/contracts/*.ts"
    );
    const portableRootPackageJson: any = await readJson(path.join(extractedRoot, "package.json"));
    assert.equal(portableRootPackageJson.private, true);
    assert.equal(
      portableRootPackageJson.imports?.["#meshrix/contracts/*"],
      "./app/vendor/contracts/*.ts"
    );
    const [canonicalSource, bundledCanonicalSource] = await Promise.all([
      fs.readFile(path.join(projectRoot, "packages", "contracts", "src", "serialization", "canonical-json.ts")),
      fs.readFile(path.join(
        extractedRoot,
        "app",
        "vendor",
        "contracts",
        "serialization",
        "canonical-json.ts"
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

  await test("portable native entrypoints delegate to the bundled verified connector", async () : Promise<any> => {
    const windowsTarget: any = target.startsWith("windows-");
    const installer: any = path.join(
      extractedRoot,
      windowsTarget ? "meshrix-mcp-install.ps1" : "meshrix-mcp-install.sh"
    );
    const installSource: any = await fs.readFile(installer, "utf8");
    if (windowsTarget) {
      assert.match(installSource, /meshrix-mcp\.ps1/u);
      assert.equal(/Invoke-Expression|\biex\b/iu.test(installSource), false);
    } else {
      assert.match(installSource, /SCRIPT_DIR\/meshrix-mcp/u);
      assert.equal(installSource.includes("eval "), false);
      if (target.startsWith("macos-")) {
        const installCommand: any = await fs.readFile(path.join(extractedRoot, "install.command"), "utf8");
        assert.match(installCommand, /meshrix-mcp-install\.sh/u);
      }
    }
    const { stdout, stderr } = await runPortable(
      installer,
      windowsTarget ? ["-Command", "version", "-Json"] : ["version", "--json"]
    );
    assertNoLeakText(stdout, "portable native version stdout");
    assertNoLeakText(stderr, "portable native version stderr");
    const payload: any = JSON.parse(stdout);
    assert.equal(payload.packageName, MCP_CONNECTOR_PACKAGE_NAME);
    assert.equal(payload.packageVersion, MCP_CONNECTOR_VERSION);
    return {
      delegatedToBundledConnector: true,
      rawEvalAbsent: true
    };
  });

  await test("Windows portable archive exposes PowerShell-only native entrypoints", async () : Promise<any> => {
    const windowsOutputDir: any = path.join(tempRoot, "out-windows-contract");
    const windowsExtractDir: any = path.join(tempRoot, "extract-windows-contract");
    await fs.mkdir(windowsOutputDir, { recursive: true });
    const windowsBundle: any = await createPortableBundle({
      outputDir: windowsOutputDir,
      packageJson,
      target: "windows-x64",
      bundledVersion,
      nodeRuntime: nodeRuntimeFixture
    });
    await extractTarball(windowsBundle.archivePath, windowsExtractDir);
    const windowsRoot: any = path.join(windowsExtractDir, windowsBundle.rootName);
    const files: any = await listFiles(windowsRoot);
    for (const required of ["meshrix-mcp.ps1", "meshrix-mcp-install.ps1", "meshrix-mcp-uninstall.ps1"]) {
      assert.equal(files.includes(required), true, `missing Windows PowerShell entrypoint: ${required}`);
    }
    for (const prohibited of [
      "meshrix-mcp",
      "meshrix-mcp-install.sh",
      "meshrix-mcp-uninstall.sh",
      "install.command",
      "uninstall.command",
      "doctor.command"
    ]) {
      assert.equal(files.includes(prohibited), false, `unexpected Windows entrypoint: ${prohibited}`);
    }
    const readme: any = await fs.readFile(path.join(windowsRoot, "README.txt"), "utf8");
    assert.match(readme, /Windows PowerShell install:/u);
    assert.equal(readme.includes("./meshrix-mcp-install.sh"), false);
    return {
      powershellEntrypoints: 3,
      posixEntrypointsAbsent: true,
      batchAliasesAbsent: files.every((file?: any) : any => !file.endsWith(".cmd"))
    };
  });

  await test("portable archive preserves project and Node distribution legal files", async () : Promise<any> => {
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

  await test("release checksum index is deterministic and rejects ambiguous asset names", async () : Promise<any> => {
    const checksum: any = await writeReleaseChecksumIndex(outputDir);
    const text: any = await fs.readFile(checksum.checksumFilePath, "utf8");
    assert.match(text, new RegExp(`^[a-f0-9]{64}  ${bundle.archiveName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "mu"));
    const ambiguousPath: any = path.join(outputDir, "ambiguous asset.tar.gz");
    await fs.writeFile(ambiguousPath, "fixture", "utf8");
    await assert.rejects(() : any => writeReleaseChecksumIndex(outputDir), /release_asset_filename_not_checksum_safe/u);
    await fs.rm(ambiguousPath, { force: true });
    return {
      indexedAssetCount: checksum.assetCount,
      archiveDigestMatched: true,
      ambiguousAssetNameRejected: true
    };
  });

  await test("portable unpacked artifact passes privacy-safe public boundary scan", async () : Promise<any> => {
    const scan: any = await scanPublicArtifact(extractedRoot, {
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

  await test("portable meshrix-mcp help exposes the release target set", async () : Promise<any> => {
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

  await test("portable meshrix-mcp version json matches stable MCP identity", async () : Promise<any> => {
    const { stdout, stderr } = await runPortable(executable, ["version", "--json"]);
    assertNoLeakText(stdout, "portable version stdout");
    assertNoLeakText(stderr, "portable version stderr");
    const payload: any = JSON.parse(stdout);
    assert.equal(payload.packageName, MCP_CONNECTOR_PACKAGE_NAME);
    assert.equal(payload.packageVersion, MCP_CONNECTOR_VERSION);
    assert.equal(payload.stableToolName, MCP_STABLE_TOOL_NAME);
    return {
      packageName: payload.packageName,
      packageVersion: payload.packageVersion,
      stableToolName: payload.stableToolName
    };
  });

  await test("portable meshrix-mcp scan no-scan returns every release target without install", async () : Promise<any> => {
    const { stdout, stderr } = await runPortable(executable, ["scan", "--json", "--no-scan"]);
    assertNoLeakText(stdout, "portable scan stdout");
    assertNoLeakText(stderr, "portable scan stderr");
    const payload: any = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    const targets: any = (payload.candidates || []).map((candidate?: any) : any => candidate.target).sort();
    assert.deepEqual(targets, [...MCP_SUPPORTED_TARGETS].sort());
    assert.equal((payload.candidates || []).every((candidate?: any) : any => candidate.installed === false), true);
    return {
      candidateCount: targets.length,
      targets
    };
  });
} catch (error: any) {
  process.exitCode = 1;
  if (!report.tests.some((item?: any) : any => item.status === "failed")) {
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
