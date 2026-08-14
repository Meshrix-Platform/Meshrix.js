#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { produceOfflineDeliveryBundle } from "./offline-delivery-producer.ts";
import { transferAndVerifyOfflineDeliveryBundle } from "./offline-delivery-disconnected-verifier.ts";
import { failOfflineDelivery, isRecord } from "./offline-delivery-shared.ts";
import {
  OFFLINE_VM_DEFAULT_HOST_PORT,
  OFFLINE_VM_PREFERRED_HOST_PORT,
  createLinuxVmLifecycleRunner,
  isConsoleDocument,
  prepareOperatorSecretCustody,
  resolveOfflineDeliveryVmMaterials,
} from "./offline-delivery-vm-target.ts";

function repoRootFromMeta() : any {
  return path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
}

async function probeLoopback(port?: any) : Promise<any> {
  const origin: any = `http://127.0.0.1:${Number(port)}`;
  try {
    const health: any = await fetch(`${origin}/api/healthz`, {
      signal: AbortSignal.timeout(2000),
    });
    if (health.ok !== true) {
      return Object.freeze({ listening: true, healthOk: false, consoleOk: false });
    }
    const root: any = await fetch(`${origin}/`, {
      signal: AbortSignal.timeout(2000),
    });
    const body: any = await root.text();
    return Object.freeze({
      listening: true,
      healthOk: true,
      consoleOk: isConsoleDocument({
        status: root.status,
        contentType: root.headers.get("content-type"),
        body,
      }) === true,
    });
  } catch {
    return Object.freeze({ listening: false, healthOk: false, consoleOk: false });
  }
}

function containerNameOwner() : any {
  const result: any = spawnSync("docker", [
    "inspect",
    "--format",
    "{{index .Config.Labels \"com.docker.compose.project\"}}",
    "meshrix-server",
  ], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.status !== 0) return "";
  return String(result.stdout || "").trim();
}

export async function selectOfflineVmHostPort({
  preferredPort = OFFLINE_VM_PREFERRED_HOST_PORT,
  fallbackPort = OFFLINE_VM_DEFAULT_HOST_PORT,
  probe = probeLoopback,
}: Record<string, any> = {}) : Promise<any> {
  const preferred: any = await probe(preferredPort);
  if (preferred.healthOk === true && preferred.consoleOk === true) {
    return Object.freeze({
      port: Number(preferredPort),
      reuse: true,
      healthz: 200,
      console: 200,
    });
  }
  if (preferred.listening === true) {
    failOfflineDelivery(
      "offline_delivery_host_port_conflict",
      "Default host port is occupied by an unrelated or API-only process.",
    );
  }
  const fallback: any = await probe(fallbackPort);
  if (fallback.healthOk === true && fallback.consoleOk === true) {
    return Object.freeze({
      port: Number(fallbackPort),
      reuse: true,
      healthz: 200,
      console: 200,
    });
  }
  const owner: any = containerNameOwner();
  if (owner && owner !== "meshrix-offline-vm") {
    failOfflineDelivery(
      "offline_delivery_container_name_conflict",
      "A different stack already owns the Meshrix server container name.",
    );
  }
  return Object.freeze({
    port: Number(preferredPort),
    reuse: false,
  });
}

export async function runOfflineDeliveryLocalUp({
  repoRoot = repoRootFromMeta(),
}: Record<string, any> = {}) : Promise<any> {
  const selected: any = await selectOfflineVmHostPort();
  if (selected.reuse === true) {
    return Object.freeze({
      ok: true,
      reused: true,
      url: `http://127.0.0.1:${selected.port}`,
      healthz: 200,
      console: 200,
    });
  }

  const cacheRoot: any = path.join(os.homedir(), ".cache", "meshrix-js", "offline-vm-deploy");
  const sourceRoot: any = path.join(cacheRoot, "source");
  const targetRoot: any = path.join(cacheRoot, "target");
  const ociRoot: any = path.join(cacheRoot, "oci");
  const custodyRoot: any = path.join(cacheRoot, "custody");
  await fs.rm(cacheRoot, { recursive: true, force: true });
  await fs.mkdir(ociRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(custodyRoot, { recursive: true, mode: 0o700 });

  const custody: any = prepareOperatorSecretCustody({ custodyRoot });
  if (isRecord(custody.files)) {
    for (const [filePath, contents] of Object.entries(custody.files)) {
      await fs.writeFile(String(filePath), String(contents), { mode: 0o600 });
    }
  }

  const materials: any = await resolveOfflineDeliveryVmMaterials({
    repoRoot,
    ociLayoutOutput: ociRoot,
  });
  if (!materials) {
    failOfflineDelivery(
      "offline_delivery_candidate_materials_missing",
      "Server + Web Console offline images are unavailable.",
    );
  }

  const produced: any = await produceOfflineDeliveryBundle({
    outputRoot: sourceRoot,
    materials,
    allowContractFixture: false,
  });
  const transferred: any = await transferAndVerifyOfflineDeliveryBundle({
    sourceRoot,
    targetRoot,
    trustedPublicKeys: produced.trustedPublicKeys,
  });
  if (transferred.exactBytesVerified !== true) {
    failOfflineDelivery(
      "offline_delivery_transfer_mismatch",
      "Offline bundle transfer did not verify exact bytes.",
    );
  }

  const runner: any = createLinuxVmLifecycleRunner({
    targetRoot,
    custodyEnv: custody.env,
    hostPort: selected.port,
  });
  await runner({ id: "import" });
  await runner({ id: "start" });

  return Object.freeze({
    ok: true,
    reused: false,
    url: `http://127.0.0.1:${selected.port}`,
    healthz: 200,
    console: 200,
  });
}

const invokedDirectly: any = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  runOfflineDeliveryLocalUp().then((result?: any) : any => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error?: any) : any => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code || "offline_delivery_local_up_failed",
    })}\n`);
    process.exitCode = 1;
  });
}
