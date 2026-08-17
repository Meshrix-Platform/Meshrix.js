import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { controlledRef, sandboxDigest } from "#meshrix/foundation/execution-sandbox/contracts";
import { createOciSandboxBackend } from "./oci-backend.ts";

interface OciCandidate {
  id: string;
  providerClass: string;
  engine: "podman" | "docker";
  binary: string;
  runtimeClass: string;
  rootless: boolean;
}
interface OciBackend {
  descriptor(): Promise<{ healthy?: boolean; enforcedRestrictions?: readonly string[]; [key: string]: unknown }>;
}
type BackendFactory = (input: { id: string; binary: string; engine: string; runtimeClass: string }) => OciBackend;
type RootlessProbe = (candidate: OciCandidate, options?: { timeoutMs?: number }) => Promise<boolean>;
type IdentityProbe = (candidate: OciCandidate) => Promise<string>;
interface AdapterOptions {
  platform?: NodeJS.Platform;
  conformanceReceipts?: Record<string, unknown>;
  pathExists?: (candidatePath: string) => boolean;
  rootlessProbe?: RootlessProbe;
  executableIdentityProbe?: IdentityProbe;
  backendFactory?: BackendFactory;
}
interface ExecutableOptions { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }

const FIXED_CANDIDATES: Readonly<Partial<Record<NodeJS.Platform, readonly OciCandidate[]>>> = Object.freeze({
  darwin: Object.freeze([
    { id: "oci.rootless-podman", providerClass: "rootless-podman", engine: "podman" as const, binary: "podman", runtimeClass: "crun", rootless: true },
    { id: "oci.docker", providerClass: "docker", engine: "docker" as const, binary: "docker", runtimeClass: "runc", rootless: false }
  ]),
  linux: Object.freeze([
    { id: "oci.rootless-podman", providerClass: "rootless-podman", engine: "podman" as const, binary: "podman", runtimeClass: "crun", rootless: true },
    { id: "oci.podman", providerClass: "podman", engine: "podman" as const, binary: "podman", runtimeClass: "crun", rootless: false },
    { id: "oci.rootless-docker", providerClass: "rootless-docker", engine: "docker" as const, binary: "docker", runtimeClass: "runc", rootless: true },
    { id: "oci.docker", providerClass: "docker", engine: "docker" as const, binary: "docker", runtimeClass: "runc", rootless: false }
  ])
});

function resolveExecutablePath(command = "", {
  env = process.env,
  platform = process.platform
}: ExecutableOptions = {}): string {
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

function resolveCandidateBinary(candidate: OciCandidate, platform: NodeJS.Platform = process.platform): string {
  return resolveExecutablePath(candidate.binary, { platform });
}

function fixedRootlessProbe(candidate: OciCandidate, { timeoutMs = 2_000 }: { timeoutMs?: number } = {}): Promise<boolean> {
  const args = candidate.engine === "podman"
    ? ["info", "--format", "{{.Host.Security.Rootless}}"]
    : ["info", "--format", "{{json .SecurityOptions}}"];
  return new Promise<boolean>((resolve) => {
    let bytes = 0;
    let output = "";
    let settled = false;
    let child: ReturnType<typeof spawn>;
    let timer: NodeJS.Timeout;
    const finish = (value: boolean) => {
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
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024) {
        child.kill("SIGKILL");
        finish(false);
        return;
      }
      output += chunk.toString("utf8");
    });
    child.once("error", () => finish(false));
    child.once("close", (code: number | null) => {
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

async function fixedExecutableIdentityProbe(candidate: OciCandidate): Promise<string> {
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
  pathExists = (candidatePath: string) => Boolean(resolveExecutablePath(candidatePath, { platform })),
  rootlessProbe = fixedRootlessProbe,
  executableIdentityProbe = fixedExecutableIdentityProbe,
  backendFactory = createOciSandboxBackend
}: AdapterOptions = {}) {
  const candidates = FIXED_CANDIDATES[platform] || [];
  return Object.freeze(candidates.map((candidate) => {
    let backend: OciBackend | null = null;
    const ensureBackend = (): OciBackend => {
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
      async probe()  {
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
      async createBackend()  {
        return ensureBackend();
      }
    });
  }));
}

export async function createOciBackendConformanceTarget({
  platform = process.platform,
  pathExists = (candidatePath: string) => Boolean(resolveExecutablePath(candidatePath, { platform })),
  rootlessProbe = fixedRootlessProbe,
  executableIdentityProbe = fixedExecutableIdentityProbe,
  backendFactory = createOciSandboxBackend
}: Omit<AdapterOptions, "conformanceReceipts"> = {}) {
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

export const TRUSTED_OCI_PROVIDER_CLASSES: readonly string[] = Object.freeze([
  "rootless-podman",
  "podman",
  "rootless-docker",
  "docker"
]);
