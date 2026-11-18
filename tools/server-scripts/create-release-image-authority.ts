#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ReleaseImageEvidenceError,
  buildReleaseImageAuthority,
  buildReleaseImageState
} from "./lib/release-image-evidence.ts";

function argumentValue(argv?: any, index?: any, option?: any) : any {
  const value: any = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`argument_missing:${option}`);
  return value;
}

export function parseReleaseImageAuthorityArguments(argv?: any) : any {
  const options: Record<string, any> = {};
  const allowed: any = new Set<any>([
    "image",
    "digest",
    "target",
    "candidate",
    "reused",
    "repository",
    "sourceRef",
    "sourceCommit",
    "sourceCandidate",
    "workflowRef",
    "manifestDescriptor",
    "manifest",
    "provenance",
    "sbom",
    "authorityOutput",
    "stateOutput"
  ]);
  const seen: any = new Set<any>();
  for (let index: any = 0; index < argv.length; index += 1) {
    const option: any = argv[index];
    if (!option.startsWith("--")) throw new Error("release_image_argument_invalid");
    const key: any = option.slice(2).replace(/-([a-z])/gu, (_?: any, letter?: any) : any => letter.toUpperCase());
    if (!allowed.has(key) || seen.has(key)) throw new Error("release_image_argument_invalid");
    seen.add(key);
    if (key === "reused") {
      const value: any = argumentValue(argv, index, option);
      if (!new Set<any>(["true", "false"]).has(value)) throw new Error("release_image_reuse_state_invalid");
      options.reused = value === "true";
      index += 1;
      continue;
    }
    options[key] = argumentValue(argv, index, option);
    index += 1;
  }
  const required: any[] = [
    "image",
    "digest",
    "target",
    "candidate",
    "repository",
    "sourceRef",
    "sourceCommit",
    "sourceCandidate",
    "workflowRef",
    "manifestDescriptor",
    "manifest",
    "provenance",
    "sbom",
    "authorityOutput",
    "stateOutput"
  ];
  if (options.reused === undefined || required.some((key?: any) : any => !options[key])) {
    throw new Error("release_image_argument_missing");
  }
  return options;
}

async function readSourceCandidate(sourceCandidatePath?: any) : Promise<any> {
  try {
    return JSON.parse(await fs.readFile(sourceCandidatePath, "utf8"));
  } catch {
    throw new ReleaseImageEvidenceError(
      "release_image_source_candidate_invalid",
      "The release image source candidate could not be read or parsed."
    );
  }
}

async function readEvidence(options?: any) : Promise<any> {
  const [
    sourceCandidate,
    manifestDescriptorText,
    manifestText,
    provenanceText,
    sbomText
  ] = await Promise.all([
    readSourceCandidate(options.sourceCandidate),
    fs.readFile(options.manifestDescriptor, "utf8"),
    fs.readFile(options.manifest, "utf8"),
    fs.readFile(options.provenance, "utf8"),
    fs.readFile(options.sbom, "utf8")
  ]);
  return {
    sourceCandidate,
    manifestDescriptorText,
    manifestText,
    provenanceText,
    sbomText
  };
}

export async function createReleaseImageAuthority(options?: any) : Promise<any> {
  const evidence: any = await readEvidence(options);
  const authority: any = buildReleaseImageAuthority({ ...options, ...evidence });
  const authorityText: any = `${JSON.stringify(authority, null, 2)}\n`;
  const state: any = buildReleaseImageState({
    authorityText,
    target: options.target,
    candidate: options.candidate,
    reused: options.reused
  });
  await Promise.all([
    fs.mkdir(path.dirname(options.authorityOutput), { recursive: true }),
    fs.mkdir(path.dirname(options.stateOutput), { recursive: true })
  ]);
  await fs.writeFile(options.authorityOutput, authorityText, { encoding: "utf8", flag: "wx" });
  await fs.writeFile(
    options.stateOutput,
    `${JSON.stringify(state, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" }
  );
  return { authority, state };
}

async function main() : Promise<any> {
  const options: any = parseReleaseImageAuthorityArguments(process.argv.slice(2));
  const result: any = await createReleaseImageAuthority(options);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    image: result.authority.image,
    digest: result.authority.digest,
    platforms: result.authority.platforms
  })}\n`);
}

const isMain: any = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error?: any) : any => {
    const code: any = error instanceof ReleaseImageEvidenceError
      ? error.code
      : String(error?.code || error?.message || "release_image_authority_failed");
    process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
    process.exitCode = 1;
  });
}
