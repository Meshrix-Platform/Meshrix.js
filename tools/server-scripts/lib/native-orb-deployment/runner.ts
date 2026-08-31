import path from "node:path";
import { fileURLToPath } from "node:url";

import { NATIVE_ORB_DEPLOYMENT_STAGE_SCRIPTS } from "./catalog.ts";
import { failNativeOrbDeployment, parseNativeOrbDeploymentArgs } from "./contract.ts";
import { loadPrivateLoginInputBytes, nativeOrbRepoRoot } from "./support.ts";
import { rollbackNativeOrbActivation, writeNativeOrbProductionUseReceipt } from "./support.ts";

function runtimeStageUrl(script?: any) : any {
  const currentExtension: any = path.extname(fileURLToPath(import.meta.url));
  const runtimeScript: any = currentExtension === ".js"
    ? String(script).replace(/\.ts$/u, ".js")
    : String(script);
  return new URL(runtimeScript, import.meta.url).href;
}

export async function loadNativeOrbDeploymentStageScript(stage?: any) : Promise<any> {
  return import(runtimeStageUrl(stage.script));
}

export async function runNativeOrbDeploymentStageScripts({
  context,
  stageScripts = NATIVE_ORB_DEPLOYMENT_STAGE_SCRIPTS,
  loadStage = loadNativeOrbDeploymentStageScript,
}: Record<string, any> = {}) : Promise<any> {
  const completed: any = new Set<any>();
  const results: any[] = [];
  for (const stage of stageScripts) {
    if (!(stage.dependsOn || []).every((dependency?: any) : any => completed.has(dependency))) {
      failNativeOrbDeployment("native_orb_stage_dependency_incomplete", "Native deployment stage dependency is incomplete.");
    }
    const loaded: any = await loadStage(stage);
    if (typeof loaded?.runNativeOrbDeploymentStage !== "function") {
      failNativeOrbDeployment("native_orb_stage_script_invalid", "Native deployment stage script is invalid.");
    }
    const result: any = await loaded.runNativeOrbDeploymentStage(context);
    if (result?.id !== stage.id || !["completed", "resumed"].includes(result?.status)) {
      failNativeOrbDeployment("native_orb_stage_result_invalid", "Native deployment stage result is invalid.");
    }
    results.push(Object.freeze({ id: result.id, status: result.status }));
    completed.add(stage.id);
  }
  return Object.freeze(results);
}

export async function deployNativeOrbCandidate({
  machine,
  publicOrigin,
  sourceRevision,
  loginInput,
  repoRoot = nativeOrbRepoRoot(),
}: Record<string, any> = {}) : Promise<any> {
  const parsed: any = parseNativeOrbDeploymentArgs([
    "--machine", machine,
    "--origin", publicOrigin,
    "--candidate", sourceRevision,
    "--login-input", loginInput,
  ]);
  const privateLoginBytes: any = await loadPrivateLoginInputBytes(parsed.loginInput);
  const context: any = { parsed, repoRoot, privateLoginBytes };
  try {
    let stages: any;
    try {
      stages = await runNativeOrbDeploymentStageScripts({ context });
    } catch (error: any) {
      if (context.activationStarted === true) {
        try {
          await rollbackNativeOrbActivation(context);
        } catch {
          failNativeOrbDeployment("native_orb_rollback_in_doubt", "Native candidate rollback could not be proven.");
        }
      }
      throw error;
    }
    await writeNativeOrbProductionUseReceipt(context);
    return Object.freeze({
      ok: true,
      candidate: context.sourceRevision.slice(0, 12),
      url: "<server-url>",
      healthz: context.probe.healthz,
      console: context.probe.console,
      authenticated: context.probe.authenticationOk,
      governedOperation: context.probe.governedOperationOk,
      serviceActive: context.probe.serviceActive,
      stages,
    });
  } finally {
    privateLoginBytes.fill(0);
    context.privateLoginBytes = null;
  }
}
