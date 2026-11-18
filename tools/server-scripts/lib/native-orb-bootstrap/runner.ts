import path from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_ORB_BOOTSTRAP_STAGE_SCRIPTS } from "./catalog.ts";
import { failNativeOrbBootstrap, parseNativeOrbBootstrapArgs } from "./contract.ts";
import {
  cleanupFailedBootstrapActivation,
  loadPrivateBootstrapCredentialBytes,
  nativeOrbBootstrapRepoRoot,
  writeNativeOrbBootstrapReceipt,
} from "./support.ts";

function stageUrl(script?: unknown) : string {
  const extension: any = path.extname(fileURLToPath(import.meta.url));
  return new URL(extension === ".js" ? String(script).replace(/\.ts$/u, ".js") : String(script), import.meta.url).href;
}

export async function loadNativeOrbBootstrapStageScript(stage?: any) : Promise<any> {
  return import(stageUrl(stage.script));
}

export async function runNativeOrbBootstrapStageScripts({
  context,
  stageScripts = NATIVE_ORB_BOOTSTRAP_STAGE_SCRIPTS,
  loadStage = loadNativeOrbBootstrapStageScript,
}: Record<string, any> = {}) : Promise<any> {
  const completed: any = new Set();
  const results: any[] = [];
  for (const stage of stageScripts) {
    if (!(stage.dependsOn || []).every((dependency?: any) : any => completed.has(dependency))) {
      failNativeOrbBootstrap("native_orb_bootstrap_stage_dependency_incomplete", "Bootstrap stage dependency is incomplete.");
    }
    const loaded: any = await loadStage(stage);
    if (typeof loaded?.runNativeOrbBootstrapStage !== "function") {
      failNativeOrbBootstrap("native_orb_bootstrap_stage_script_invalid", "Bootstrap stage script is invalid.");
    }
    const result: any = await loaded.runNativeOrbBootstrapStage(context);
    if (result?.id !== stage.id || !["completed", "resumed"].includes(result?.status)) {
      failNativeOrbBootstrap("native_orb_bootstrap_stage_result_invalid", "Bootstrap stage result is invalid.");
    }
    results.push(Object.freeze({ id: result.id, status: result.status }));
    completed.add(stage.id);
  }
  return Object.freeze(results);
}

export async function bootstrapNativeOrb({ repoRoot = nativeOrbBootstrapRepoRoot(), ...input }: Record<string, any> = {}) : Promise<any> {
  const parsed: any = parseNativeOrbBootstrapArgs([
    "--machine", input.machine,
    "--origin", input.publicOrigin,
    "--candidate", input.sourceRevision,
    "--login-input", input.loginInput,
  ]);
  let ownerCredentialBytes: any;
  try {
    ownerCredentialBytes = await loadPrivateBootstrapCredentialBytes(parsed.loginInput);
  } catch {
    failNativeOrbBootstrap(
      "native_orb_bootstrap_login_input_invalid",
      "Private owner input is invalid or unsafe.",
    );
  }
  const context: any = { parsed, repoRoot, ownerCredentialBytes };
  try {
    const stages: any = await runNativeOrbBootstrapStageScripts({ context });
    const receipt: any = await writeNativeOrbBootstrapReceipt(context, stages);
    return Object.freeze({
      ok: true,
      candidate: context.sourceRevision,
      candidateDigest: context.candidateDigest,
      url: "<server-url>",
      health: receipt.health,
      console: receipt.console,
      authentication: receipt.authentication,
      governedRead: receipt.governedRead,
      candidateActive: receipt.candidateActive,
      serviceActive: receipt.serviceActive,
      serviceEnabled: receipt.serviceEnabled,
      stages,
    });
  } catch (error) {
    if (context.activationStarted === true) await cleanupFailedBootstrapActivation(context);
    throw error;
  } finally {
    ownerCredentialBytes.fill(0);
    context.ownerCredentialBytes = null;
  }
}
