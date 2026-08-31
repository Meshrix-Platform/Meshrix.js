import { resolveCurrentAcceptanceGeneration } from "../../platform-acceptance-generation-store.ts";
import { candidateArchive } from "../support.ts";
import { failNativeOrbDeployment } from "../contract.ts";

export async function runNativeOrbDeploymentStage(context?: any) : Promise<any> {
  const sourceRevision: any = context.parsed.sourceRevision;
  const accepted: any = await resolveCurrentAcceptanceGeneration(context.repoRoot);
  if (accepted.manifest.sourceRevision !== sourceRevision) {
    failNativeOrbDeployment("native_orb_candidate_not_accepted", "Native deployment candidate is not the current accepted commit.");
  }
  const archive: any = candidateArchive(context.repoRoot, sourceRevision);
  Object.assign(context, {
    sourceRevision,
    candidateDigest: accepted.manifest.candidateDigest,
    archive,
    releaseDirectory: null,
  });
  return Object.freeze({
    id: "candidate",
    status: archive.resumed === true ? "resumed" : "completed",
  });
}
