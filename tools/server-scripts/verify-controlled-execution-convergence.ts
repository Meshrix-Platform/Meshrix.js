#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createReleaseCandidateIdentity } from "./verify-release-candidate-identity.ts";
import { createSourceEvidenceContext } from "./lib/source-tree-digest.ts";
import {
  CONTROLLED_EXECUTION_LEAF_SPECS,
  reduceControlledExecutionConvergence
} from "./lib/controlled-execution-convergence-reducer.ts";
import { writePrivateFileAtomic } from "../../packages/foundation/src/storage/private-file-atomic.ts";

const REPO_ROOT: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REPORT_PATH: any = "build/reports/controlled-execution-convergence-final.json";
const VERIFIER: any = "tools/server-scripts/verify-controlled-execution-convergence.ts";
async function readJson(filePath?: any) : Promise<any> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export async function verifyControlledExecutionConvergence({ repoRoot = REPO_ROOT, writeReport = true }: Record<string, any> = {}) : Promise<any> {
  const sourceContext: any = createSourceEvidenceContext(repoRoot, { verifier: VERIFIER, commandId: "controlled-execution-convergence-final" });
  const [candidate, leafEntries] = await Promise.all([
    createReleaseCandidateIdentity({ repoRoot }),
    Promise.all(CONTROLLED_EXECUTION_LEAF_SPECS.map(async (spec?: any) : Promise<any> => [
      spec.key,
      await readJson(path.join(repoRoot, spec.path))
    ]))
  ]);
  const report: any = reduceControlledExecutionConvergence({
    generatedAt: new Date().toISOString(),
    sourceContext,
    candidate,
    leafReports: Object.fromEntries(leafEntries),
  });
  if (writeReport) {
    await writePrivateFileAtomic(path.join(repoRoot, REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

const invokedDirectly: any = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  verifyControlledExecutionConvergence().then((report?: any) : any => {
    process.stdout.write(`[controlled-execution-convergence] ready=${report.summary.controlledExecutionConvergenceReady}\n`);
  }).catch((error?: any) : any => {
    process.stderr.write(`[controlled-execution-convergence] failed=${String(error?.message || error)}\n`);
    process.exitCode = 1;
  });
}
