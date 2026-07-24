import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { controlledRef, sandboxDigest } from "#meshrix/foundation/execution-sandbox/contracts";
import { createOciSandboxBackend } from "./oci-backend.mjs";

const FIXED_CANDIDATES = Object.freeze({
  darwin: Object.freeze([
    { id: "oci.rootless-podman", providerClass: "rootless-podman", engine: "podman", binary: "podman", runtimeClass: "crun", rootless: true },
    { id: "oci.docker", providerClass: "docker", engine: "docker", binary: "docker", runtimeClass: "runc", rootless: false }
  ]),
  linux: Object.freeze([
    { id: "oci.rootless-podman", providerClass: "rootless-podman", engine: "podman", binary: "podman", runtimeClass: "crun", rootless: true },
    { id: "oci.podman", providerClass: "podman", engine: "podman", binary: "podman", runtimeClass: "crun", rootless: false },
    { id: "oci.rootless-docker", providerClass: "rootless-docker", engine: "docker", binary: "docker", runtimeClass: "runc", rootless: true },
    { id: "oci.docker", providerClass: "docker", engine: "docker", binary: "docker", runtimeClass: "runc", rootless: false }
  ])
});

function resolveExecutablePath(command, {
  env = process.env,
  platform = process.platform
} = {}) {
  if (!command) return "";
  if (path.isAbsolute(command)) return fs.existsSync(command) ? command : "";
  const pathValue = env.PATH || env.Path || env.path || "";
  const extensions = platform === "win32"
    ? String(env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidatePath = path.join(directory, `${command}${extension}`);
      if (fs.existsSync(candidatePath)) return candidatePath;
    }
  }
  return "";
}

function resolveCandidateBinary(candidate, platform = process.platform) {
  return resolveExecutablePath(candidate.binary, { platform });
}

function fixedRootlessProbe(candidate, { timeoutMs = 2_000 } = {}) {
  const args = candidate.engine === "podman"
    ? ["info", "--format", "{{.Host.Security.Rootless}}"]
    : ["info", "--format", "{{json .SecurityOptions}}"];
  return new Promise((resolve) => {
    let bytes = 0;
    let output = "";
    let settled = false;
    let child;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    try {
      child = spawn(resolveCandidateBinary(candidate) || candidate.binary, args, {
        env: { PATH: process.env.PATH || "" },
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true
      });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024) {
        child.kill("SIGKILL");
        finish(false);
        return;
      }
      output += chunk.toString("utf8");
    });
    child.once("error", () => finish(false));
    child.once("close", (code) => {
      if (code !== 0) {
        finish(false);
        return;
      }
      const normalized = output.trim().toLowerCase();
      finish(candidate.engine === "podman"
        ? normalized === "true"
        : normalized.includes("rootless"));
    });
  });
}

async function fixedExecutableIdentityProbe(candidate) {
  const executablePath = resolveExecutablePath(candidate.binary);
  if (!executablePath) throw new Error("OCI executable is unavailable");
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(executablePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

export function createTrustedOciProviderAdapters({
  platform = process.platform,
  conformanceReceipts = {},
  pathExists = (candidatePath) => Boolean(resolveExecutablePath(candidatePath, { platform })),
  rootlessProbe = fixedRootlessProbe,
  executableIdentityProbe = fixedExecutableIdentityProbe,
  backendFactory = createOciSandboxBackend
} = {}) {
  const candidates = FIXED_CANDIDATES[platform] || [];
  return Object.freeze(candidates.map((candidate) => {
    let backend = null;
    const ensureBackend = () => {
      backend ||= backendFactory({
        id: candidate.id,
        binary: resolveCandidateBinary(candidate, platform),
        engine: candidate.engine,
        runtimeClass: candidate.runtimeClass
      });
      return backend;
    };
    return Object.freeze({
      id: candidate.id,
      providerClass: candidate.providerClass,
      async probe() {
        if (!pathExists(candidate.binary)) {
          return Object.freeze({
            id: candidate.id,
            providerClass: candidate.providerClass,
            healthy: false,
            production: true,
            enforcedRestrictions: []
          });
        }
        const actualRootless = await rootlessProbe(candidate);
        if (actualRootless !== candidate.rootless) {
          return Object.freeze({
            id: candidate.id,
            providerClass: candidate.providerClass,
            healthy: false,
            production: true,
            enforcedRestrictions: []
          });
        }
        let executableIdentityDigest;
        try {
          executableIdentityDigest = await executableIdentityProbe(candidate);
        } catch {
          return Object.freeze({
            id: candidate.id,
            providerClass: candidate.providerClass,
            healthy: false,
            production: true,
            enforcedRestrictions: []
          });
        }
        if (!/^[a-f0-9]{64}$/u.test(String(executableIdentityDigest || ""))) {
          return Object.freeze({
            id: candidate.id,
            providerClass: candidate.providerClass,
            healthy: false,
            production: true,
            enforcedRestrictions: []
          });
        }
        const descriptor = await ensureBackend().descriptor();
        const serviceIdentityRef = controlledRef(sandboxDigest({
          providerId: candidate.id,
          engine: candidate.engine,
          runtimeClass: candidate.runtimeClass,
          executableIdentityDigest
        }), "sandbox-provider-service");
        return Object.freeze({
          ...descriptor,
          id: candidate.id,
          providerClass: candidate.providerClass,
          isolationClass: "hardened-oci",
          serviceIdentityRef,
          executableIdentityDigest,
          conformanceReceipt: conformanceReceipts[candidate.id] || null
        });
      },
      async createBackend() {
        return ensureBackend();
      }
    });
  }));
}

export async function createOciBackendConformanceTarget({
  platform = process.platform,
  pathExists = (candidatePath) => Boolean(resolveExecutablePath(candidatePath, { platform })),
  rootlessProbe = fixedRootlessProbe,
  executableIdentityProbe = fixedExecutableIdentityProbe,
  backendFactory = createOciSandboxBackend
} = {}) {
  for (const candidate of FIXED_CANDIDATES[platform] || []) {
    if (!pathExists(candidate.binary)) continue;
    let actualRootless;
    try {
      actualRootless = await rootlessProbe(candidate);
    } catch {
      continue;
    }
    if (actualRootless !== candidate.rootless) continue;
    let executableIdentityDigest;
    try {
      executableIdentityDigest = await executableIdentityProbe(candidate);
    } catch {
      continue;
    }
    if (!/^[a-f0-9]{64}$/u.test(String(executableIdentityDigest || ""))) continue;
    const resolvedBinary = resolveCandidateBinary(candidate, platform);
    if (!resolvedBinary) continue;
    const backend = backendFactory({
      id: candidate.id,
      binary: resolvedBinary,
      engine: candidate.engine,
      runtimeClass: candidate.runtimeClass
    });
    let descriptor;
    try {
      descriptor = await backend.descriptor();
    } catch {
      continue;
    }
    if (descriptor?.healthy !== true) continue;
    const serviceIdentityRef = controlledRef(sandboxDigest({
      providerId: candidate.id,
      engine: candidate.engine,
      runtimeClass: candidate.runtimeClass,
      executableIdentityDigest
    }), "sandbox-provider-service");
    return Object.freeze({
      id: candidate.id,
      providerClass: candidate.providerClass,
      engine: candidate.engine,
      binary: resolvedBinary,
      isolationClass: "hardened-oci",
      serviceIdentityRef,
      executableIdentityDigest,
      backend
    });
  }
  return null;
}

export const TRUSTED_OCI_PROVIDER_CLASSES = Object.freeze([
  "rootless-podman",
  "podman",
  "rootless-docker",
  "docker"
]);
