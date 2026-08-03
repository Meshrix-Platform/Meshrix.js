#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  UPSTREAM_SERVICE_PUBLISHING_CANDIDATE_ARTIFACT_PATHS,
  UPSTREAM_SERVICE_PUBLISHING_CANDIDATE_REPORT_PATH,
  candidateSourceLookupFailure,
  createUpstreamServicePublishingCandidateReceipt
} from "./lib/upstream-service-publishing-candidate-receipt.ts";
import { currentSourceTreeDigest } from "./lib/source-tree-digest.ts";

const execFileAsync: any = promisify(execFile);
const ROOT: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const RELEASE_DEFINITION_PATH: any =
  "tools/registry/release-definition.registry.json";
const CORE_REPORT_PATH: any =
  "build/reports/upstream-service-publishing.json";

async function gitValue(args?: any) : Promise<any> {
  try {
    const result: any = await execFileAsync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    });
    return result.stdout.trim();
  } catch {
    throw candidateSourceLookupFailure(args);
  }
}

async function main() : Promise<any> {
  const releaseDefinitionText: any = await fs.readFile(
    path.join(ROOT, RELEASE_DEFINITION_PATH),
    "utf8"
  );
  const releaseDefinition: any = JSON.parse(releaseDefinitionText);
  const expectedTag: any = String(
    process.env.GITHUB_REF_NAME || releaseDefinition?.release?.tag || ""
  );
  const coreSourceRevision: any = currentSourceTreeDigest(ROOT, {
    exclude: [CORE_REPORT_PATH]
  });
  const [commit, tree, tagCommit, status, artifactEntries] = await Promise.all([
    gitValue(["rev-parse", "HEAD"]),
    gitValue(["rev-parse", "HEAD^{tree}"]),
    gitValue(["rev-parse", `refs/tags/${expectedTag}^{commit}`]),
    gitValue(["status", "--porcelain=v1", "--untracked-files=all"]),
    Promise.all(
      UPSTREAM_SERVICE_PUBLISHING_CANDIDATE_ARTIFACT_PATHS.map(
        async (artifactPath?: any) : Promise<any> => [
          artifactPath,
          await fs.readFile(path.join(ROOT, artifactPath))
        ]
      )
    )
  ]);
  const receipt: any = createUpstreamServicePublishingCandidateReceipt({
    releaseDefinitionText,
    expectedTag,
    source: {
      commit,
      tree,
      tagCommit,
      coreSourceRevision,
      worktreeClean: status.length === 0
    },
    artifacts: new Map<any, any>(artifactEntries)
  });
  const outputPath: any = path.join(
    ROOT,
    UPSTREAM_SERVICE_PUBLISHING_CANDIDATE_REPORT_PATH
  );
  await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    outputPath,
    `${JSON.stringify(receipt, null, 2)}\n`,
    { mode: 0o600 }
  );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    claim: receipt.claim,
    report: UPSTREAM_SERVICE_PUBLISHING_CANDIDATE_REPORT_PATH,
    artifactCount: receipt.artifacts.length
  })}\n`);
}

main().catch((error?: any) : any => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code: String(
      error?.code || "upstream_service_publishing_candidate_verification_failed"
    )
  })}\n`);
  process.exitCode = 1;
});
