import crypto from "node:crypto";
import path from "node:path";
import { resolveCurrentAcceptedCandidate } from "../../platform-acceptance-generation-store.ts";
import { candidateArchive, runOrb } from "../../native-orb-deployment/support.ts";
import { failNativeOrbBootstrap } from "../contract.ts";
import {
  assertRuntimeEngineCompatible,
  buildBootstrapSystemdUnit,
  deriveBootstrapLayout,
  gitObjectText,
  validateCandidateRuntimeLock,
} from "../support.ts";

export async function runNativeOrbBootstrapStage(context?: any) : Promise<any> {
  const sourceRevision: any = context.parsed.sourceRevision;
  const accepted: any = await resolveCurrentAcceptedCandidate(context.repoRoot);
  if (accepted.receipt.sourceRevision !== sourceRevision) {
    failNativeOrbBootstrap("native_orb_bootstrap_candidate_not_accepted", "Bootstrap candidate is not the current accepted commit.");
  }
  let runtimeLock: any;
  let packageManifest: any;
  try {
    runtimeLock = JSON.parse(gitObjectText(context.repoRoot, sourceRevision, "tools/release/node-runtime.lock.json"));
    packageManifest = JSON.parse(gitObjectText(context.repoRoot, sourceRevision, "package.json"));
  } catch {
    failNativeOrbBootstrap("native_orb_bootstrap_candidate_metadata_invalid", "Candidate runtime metadata is invalid.");
  }
  validateCandidateRuntimeLock(runtimeLock, context.targetId);
  assertRuntimeEngineCompatible(runtimeLock.version, packageManifest?.engines?.node);
  const layout: any = deriveBootstrapLayout(context.home, sourceRevision, runtimeLock.version);
  if (context.existingBootstrapUnit === true) {
    const unitContents: any = buildBootstrapSystemdUnit(
      layout,
      path.posix.join(layout.runtimeRoot, "bin", "node"),
    );
    const unitDigest: any = crypto.createHash("sha256").update(unitContents, "utf8").digest("hex");
    const exactUnit: any = runOrb({
      machine: context.parsed.machine,
      args: ["sh", "-lc", "test -f \"$1\" && test ! -L \"$1\" && test \"$(stat -c %a \"$1\")\" = 600 && test \"$(sha256sum \"$1\" | cut -d ' ' -f 1)\" = \"$2\"", "meshrix-bootstrap-unit-resume", layout.unitPath, unitDigest],
      allowFailure: true,
    }).status === 0;
    if (!exactUnit) {
      failNativeOrbBootstrap("native_orb_bootstrap_service_exists", "Existing Meshrix service unit is foreign or mismatched.");
    }
    context.bootstrapOwnedUnit = true;
  }
  const archive: any = candidateArchive(context.repoRoot, sourceRevision);
  Object.assign(context, {
    sourceRevision,
    candidateDigest: accepted.receipt.candidateDigest,
    runtimeLock,
    packageManifest,
    archive,
    layout,
  });
  return Object.freeze({ id: "candidate", status: archive.resumed ? "resumed" : "completed" });
}
