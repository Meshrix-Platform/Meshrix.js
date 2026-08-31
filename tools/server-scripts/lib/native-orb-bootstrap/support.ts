import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writePrivateFileAtomic } from "../../../../packages/foundation/src/storage/private-file-atomic.ts";
import { readPrivateOwnerCredentialFile } from "../../console-auth.ts";
import { assertNoSensitiveReportLeak } from "../sensitive-report-scan.ts";
import {
  downloadPinnedFile,
  validateNodeRuntimeLock,
  verifyNodeReleaseSignature,
  verifyNodeRuntimeSignedChecksums,
} from "../mcp-release-portable.ts";
import { probeNativeOrbOrigin, runOrb } from "../native-orb-deployment/support.ts";
import { failNativeOrbBootstrap } from "./contract.ts";

const SHA256_PATTERN: any = /^[a-f0-9]{64}$/u;

export const BOOTSTRAP_REQUIRED_PACKAGES: readonly string[] = Object.freeze([
  "ca-certificates",
  "xz-utils",
  "python3",
  "make",
  "g++",
]);

export const BOOTSTRAP_SECRET_PROVISION_SCRIPT: string = [
  "const fs=require('node:fs'),c=require('node:crypto'),m=[];",
  "for(const p of process.argv.slice(1)){",
  " let v;try{const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o777)!==0o600)process.exit(21);v=fs.readFileSync(p);if(v.length!==64||!/^[a-f0-9]{64}$/.test(v.toString('ascii')))process.exit(22)}catch(e){if(e.code!=='ENOENT')process.exit(23);const r=c.randomBytes(32);v=Buffer.from(r.toString('hex'),'ascii');r.fill(0);try{fs.writeFileSync(p,v,{flag:'wx',mode:0o600})}catch{v.fill(0);process.exit(23)}}",
  " const d=Buffer.from(v.toString('ascii'),'hex');v.fill(0);m.push(d);",
  "}",
  "const equal=c.timingSafeEqual(m[0],m[1]);for(const v of m)v.fill(0);process.exit(equal?24:0);",
].join("");

export function nativeOrbBootstrapRepoRoot() : string {
  return path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
}

export function bootstrapOrbText(machine?: unknown, args?: unknown[], options?: Record<string, any>) : string {
  return String(runOrb({ machine, args, ...options }).stdout || "").trim();
}

export function createPrivateBootstrapStagingDirectory(
  machine?: unknown,
  targetPath?: unknown,
  identity?: unknown,
) : string {
  const target: any = String(targetPath || "");
  const marker: any = String(identity || "");
  if (!path.posix.isAbsolute(target) || !/^[A-Za-z0-9._-]+$/u.test(marker)) {
    failNativeOrbBootstrap("native_orb_bootstrap_staging_invalid", "Bootstrap staging identity is invalid.");
  }
  const parent: any = path.posix.dirname(target);
  const prefix: any = `${path.posix.basename(target)}.${marker}.staging.`;
  const staging: any = bootstrapOrbText(machine, ["mktemp", "-d", path.posix.join(parent, `${prefix}XXXXXX`)], {
    timeout: 15_000,
    code: "native_orb_bootstrap_staging_failed",
  });
  const suffix: any = path.posix.basename(staging).slice(prefix.length);
  if (path.posix.dirname(staging) !== parent || !path.posix.basename(staging).startsWith(prefix) ||
      !/^[A-Za-z0-9]{6}$/u.test(suffix)) {
    failNativeOrbBootstrap("native_orb_bootstrap_staging_invalid", "Bootstrap staging path is invalid.");
  }
  const safe: any = runOrb({
    machine,
    args: ["sh", "-lc", "test -d \"$1\" && test ! -L \"$1\" && test \"$(stat -c %a \"$1\")\" = 700", "meshrix-bootstrap-staging", staging],
    allowFailure: true,
    timeout: 15_000,
  }).status === 0;
  if (!safe) failNativeOrbBootstrap("native_orb_bootstrap_staging_invalid", "Bootstrap staging directory is unsafe.");
  return staging;
}

export function gitObjectText(repoRoot?: unknown, revision?: unknown, relativePath?: unknown) : string {
  const result: any = spawnSync("git", ["show", `${revision}:${relativePath}`], {
    cwd: String(repoRoot), encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) failNativeOrbBootstrap("native_orb_bootstrap_candidate_object_invalid", "Candidate metadata is unavailable.");
  return String(result.stdout || "");
}

export function validateCandidateRuntimeLock(lock?: any, target?: unknown) : any {
  const targetId: any = String(target || "");
  let validated: any;
  try {
    validated = validateNodeRuntimeLock(lock);
  } catch {
    failNativeOrbBootstrap("native_orb_bootstrap_runtime_lock_invalid", "Candidate Node runtime lock is invalid for the target.");
  }
  const descriptor: any = validated.targets?.[targetId];
  if (!/^linux-(?:x64|arm64)$/u.test(targetId) || !descriptor ||
      descriptor.filename !== `node-${validated.version}-${targetId}.tar.xz` ||
      !SHA256_PATTERN.test(String(descriptor.sha256 || ""))) {
    failNativeOrbBootstrap("native_orb_bootstrap_runtime_lock_invalid", "Candidate Node runtime lock is invalid for the target.");
  }
  return descriptor;
}

function versionTuple(value?: unknown) : number[] {
  const match: any = String(value || "").replace(/^v/u, "").match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/u);
  return match ? [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)] : [];
}

function compareVersion(left?: unknown, right?: unknown) : number {
  const a: any = versionTuple(left);
  const b: any = versionTuple(right);
  if (a.length !== 3 || b.length !== 3) return Number.NaN;
  for (let index: any = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}

export function assertRuntimeEngineCompatible(version?: unknown, engine?: unknown) : void {
  const runtime: any = String(version || "").replace(/^v/u, "");
  const clauses: any[] = String(engine || "").split("||").map((value?: any) : any => value.trim()).filter(Boolean);
  const matches: any = clauses.some((clause?: any) : any => clause.split(/\s+/u).every((token?: any) : any => {
    const match: any = token.match(/^(>=|>|<=|<|=)?(\d+(?:\.\d+){0,2})$/u);
    if (!match) return false;
    const comparison: any = compareVersion(runtime, match[2]);
    return match[1] === ">=" ? comparison >= 0 : match[1] === ">" ? comparison > 0 :
      match[1] === "<=" ? comparison <= 0 : match[1] === "<" ? comparison < 0 : comparison === 0;
  }));
  if (!matches) failNativeOrbBootstrap("native_orb_bootstrap_runtime_engine_incompatible", "Candidate Node runtime does not satisfy the repository engine.");
}

async function sha256(filePath?: unknown) : Promise<string> {
  const hash: any = crypto.createHash("sha256");
  const stream: any = fs.createReadStream(String(filePath));
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

export async function acquireAuthenticatedNodeRuntime(lock?: any, target?: unknown) : Promise<any> {
  const descriptor: any = validateCandidateRuntimeLock(lock, target);
  const cacheRoot: any = path.join(os.homedir(), ".cache", "meshrix-js", "native-orb-bootstrap", lock.version);
  await fsp.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const base: any = `${lock.distributionBaseUrl}/${lock.version}`;
  const [checksumsPath, signaturePath, keyPath, archivePath]: any = await Promise.all([
    downloadPinnedFile(`${base}/${lock.checksumsFile}`, path.join(cacheRoot, lock.checksumsFile), lock.checksumsSha256, lock.checksumsSizeBytes),
    downloadPinnedFile(`${base}/${lock.signatureFile}`, path.join(cacheRoot, lock.signatureFile), lock.signatureSha256, lock.signatureSizeBytes),
    downloadPinnedFile(lock.signer.publicKeyUrl, path.join(cacheRoot, `${lock.signer.fingerprint}.asc`), lock.signer.publicKeySha256, lock.signer.publicKeySizeBytes),
    downloadPinnedFile(`${base}/${descriptor.filename}`, path.join(cacheRoot, descriptor.filename), descriptor.sha256, descriptor.sizeBytes),
  ]);
  const checksumsText: any = await fsp.readFile(checksumsPath, "utf8");
  verifyNodeRuntimeSignedChecksums({ lock, checksumsText });
  await verifyNodeReleaseSignature({ lock, checksumsPath, signaturePath, keyPath });
  if (await sha256(archivePath) !== descriptor.sha256) failNativeOrbBootstrap("native_orb_bootstrap_runtime_digest_mismatch", "Node runtime digest is invalid.");
  return Object.freeze({ archivePath, descriptor, version: lock.version });
}

export function deriveBootstrapLayout(home?: unknown, revision?: unknown, runtimeVersion?: unknown) : any {
  const fixedRoot: any = path.posix.join(String(home), ".local", "share", "meshrix-js");
  const configRoot: any = path.posix.join(String(home), ".config", "meshrix-js");
  const secretRoot: any = path.posix.join(String(home), ".config", "meshrix-js-secrets");
  return Object.freeze({
    home: String(home),
    fixedRoot,
    currentDirectory: path.posix.join(fixedRoot, "current"),
    releasesDirectory: path.posix.join(fixedRoot, "releases"),
    releaseDirectory: path.posix.join(fixedRoot, "releases", String(revision)),
    runtimeRoot: path.posix.join(String(home), ".local", "lib", "meshrix-js", "runtime", String(runtimeVersion)),
    dataDirectory: path.posix.join(String(home), ".local", "state", "meshrix-js"),
    configRoot,
    runtimeConfigPath: path.posix.join(configRoot, "runtime.json"),
    secretRoot,
    masterKeyPath: path.posix.join(secretRoot, "local-secret-master-key"),
    proofSignerPath: path.posix.join(secretRoot, "operation-proof-signer"),
    unitPath: path.posix.join(String(home), ".config", "systemd", "user", "meshrix-js.service"),
    sourceMarkerPath: path.posix.join(fixedRoot, "current", ".meshrix-source-revision"),
    runtimeMarkerPath: path.posix.join(String(home), ".local", "lib", "meshrix-js", "runtime", String(runtimeVersion), ".meshrix-runtime-ready"),
  });
}

export function buildBootstrapRuntimeConfig(publicOrigin?: unknown) : string {
  return `${JSON.stringify({
    runtime: { enabledPlugins: [] },
    discovery: {
      bootstrapBaseUrl: String(publicOrigin),
      advertisedBaseUrl: String(publicOrigin),
      activeServiceUrl: String(publicOrigin),
    },
  }, null, 2)}\n`;
}

export function buildBootstrapSystemdUnit(layout?: any, nodeExecutable?: unknown) : string {
  return [
    "[Unit]", "Description=Meshrix.js Core", "After=network-online.target", "Wants=network-online.target", "",
    "[Service]", "Type=simple", "UMask=0077", `WorkingDirectory=${layout.currentDirectory}`,
    `ExecStart=${nodeExecutable} --conditions=source tools/server-scripts/start-server.ts --with-ui --profile core --host 0.0.0.0 --allow-public-console --port 7228 --strict-port --data-dir ${layout.dataDirectory} --runtime-config ${layout.runtimeConfigPath}`,
    `Environment=MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE=${layout.masterKeyPath}`,
    "Environment=MESHRIX_OPERATION_PROOF_EVIDENCE_POLICY=production",
    `Environment=MESHRIX_OPERATION_PROOF_SIGNER_SECRET_FILE=${layout.proofSignerPath}`,
    "Restart=on-failure", "RestartSec=2", "", "[Install]", "WantedBy=default.target", "",
  ].join("\n");
}

export async function loadPrivateBootstrapCredentialBytes(inputPath?: unknown) : Promise<Buffer> {
  const credential: any = await readPrivateOwnerCredentialFile(inputPath);
  try {
    return Buffer.from(JSON.stringify(credential), "utf8");
  } finally {
    credential.username = "";
    credential.password = "";
  }
}

export async function probeBootstrapOrigin(publicOrigin?: unknown, credentialBytes?: Uint8Array) : Promise<any> {
  const probe: any = await probeNativeOrbOrigin(publicOrigin, credentialBytes);
  return Object.freeze({
    health: probe.healthOk ? "healthy" : "unhealthy",
    console: probe.consoleOk ? "available" : "unavailable",
    authentication: probe.authenticationOk ? "authenticated" : "denied",
    governedRead: probe.governedOperationOk ? "authorized" : "denied",
  });
}

export async function cleanupFailedBootstrapActivation(context?: any) : Promise<void> {
  if (!context?.bootstrapOwnedUnit || !context?.layout?.unitPath) return;
  const machine: any = context.parsed.machine;
  runOrb({ machine, args: ["systemctl", "--user", "stop", "meshrix-js.service"], allowFailure: true, timeout: 30_000 });
  runOrb({ machine, args: ["systemctl", "--user", "disable", "meshrix-js.service"], allowFailure: true, timeout: 30_000 });
  runOrb({ machine, args: ["rm", "-f", context.layout.unitPath], timeout: 30_000 });
  runOrb({ machine, args: ["systemctl", "--user", "daemon-reload"], timeout: 30_000, code: "native_orb_bootstrap_cleanup_in_doubt" });
  const activeState: any = bootstrapOrbText(machine, ["systemctl", "--user", "is-active", "meshrix-js.service"], {
    allowFailure: true,
    timeout: 15_000,
  });
  const enabledState: any = bootstrapOrbText(machine, ["systemctl", "--user", "is-enabled", "meshrix-js.service"], {
    allowFailure: true,
    timeout: 15_000,
  });
  assertBootstrapCleanupState({ activeState, enabledState });
}

export function assertBootstrapCleanupState({ activeState, enabledState }: Record<string, any> = {}) : void {
  if (!["inactive", "failed", "unknown"].includes(String(activeState || "").trim()) ||
      !["disabled", "not-found"].includes(String(enabledState || "").trim())) {
    failNativeOrbBootstrap(
      "native_orb_bootstrap_cleanup_in_doubt",
      "Failed bootstrap activation could not be proven inactive and disabled.",
    );
  }
}

export async function writeNativeOrbBootstrapReceipt(context?: any, stages?: any) : Promise<any> {
  const report: any = Object.freeze({
    schemaVersion: "v0.0.1:deployment:native-orb-bootstrap-report-1",
    verifier: "tools/server-scripts/native-orb-bootstrap.ts",
    candidate: context.sourceRevision,
    candidateDigest: context.candidateDigest,
    url: "<server-url>",
    health: context.probe.health,
    console: context.probe.console,
    authentication: context.probe.authentication,
    governedRead: context.probe.governedRead,
    candidateActive: context.probe.candidateActive === true,
    serviceActive: context.probe.serviceActive === true,
    serviceEnabled: context.probe.serviceEnabled === true,
    stages,
  });
  assertNoSensitiveReportLeak(report, "native Orb bootstrap report");
  await writePrivateFileAtomic(path.join(context.repoRoot, "build", "reports", "native-orb-bootstrap.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
