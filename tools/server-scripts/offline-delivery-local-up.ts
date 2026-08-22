#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { produceOfflineDeliveryBundle } from "./offline-delivery-producer.ts";
import { transferAndVerifyOfflineDeliveryBundle } from "./offline-delivery-disconnected-verifier.ts";
import {
  createOneShotReplayGuard,
  failOfflineDelivery,
  isRecord,
} from "./offline-delivery-shared.ts";
import {
  loadEnterpriseOfflineBundle,
  verifyEnterpriseOfflineBundle,
} from "./enterprise-single-node-offline-bundle.ts";
import {
  OFFLINE_VM_DEFAULT_HOST_PORT,
  OFFLINE_VM_LOADED_IMAGE,
  OFFLINE_VM_PREFERRED_HOST_PORT,
  createLinuxVmLifecycleRunner,
  imageHasConsoleIndex,
  imageSourceRevision,
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

function inspectOfflineContainer() : any {
  const result: any = spawnSync("docker", [
    "inspect",
    "--format",
    "{{index .Config.Labels \"com.docker.compose.project\"}} {{.Image}}",
    "meshrix-server",
  ], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.status !== 0) {
    return Object.freeze({ present: false, project: "", sourceRevision: "" });
  }
  const [project = "", image = ""]: any[] = String(result.stdout || "").trim().split(/\s+/u);
  return Object.freeze({
    present: true,
    project,
    sourceRevision: imageSourceRevision(image),
  });
}

function currentSourceRevision(repoRoot?: any) : any {
  const result: any = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 15_000,
  });
  const revision: any = String(result.stdout || "").trim();
  if (result.status !== 0 || !/^[0-9a-f]{40}$/u.test(revision)) {
    failOfflineDelivery(
      "offline_delivery_candidate_identity_failed",
      "Offline candidate identity is unavailable.",
    );
  }
  return revision;
}

async function readJson(filePath?: any) : Promise<any> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function writeJsonAtomic(filePath?: any, value?: any) : Promise<any> {
  const temporary: any = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
}

async function readDeploymentState(statePath?: any, sourceRevision?: any) : Promise<any> {
  const state: any = await readJson(statePath);
  if (
    !isRecord(state)
    || state.schema_version !== 1
    || state.source_revision !== sourceRevision
    || !Array.isArray(state.completed_stages)
  ) {
    return Object.freeze({ completed_stages: Object.freeze([]) });
  }
  return Object.freeze({
    completed_stages: Object.freeze(state.completed_stages.map(String)),
  });
}

async function recordDeploymentStage({
  statePath,
  sourceRevision,
  completedStages,
  stage,
}: Record<string, any> = {}) : Promise<any> {
  if (!completedStages.includes(stage)) completedStages.push(stage);
  await writeJsonAtomic(statePath, {
    schema_version: 1,
    source_revision: sourceRevision,
    completed_stages: completedStages,
  });
}

async function validCachedBundle({
  bundleRoot,
  trustPath,
  sourceRevision,
}: Record<string, any> = {}) : Promise<any> {
  const trustedPublicKeys: any = await readJson(trustPath);
  if (!isRecord(trustedPublicKeys)) return null;
  try {
    const bundle: any = await loadEnterpriseOfflineBundle(bundleRoot);
    if (bundle.authorities?.source_candidate?.source_revision !== sourceRevision) return null;
    await verifyEnterpriseOfflineBundle({
      bundleRoot,
      trustedPublicKeys,
      replayGuard: createOneShotReplayGuard(),
    });
    return Object.freeze({ bundle, trustedPublicKeys });
  } catch {
    return null;
  }
}

export async function selectOfflineVmHostPort({
  preferredPort = OFFLINE_VM_PREFERRED_HOST_PORT,
  fallbackPort = OFFLINE_VM_DEFAULT_HOST_PORT,
  probe = probeLoopback,
  expectedRevision = "",
  inspectContainer = inspectOfflineContainer,
}: Record<string, any> = {}) : Promise<any> {
  const container: any = inspectContainer();
  const preferred: any = await probe(preferredPort);
  if (preferred.healthOk === true && preferred.consoleOk === true) {
    if (container?.project !== "meshrix-offline-vm") {
      failOfflineDelivery(
        "offline_delivery_host_port_conflict",
        "Default host port is occupied by a different stack.",
      );
    }
    if (expectedRevision && container?.sourceRevision !== expectedRevision) {
      return Object.freeze({
        port: Number(preferredPort),
        reuse: false,
        replace: true,
      });
    }
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
    if (container?.project !== "meshrix-offline-vm") {
      failOfflineDelivery(
        "offline_delivery_host_port_conflict",
        "Fallback host port is occupied by a different stack.",
      );
    }
    if (expectedRevision && container?.sourceRevision !== expectedRevision) {
      return Object.freeze({
        port: Number(fallbackPort),
        reuse: false,
        replace: true,
      });
    }
    return Object.freeze({
      port: Number(fallbackPort),
      reuse: true,
      healthz: 200,
      console: 200,
    });
  }
  const owner: any = String(container?.project || "");
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
  const sourceRevision: any = currentSourceRevision(repoRoot);
  const selected: any = await selectOfflineVmHostPort({
    expectedRevision: sourceRevision,
  });
  if (selected.reuse === true) {
    return Object.freeze({
      ok: true,
      reused: true,
      sourceRevision,
      stages: Object.freeze([{ id: "verify", status: "resumed" }]),
      url: `http://127.0.0.1:${selected.port}`,
      healthz: 200,
      console: 200,
    });
  }

  const cacheRoot: any = path.join(os.homedir(), ".cache", "meshrix-js", "offline-vm-deploy");
  const candidateRoot: any = path.join(cacheRoot, "candidates", sourceRevision);
  const sourceRoot: any = path.join(candidateRoot, "source");
  const targetRoot: any = path.join(candidateRoot, "target");
  const ociRoot: any = path.join(candidateRoot, "oci");
  const statePath: any = path.join(candidateRoot, "state.json");
  const trustPath: any = path.join(candidateRoot, "trusted-public-keys.json");
  const custodyRoot: any = path.join(cacheRoot, "custody");
  await fs.mkdir(candidateRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(ociRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(custodyRoot, { recursive: true, mode: 0o700 });
  const savedState: any = await readDeploymentState(statePath, sourceRevision);
  const completedStages: any[] = [...savedState.completed_stages];
  const stages: any[] = [];
  const completeStage: any = async (stage?: any, resumed = false) : Promise<any> => {
    await recordDeploymentStage({
      statePath,
      sourceRevision,
      completedStages,
      stage,
    });
    stages.push(Object.freeze({ id: stage, status: resumed ? "resumed" : "completed" }));
  };
  await completeStage("candidate", completedStages.includes("candidate"));

  const custody: any = prepareOperatorSecretCustody({ custodyRoot });
  if (isRecord(custody.files)) {
    for (const [filePath, contents] of Object.entries(custody.files)) {
      try {
        await fs.writeFile(String(filePath), String(contents), { mode: 0o600, flag: "wx" });
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
  }

  let produced: any = await validCachedBundle({
    bundleRoot: sourceRoot,
    trustPath,
    sourceRevision,
  });
  if (produced) {
    await completeStage("images", true);
    await completeStage("bundle", true);
  } else {
    completedStages.splice(0, completedStages.length, "candidate");
    await fs.rm(sourceRoot, { recursive: true, force: true });
    await fs.rm(targetRoot, { recursive: true, force: true });
    await fs.rm(ociRoot, { recursive: true, force: true });
    await fs.mkdir(ociRoot, { recursive: true, mode: 0o700 });
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
    await completeStage("images", false);
    produced = await produceOfflineDeliveryBundle({
      outputRoot: sourceRoot,
      materials,
      allowContractFixture: false,
    });
    await writeJsonAtomic(trustPath, produced.trustedPublicKeys);
    await completeStage("bundle", false);
  }

  let transferred: any = await validCachedBundle({
    bundleRoot: targetRoot,
    trustPath,
    sourceRevision,
  });
  if (transferred) {
    await completeStage("transfer", true);
  } else {
    const transferIndex: any = completedStages.indexOf("transfer");
    if (transferIndex >= 0) completedStages.splice(transferIndex);
    await fs.rm(targetRoot, { recursive: true, force: true });
    transferred = await transferAndVerifyOfflineDeliveryBundle({
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
    await completeStage("transfer", false);
  }

  const runner: any = createLinuxVmLifecycleRunner({
    targetRoot,
    custodyEnv: custody.env,
    hostPort: selected.port,
  });
  const imageReady: any = imageSourceRevision(OFFLINE_VM_LOADED_IMAGE) === sourceRevision
    && imageHasConsoleIndex({ image: OFFLINE_VM_LOADED_IMAGE }) === true;
  if (imageReady) {
    await completeStage("import", true);
  } else {
    const importIndex: any = completedStages.indexOf("import");
    if (importIndex >= 0) completedStages.splice(importIndex);
    await runner({ id: "import" });
    await completeStage("import", false);
  }
  await runner({ id: "start" });
  await completeStage("activate", false);
  await runner({ id: "first_governed_call" });
  await completeStage("governed-operation", false);
  const verified: any = await probeLoopback(selected.port);
  if (verified.healthOk !== true || verified.consoleOk !== true) {
    failOfflineDelivery(
      "offline_delivery_lifecycle_failed",
      "Offline instance verification failed.",
    );
  }
  const deployed: any = inspectOfflineContainer();
  if (deployed.sourceRevision !== sourceRevision) {
    failOfflineDelivery(
      "offline_delivery_candidate_activation_mismatch",
      "Offline instance did not activate the selected candidate.",
    );
  }
  await completeStage("verify", false);

  return Object.freeze({
    ok: true,
    reused: false,
    replaced: selected.replace === true,
    sourceRevision,
    stages: Object.freeze(stages),
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
