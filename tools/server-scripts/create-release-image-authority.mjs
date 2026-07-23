#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ReleaseImageEvidenceError,
  buildReleaseImageAuthority,
  buildReleaseImageState
} from "./lib/release-image-evidence.mjs";

function argumentValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`argument_missing:${option}`);
  return value;
}

export function parseReleaseImageAuthorityArguments(argv) {
  const options = {};
  const allowed = new Set([
    "image",
    "digest",
    "target",
    "candidate",
    "reused",
    "repository",
    "sourceRef",
    "sourceCommit",
    "workflowRef",
    "manifestDescriptor",
    "manifest",
    "provenance",
    "sbom",
    "authorityOutput",
    "stateOutput"
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!option.startsWith("--")) throw new Error("release_image_argument_invalid");
    const key = option.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    if (!allowed.has(key) || seen.has(key)) throw new Error("release_image_argument_invalid");
    seen.add(key);
    if (key === "reused") {
      const value = argumentValue(argv, index, option);
      if (!new Set(["true", "false"]).has(value)) throw new Error("release_image_reuse_state_invalid");
      options.reused = value === "true";
      index += 1;
      continue;
    }
    options[key] = argumentValue(argv, index, option);
    index += 1;
  }
  const required = [
    "image",
    "digest",
    "target",
    "candidate",
    "repository",
    "sourceRef",
    "sourceCommit",
    "workflowRef",
    "manifestDescriptor",
    "manifest",
    "provenance",
    "sbom",
    "authorityOutput",
    "stateOutput"
  ];
  if (options.reused === undefined || required.some((key) => !options[key])) {
    throw new Error("release_image_argument_missing");
  }
  return options;
}

async function readEvidence(options) {
  const [manifestDescriptorText, manifestText, provenanceText, sbomText] = await Promise.all([
    fs.readFile(options.manifestDescriptor, "utf8"),
    fs.readFile(options.manifest, "utf8"),
    fs.readFile(options.provenance, "utf8"),
    fs.readFile(options.sbom, "utf8")
  ]);
  return { manifestDescriptorText, manifestText, provenanceText, sbomText };
}

export async function createReleaseImageAuthority(options) {
  const evidence = await readEvidence(options);
  const authority = buildReleaseImageAuthority({ ...options, ...evidence });
  const authorityText = `${JSON.stringify(authority, null, 2)}\n`;
  const state = buildReleaseImageState({
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

async function main() {
  const options = parseReleaseImageAuthorityArguments(process.argv.slice(2));
  const result = await createReleaseImageAuthority(options);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    image: result.authority.image,
    digest: result.authority.digest,
    platforms: result.authority.platforms
  })}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    const code = error instanceof ReleaseImageEvidenceError
      ? error.code
      : String(error?.message || "release_image_authority_failed");
    process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
    process.exitCode = 1;
  });
}
