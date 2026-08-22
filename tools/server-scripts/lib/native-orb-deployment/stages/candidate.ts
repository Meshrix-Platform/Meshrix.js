import { candidateArchive, gitHead } from "../support.ts";

export async function runNativeOrbDeploymentStage(context?: any) : Promise<any> {
  const sourceRevision: any = gitHead(context.repoRoot);
  const archive: any = candidateArchive(context.repoRoot, sourceRevision);
  Object.assign(context, { sourceRevision, archive });
  return Object.freeze({
    id: "candidate",
    status: archive.resumed === true ? "resumed" : "completed",
  });
}
