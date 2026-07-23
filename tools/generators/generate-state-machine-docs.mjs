#!/usr/bin/env node
/**
 * Generate projection-only state-machine documentation from trusted definitions.
 *
 * Usage:
 *   node tools/generators/generate-state-machine-docs.mjs
 *   node tools/generators/generate-state-machine-docs.mjs --check
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const INTEGRITY_REGISTRY = path.resolve(
  ROOT,
  "tools/registry/state-machines/state-machine-integrity.registry.json"
);
const STATE_MACHINES_DOC = path.resolve(ROOT, "docs/state-machine/STATE-MACHINES.md");
const DEFINITIONS_README = path.resolve(
  ROOT,
  "packages/foundation/src/workflow/state-machine/definitions/README.md"
);
const GENERATED_AT = "1970-01-01T00:00:00.000Z";
const DOC_SCHEMA = "v0.0.1:docs:state-machines-projection-1";

function toPosix(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join("/");
}

function sha256Text(text) {
  return `sha256:${createHash("sha256").update(String(text)).digest("hex")}`;
}

function loadIntegrityRegistry() {
  return JSON.parse(fs.readFileSync(INTEGRITY_REGISTRY, "utf8"));
}

function renderMachineTable(machines, title) {
  const rows = machines
    .map((machine) => `| \`${machine.machineId}\` | \`${machine.canonicalSha256}\` | ${machine.stateCount}/${machine.eventCount}/${machine.matrixCellCount} | \`${machine.path}\` |`)
    .join("\n");
  return [
    `## ${title}`,
    "",
    "| Machine | Definition digest | States/Events/Cells | Authority path |",
    "| --- | --- | --- | --- |",
    rows,
    ""
  ].join("\n");
}

function renderDefinitionsReadme(registry) {
  const lines = registry.machines.map((machine) =>
    `- \`${path.basename(machine.path)}\`: \`${machine.machineId}\` @ \`${machine.canonicalSha256}\`.`
  );
  return [
    "# State Machine Definitions",
    "",
    "<!-- GENERATED: tools/generators/generate-state-machine-docs.mjs — DO NOT EDIT BY HAND -->",
    "",
    "This directory holds machine-readable state-machine definition JSON. Documentation under `docs/state-machine/` is projection-only and cannot redefine these digests.",
    "",
    `Integrity registry: \`tools/registry/state-machines/state-machine-integrity.registry.json\` (${registry.version}).`,
    "",
    "## Files",
    "",
    ...lines,
    "",
    "## Design rules",
    "",
    "1. **Matrix totality** — every `State × Event` cell must exist in `totalMatrix`.",
    "2. **Stateless core** — definitions encode pure transitions; persistence belongs to runtime services.",
    "3. **Secret redaction** — definitions must not contain secrets or absolute host paths.",
    "",
    "Regenerate projections with:",
    "",
    "```bash",
    "node tools/generators/generate-state-machine-integrity-registry.mjs",
    "node tools/generators/generate-state-machine-docs.mjs",
    "```",
    ""
  ].join("\n");
}

function buildStateMachinesDoc(registry) {
  const coreMachines = registry.machines.filter((machine) => !machine.machineId.startsWith("acceptance."));
  const acceptanceMachines = registry.machines.filter((machine) => machine.machineId.startsWith("acceptance."));
  const registryDigest = sha256Text(JSON.stringify(registry.machines.map((machine) => ({
    machineId: machine.machineId,
    canonicalSha256: machine.canonicalSha256,
    path: machine.path
  }))));

  return [
    "# State Machines",
    "",
    "<!-- GENERATED: tools/generators/generate-state-machine-docs.mjs — DO NOT EDIT BY HAND -->",
    "",
    `Projection schema: \`${DOC_SCHEMA}\``,
    `Generated at: \`${GENERATED_AT}\``,
    `Integrity registry digest: \`${registryDigest}\``,
    "Authority: JSON definitions under `packages/foundation/src/workflow/state-machine/definitions/`. This markdown file is projection-only and must not be treated as an independent authority.",
    "",
    "Core state-machine definitions live under `packages/foundation/src/workflow/state-machine/definitions/`. Package-owned definitions are admitted from verified plugin bundles and are not compiled into Core documentation.",
    "",
    renderMachineTable(coreMachines, "Core And Plugin-Registered Machines"),
    "## Normative Proof Machines",
    "",
    "| Machine | Purpose |",
    "| --- | --- |",
    "",
    "## Capability Acceptance Evidence",
    "",
    "Generated `acceptance.<capability-id>` machines model repository-local evidence only. Their terminal state is `verified`, which means the capability checkpoint graph is eligible as an input to the platform acceptance reducer. These machines cannot declare a capability or release accepted.",
    "",
    "Completed implementation and final-validation criteria must cite reproducible commands. A capability or platform aggregate reducer cannot be used as evidence for its own input checkpoint. Objective evidence that must be produced by an external client, supported operating system, independent audit, or deployment environment is recorded as a structured `external-evidence` blocker with the required receipt and its verification command.",
    "",
    "Run the capability evidence verifier directly with:",
    "",
    "```bash",
    "npm run verify:capability-acceptance-machines",
    "```",
    "",
    "Only `npm run verify:acceptance` may reduce capability evidence and the other required reports into project-level release readiness.",
    "",
    renderMachineTable(acceptanceMachines, "Acceptance Machines"),
    "Run:",
    "",
    "```bash",
    "node tools/generators/generate-state-machine-integrity-registry.mjs",
    "node tools/generators/generate-state-machine-docs.mjs",
    "npm run server:verify:state-machines",
    "npm run verify:capability-acceptance-machines",
    "```",
    ""
  ].join("\n");
}

async function main() {
  const check = process.argv.includes("--check");
  const registry = loadIntegrityRegistry();
  const stateMachinesDoc = buildStateMachinesDoc(registry);
  const definitionsReadme = renderDefinitionsReadme(registry);
  const outputs = [
    [STATE_MACHINES_DOC, stateMachinesDoc],
    [DEFINITIONS_README, definitionsReadme]
  ];

  let failed = 0;
  for (const [filePath, expected] of outputs) {
    if (check) {
      if (!fs.existsSync(filePath)) {
        console.error(`MISSING: ${toPosix(filePath)}`);
        failed += 1;
      } else if (fs.readFileSync(filePath, "utf8") !== expected) {
        console.error(`STALE: ${toPosix(filePath)}`);
        failed += 1;
      } else {
        console.log(`OK: ${toPosix(filePath)}`);
      }
    } else {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, expected, "utf8");
      console.log(`Generated: ${toPosix(filePath)}`);
    }
  }

  if (check && failed > 0) {
    console.error("Run: node tools/generators/generate-state-machine-docs.mjs");
    process.exitCode = 1;
  }
}

await main();
