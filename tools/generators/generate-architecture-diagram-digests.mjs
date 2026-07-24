#!/usr/bin/env node
/**
 * Stamp architecture diagram HTML with the architecture-facts digest.
 * Diagrams remain projection-only; packages/contracts/src/modules/manifest.mjs is authority.
 *
 * Usage:
 *   node tools/generators/generate-architecture-diagram-digests.mjs
 *   node tools/generators/generate-architecture-diagram-digests.mjs --check
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MESHRIX_ARCHITECTURE_FACTS,
  listArchitectureNodeFacts
} from "../../packages/contracts/src/modules/manifest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const DIGEST_MARKER_RE =
  /<!-- architecture-facts-digest: (sha256:[a-f0-9]{64}) -->/u;
const AUTHORITY_LINE_RE =
  /Authority:\s*packages\/contracts\/src\/modules\/manifest\.mjs\.[^<]*/u;

function toPosix(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join("/");
}

export function computeArchitectureFactsDigest() {
  const payload = {
    protocolVersion: MESHRIX_ARCHITECTURE_FACTS.protocolVersion,
    authority: MESHRIX_ARCHITECTURE_FACTS.authority,
    sourceDiagrams: [...MESHRIX_ARCHITECTURE_FACTS.sourceDiagrams],
    nodeIds: listArchitectureNodeFacts().map((node) => node.moduleId).sort(),
    serviceFieldIds: MESHRIX_ARCHITECTURE_FACTS.serviceCapabilityProtocolFields
      .map((field) => field.fieldId)
      .sort()
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

function stampHtml(content, digest) {
  const authorityLine =
    `Authority: packages/contracts/src/modules/manifest.mjs. Projection-only diagram; digest ${digest}.`;
  let next = content;
  if (AUTHORITY_LINE_RE.test(next)) {
    next = next.replace(AUTHORITY_LINE_RE, authorityLine);
  } else if (next.includes("<h1>")) {
    next = next.replace(
      /(<h1>[\s\S]*?<\/h1>)/u,
      `$1\n<p>${authorityLine}</p>`
    );
  } else {
    throw new Error("architecture HTML is missing an authority insertion point");
  }

  const marker = `<!-- architecture-facts-digest: ${digest} -->`;
  if (DIGEST_MARKER_RE.test(next)) {
    next = next.replace(DIGEST_MARKER_RE, marker);
  } else if (next.includes("</head>")) {
    next = next.replace("</head>", `${marker}\n</head>`);
  } else {
    next = `${marker}\n${next}`;
  }
  return next;
}

function main() {
  const check = process.argv.includes("--check");
  const digest = computeArchitectureFactsDigest();
  const diagrams = MESHRIX_ARCHITECTURE_FACTS.sourceDiagrams.map((relativePath) =>
    path.resolve(ROOT, relativePath)
  );

  let failed = 0;
  for (const filePath of diagrams) {
    const current = fs.readFileSync(filePath, "utf8");
    const expected = stampHtml(current, digest);
    if (check) {
      const marker = current.match(DIGEST_MARKER_RE)?.[1];
      if (marker !== digest) {
        console.error(`STALE digest: ${toPosix(filePath)} expected ${digest} got ${marker || "(missing)"}`);
        failed += 1;
      } else if (current !== expected) {
        console.error(`STALE projection text: ${toPosix(filePath)}`);
        failed += 1;
      } else {
        console.log(`OK: ${toPosix(filePath)} (${digest})`);
      }
    } else {
      fs.writeFileSync(filePath, expected, "utf8");
      console.log(`Generated digest stamp: ${toPosix(filePath)} (${digest})`);
    }
  }

  if (check && failed > 0) {
    console.error("Run: node tools/generators/generate-architecture-diagram-digests.mjs");
    process.exitCode = 1;
  } else if (!check) {
    console.log(`architecture-facts-digest=${digest}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
