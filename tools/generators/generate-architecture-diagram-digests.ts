#!/usr/bin/env node
/**
 * Stamp architecture diagram HTML with the architecture-facts digest.
 * Diagrams remain projection-only; packages/contracts/src/modules/manifest.ts is authority.
 *
 * Usage:
 *   node tools/generators/generate-architecture-diagram-digests.ts
 *   node tools/generators/generate-architecture-diagram-digests.ts --check
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MESHRIX_ARCHITECTURE_FACTS,
  listArchitectureNodeFacts
} from "../../packages/contracts/src/modules/manifest.ts";

const __dirname: any = path.dirname(fileURLToPath(import.meta.url));
const ROOT: any = path.resolve(__dirname, "../..");
const DIGEST_MARKER_RE: any =
  /<!-- architecture-facts-digest: (sha256:[a-f0-9]{64}) -->/u;
const AUTHORITY_LINE_RE: any =
  /Authority:\s*packages\/contracts\/src\/modules\/manifest\.ts\.[^<]*/u;

function toPosix(filePath?: any) : any {
  return path.relative(ROOT, filePath).split(path.sep).join("/");
}

export function computeArchitectureFactsDigest() : any {
  const payload: Record<string, any> = {
    protocolVersion: MESHRIX_ARCHITECTURE_FACTS.protocolVersion,
    authority: MESHRIX_ARCHITECTURE_FACTS.authority,
    sourceDiagrams: [...MESHRIX_ARCHITECTURE_FACTS.sourceDiagrams],
    nodeIds: listArchitectureNodeFacts().map((node?: any) : any => node.moduleId).sort(),
    serviceFieldIds: MESHRIX_ARCHITECTURE_FACTS.serviceCapabilityProtocolFields
      .map((field?: any) : any => field.fieldId)
      .sort()
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

function stampHtml(content?: any, digest?: any) : any {
  const authorityLine: any =
    `Authority: packages/contracts/src/modules/manifest.ts. Projection-only diagram; digest ${digest}.`;
  let next: any = content;
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

  const marker: any = `<!-- architecture-facts-digest: ${digest} -->`;
  if (DIGEST_MARKER_RE.test(next)) {
    next = next.replace(DIGEST_MARKER_RE, marker);
  } else if (next.includes("</head>")) {
    next = next.replace("</head>", `${marker}\n</head>`);
  } else {
    next = `${marker}\n${next}`;
  }
  return next;
}

function main() : any {
  const check: any = process.argv.includes("--check");
  const digest: any = computeArchitectureFactsDigest();
  const diagrams: any = MESHRIX_ARCHITECTURE_FACTS.sourceDiagrams.map((relativePath?: any) : any =>
    path.resolve(ROOT, relativePath)
  );

  let failed: any = 0;
  for (const filePath of diagrams) {
    const current: any = fs.readFileSync(filePath, "utf8");
    const expected: any = stampHtml(current, digest);
    if (check) {
      const marker: any = current.match(DIGEST_MARKER_RE)?.[1];
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
    console.error("Run: node tools/generators/generate-architecture-diagram-digests.ts");
    process.exitCode = 1;
  } else if (!check) {
    console.log(`architecture-facts-digest=${digest}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
