import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { controlledRef, sandboxDigest } from "#meshrix/foundation/execution-sandbox/contracts";
import { createOciSandboxBackend } from "./oci-backend.ts";

const FIXED_CANDIDATES: Readonly<Record<string, any>> = Object.freeze({
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

function resolveExecutablePath(command?: any, {
  env = process.env,
  platform = process.platform
}: Record<string, any> = {}) : any {
  if (!command) return "";
  if (path.isAbsolute(command)) return fs.existsSync(command) ? command : "";
  const pathValue: any = env.PATH || env.Path || env.path || "";
  const extensions: any = platform === "win32"
    ? String(env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidatePath: any = path.join(directory, `${command}${extension}`);
      if (fs.existsSync(candidatePath)) return candidatePath;
    }
  }
  return "";
}

function resolveCandidateBinary(candidate?: any, platform: any = process.platform) : any {
  return resolveExecutablePath(candidate.binary, { platform });
}

function fixedRootlessProbe(candidate?: any, { timeoutMs = 2_000 }: Record<string, any> = {}) : any {
  const args: any = candidate.engine === "podman"
    ? ["info", "--format", "{{.Host.Security.Rootless}}"]
    : ["info", "--format", "{{json .SecurityOptions}}"];
  return new Promise((resolve?: any) : any => {
    let bytes: any = 0;
    let output: any = "";
    let settled: any = false;
    let child: any;
    const finish: any = (value?: any) : any => {
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
    const timer: any = setTimeout(() : any => {
      child.kill("SIGKILL");
      finish(false);
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk?: any) : any => {
      bytes += chunk.length;
      if (bytes > 4 * 1024) {
        child.kill("SIGKILL");
        finish(false);
        return;
      }
      output += chunk.toString("utf8");
    });
    child.once("error", () : any => finish(false));
    child.once("close", (code?: any) : any => {
      if (code !== 0) {
        finish(false);
        return;
      }
      const normalized: any = output.trim().toLowerCase();
      finish(candidate.engine === "podman"
        ? normalized === "true"
        : normalized.includes("rootless"));
    });
  });
}

async function fixedExecutableIdentityProbe(candidate?: any) : Promise<any> {
  const executablePath: any = resolveExecutablePath(candidate.binary);
  if (!executablePath) throw new Error("OCI executable is unavailable");
  const hash: any = crypto.createHash("sha256");
  const stream: any = fs.createReadStream(executablePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

export function createTrustedOciProviderAdapters({
  platform = process.platform,
  conformanceReceipts = {},
  pathExists = (candidatePath?: any) : any => Boolean(resolveExecutablePath(candidatePath, { platform })),
  rootlessProbe = fixedRootlessProbe,
  executableIdentityProbe = fixedExecutableIdentityProbe,
  backendFactory = createOciSandboxBackend
}: Record<string, any> = {}) : any {
  const candidates: any = FIXED_CANDIDATES[platform] || [];
  return Object.freeze(candidates.map((candidate?: any) : any => {
    let backend: any = null;
    const ensureBackend: any = () : any => {
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
      async probe() : Promise<any> {
        if (!pathExists(candidate.binary)) {
          return Object.freeze({
            id: candidate.id,
            providerClass: candidate.providerClass,
            healthy: false,
            production: true,
            enforcedRestrictions: []
          });
        }
        const actualRootless: any = await rootlessProbe(candidate);
        if (actualRootless !== candidate.rootless) {
          return Object.freeze({
            id: candidate.id,
            providerClass: candidate.providerClass,
            healthy: false,
            production: true,
            enforcedRestrictions: []
          });
        }
        let executableIdentityDigest: any;
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
        const descriptor: any = await ensureBackend().descriptor();
        const serviceIdentityRef: any = controlledRef(sandboxDigest({
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
      async createBackend() : Promise<any> {
        return ensureBackend();
      }
    });
  }));
}

export async function createOciBackendConformanceTarget({
  platform = process.platform,
  pathExists = (candidatePath?: any) : any => Boolean(resolveExecutablePath(candidatePath, { platform })),
  rootlessProbe = fixedRootlessProbe,
  executableIdentityProbe = fixedExecutableIdentityProbe,
  backendFactory = createOciSandboxBackend
}: Record<string, any> = {}) : Promise<any> {
  for (const candidate of FIXED_CANDIDATES[platform] || []) {
    if (!pathExists(candidate.binary)) continue;
    let actualRootless: any;
    try {
      actualRootless = await rootlessProbe(candidate);
    } catch {
      continue;
    }
    if (actualRootless !== candidate.rootless) continue;
    let executableIdentityDigest: any;
    try {
      executableIdentityDigest = await executableIdentityProbe(candidate);
    } catch {
      continue;
    }
    if (!/^[a-f0-9]{64}$/u.test(String(executableIdentityDigest || ""))) continue;
    const resolvedBinary: any = resolveCandidateBinary(candidate, platform);
    if (!resolvedBinary) continue;
    const backend: any = backendFactory({
      id: candidate.id,
      binary: resolvedBinary,
      engine: candidate.engine,
      runtimeClass: candidate.runtimeClass
    });
    let descriptor: any;
    try {
      descriptor = await backend.descriptor();
    } catch {
      continue;
    }
    if (descriptor?.healthy !== true) continue;
    const serviceIdentityRef: any = controlledRef(sandboxDigest({
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

export const TRUSTED_OCI_PROVIDER_CLASSES: readonly any[] = Object.freeze([
  "rootless-podman",
  "podman",
  "rootless-docker",
  "docker"
]);
