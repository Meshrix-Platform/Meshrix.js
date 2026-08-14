#!/usr/bin/env node
import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import {
  loadEnterpriseOfflineBundle,
  verifyEnterpriseOfflineBundle,
} from "./enterprise-single-node-offline-bundle.ts";
import {
  OFFLINE_DELIVERY_FIRST_GOVERNED_CALL,
  OFFLINE_DELIVERY_LIFECYCLE_STEPS,
  OFFLINE_DELIVERY_PLATFORMS,
  assertLifecycleCommandOffline,
  createOneShotReplayGuard,
  failOfflineDelivery,
  isRecord,
} from "./offline-delivery-shared.ts";

function sha256(value?: any) : any {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function compareText(left?: any, right?: any) : any {
  return left < right ? -1 : left > right ? 1 : 0;
}

function posixRel(sourceRoot?: any, absolutePath?: any) : any {
  return path.relative(sourceRoot, absolutePath).split(path.sep).join("/");
}

async function copyExactTree(sourceRoot?: any, targetRoot?: any) : Promise<any> {
  const sourceStat: any = await fs.lstat(sourceRoot);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    failOfflineDelivery(
      "offline_delivery_source_invalid",
      "Offline bundle source must be a real directory.",
    );
  }
  try {
    const targetStat: any = await fs.lstat(targetRoot);
    if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
      failOfflineDelivery(
        "offline_delivery_target_invalid",
        "Offline bundle target must be a real directory.",
      );
    }
    if ((await fs.readdir(targetRoot)).length !== 0) {
      failOfflineDelivery(
        "offline_delivery_target_not_empty",
        "Disconnected target must start empty.",
      );
    }
  } catch (error: any) {
    if (error?.code?.startsWith?.("offline_delivery_")) throw error;
    if (error?.code !== "ENOENT") {
      failOfflineDelivery(
        "offline_delivery_target_invalid",
        "Disconnected target is unavailable.",
      );
    }
    await fs.mkdir(targetRoot, { recursive: true, mode: 0o700 });
  }

  const files: any[] = [];
  const stack: any[] = [{ directory: sourceRoot, relative: "" }];
  while (stack.length > 0) {
    const current: any = stack.pop();
    const entries: any[] = [];
    const directoryHandle: any = await fs.opendir(current.directory);
    for await (const entry of directoryHandle) {
      entries.push(entry);
    }
    entries.sort((left?: any, right?: any) : any => compareText(left.name, right.name));
    for (const entry of entries) {
      const absolutePath: any = path.join(current.directory, entry.name);
      const relativePath: any = current.relative
        ? `${current.relative}/${entry.name}`
        : entry.name;
      const stat: any = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        failOfflineDelivery(
          "offline_delivery_symlink_denied",
          "Bundle transfer denies symbolic links.",
        );
      }
      if (stat.isDirectory()) {
        await fs.mkdir(path.join(targetRoot, relativePath), {
          recursive: true,
          mode: 0o700,
        });
        stack.push({ directory: absolutePath, relative: relativePath });
        continue;
      }
      if (!stat.isFile() || (stat.mode & 0o111) !== 0) {
        failOfflineDelivery(
          "offline_delivery_special_file",
          "Bundle transfer denies special or executable files.",
        );
      }
      const destinationPath: any = path.join(targetRoot, relativePath);
      await fs.mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
      const handle: any = await fs.open(
        absolutePath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
      );
      try {
        const bytes: any = await handle.readFile();
        await fs.writeFile(destinationPath, bytes, { mode: 0o600, flag: "wx" });
        files.push(Object.freeze({
          path: relativePath || posixRel(sourceRoot, absolutePath),
          digest: `sha256:${sha256(bytes)}`,
          size: bytes.length,
        }));
      } finally {
        await handle.close();
      }
    }
  }
  files.sort((left?: any, right?: any) : any => compareText(left.path, right.path));
  return Object.freeze(files);
}

export function buildDisconnectedLifecyclePlan(bundle?: any) : any {
  if (!isRecord(bundle?.compose) || !Array.isArray(bundle.compose.args)) {
    failOfflineDelivery(
      "offline_delivery_compose_invalid",
      "Disconnected lifecycle requires a signed compose contract.",
    );
  }
  const startArgs: any = ["compose", ...bundle.compose.args.map(String)];
  const steps: any[] = [
    Object.freeze({
      id: "import",
      executable: "skopeo",
      args: Object.freeze([
        "copy",
        "--all",
        "--quiet",
        "oci:files",
        "containers-storage:meshrix-offline:candidate",
      ]),
      networkRequired: false,
      rebuild: false,
    }),
    Object.freeze({
      id: "start",
      executable: "docker",
      args: Object.freeze(startArgs),
      networkRequired: false,
      rebuild: false,
    }),
    Object.freeze({
      id: "first_governed_call",
      executable: "mcp",
      args: Object.freeze([
        OFFLINE_DELIVERY_FIRST_GOVERNED_CALL.method,
        OFFLINE_DELIVERY_FIRST_GOVERNED_CALL.tool,
        OFFLINE_DELIVERY_FIRST_GOVERNED_CALL.operation,
      ]),
      networkRequired: false,
      rebuild: false,
      call: OFFLINE_DELIVERY_FIRST_GOVERNED_CALL,
    }),
    Object.freeze({
      id: "stop",
      executable: "docker",
      args: Object.freeze(["compose", "-f", "compose/compose.yaml", "stop", "meshrix-server"]),
      networkRequired: false,
      rebuild: false,
    }),
    Object.freeze({
      id: "cleanup",
      executable: "docker",
      args: Object.freeze([
        "compose",
        "-f",
        "compose/compose.yaml",
        "down",
        "--remove-orphans",
        "--volumes",
      ]),
      networkRequired: false,
      rebuild: false,
    }),
  ];
  if (
    JSON.stringify(steps.map((step?: any) : any => step.id))
    !== JSON.stringify([...OFFLINE_DELIVERY_LIFECYCLE_STEPS])
  ) {
    failOfflineDelivery(
      "offline_delivery_lifecycle_step_invalid",
      "Disconnected lifecycle step set is incomplete.",
    );
  }
  for (const step of steps) {
    assertLifecycleCommandOffline(step);
  }
  return Object.freeze({
    platforms: Object.freeze([...OFFLINE_DELIVERY_PLATFORMS]),
    networkRequired: false,
    rebuild: false,
    steps: Object.freeze(steps),
  });
}

export async function executeDisconnectedLifecycle({
  plan,
  commandRunner,
  networkAllowed = false,
}: Record<string, any> = {}) : Promise<any> {
  if (networkAllowed === true) {
    failOfflineDelivery(
      "offline_delivery_network_forbidden",
      "Disconnected lifecycle must not enable network access.",
    );
  }
  if (!isRecord(plan) || !Array.isArray(plan.steps)) {
    failOfflineDelivery(
      "offline_delivery_lifecycle_step_invalid",
      "Disconnected lifecycle plan is invalid.",
    );
  }
  if (typeof commandRunner !== "function") {
    failOfflineDelivery(
      "offline_delivery_lifecycle_runner_missing",
      "Disconnected lifecycle runner is required.",
    );
  }
  const outcomes: any[] = [];
  for (const step of plan.steps) {
    assertLifecycleCommandOffline(step);
    const result: any = await commandRunner(step);
    if (result !== true && result?.ok !== true && result?.status !== "passed") {
      failOfflineDelivery(
        "offline_delivery_lifecycle_failed",
        "Disconnected lifecycle step failed closed.",
      );
    }
    outcomes.push(Object.freeze({
      id: step.id,
      status: "passed",
    }));
  }
  return Object.freeze(outcomes);
}

export async function transferAndVerifyOfflineDeliveryBundle({
  sourceRoot,
  targetRoot,
  trustedPublicKeys,
}: Record<string, any> = {}) : Promise<any> {
  if (typeof sourceRoot !== "string" || typeof targetRoot !== "string") {
    failOfflineDelivery(
      "offline_delivery_transfer_roots_invalid",
      "Offline transfer roots are required.",
    );
  }
  const sourceBundle: any = await loadEnterpriseOfflineBundle(sourceRoot);
  const copied: any = await copyExactTree(sourceRoot, targetRoot);
  const verified: any = await verifyEnterpriseOfflineBundle({
    bundleRoot: targetRoot,
    trustedPublicKeys,
    replayGuard: createOneShotReplayGuard(),
  });
  const targetBundle: any = await loadEnterpriseOfflineBundle(targetRoot);
  if (
    sourceBundle.inventory_digest !== targetBundle.inventory_digest
    || sourceBundle.candidate_digest !== targetBundle.candidate_digest
    || sourceBundle.image_digest !== targetBundle.image_digest
  ) {
    failOfflineDelivery(
      "offline_delivery_exact_bytes_mismatch",
      "Disconnected target bytes do not match the source bundle.",
    );
  }
  const expectedPaths: any = copied.map((entry?: any) : any => entry.path);
  if (expectedPaths.length === 0) {
    failOfflineDelivery(
      "offline_delivery_transfer_empty",
      "Disconnected transfer copied no files.",
    );
  }
  return Object.freeze({
    ok: true,
    exactBytesVerified: true,
    filesystemVerified: verified.filesystemVerified === true,
    signatureVerified: verified.ok === true,
    copiedFileCount: copied.length,
    candidateDigest: targetBundle.candidate_digest,
    imageDigest: targetBundle.image_digest,
    inventoryDigest: targetBundle.inventory_digest,
    platforms: Object.freeze([...targetBundle.platforms]),
    bundle: targetBundle,
  });
}
