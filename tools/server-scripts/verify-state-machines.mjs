import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from "node:url";
import { verifyMachineDefinition } from '../../packages/foundation/src/workflow/state-machine/verification/state-machine-verifier.mjs';
import { computeStateMachineDefinitionHash } from '../../packages/foundation/src/workflow/state-machine/engine/state-machine-core.mjs';
import { assertNoLeak } from './lib/report-evidence-safety.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");
const DEFAULT_DEFINITIONS_DIR = path.join(ROOT, "packages/foundation/src/workflow/state-machine/definitions");
const DEFAULT_INTEGRITY_REGISTRY_PATH = path.join(ROOT, "tools/registry/state-machines/state-machine-integrity.registry.json");
const REPORT_SCHEMA_VERSION = "v0.0.1:state-machine:verification-report-1";
const REPORT_VERIFIER = "tools/server-scripts/verify-state-machines.mjs";

function toPosixRelative(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join("/");
}

function loadIntegrityRegistry(registryPath) {
  if (!fs.existsSync(registryPath)) {
    throw new Error(`State machine integrity registry is missing: ${toPosixRelative(registryPath)}`);
  }
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  if (!Array.isArray(registry.machines)) {
    throw new Error("State machine integrity registry is invalid: machines must be an array");
  }
  if (!Number.isInteger(registry.definitionCount) || registry.definitionCount !== registry.machines.length) {
    throw new Error("State machine integrity registry is invalid: definitionCount must equal machines.length");
  }
  if (registry.definitionCount < 1) {
    throw new Error("State machine integrity registry is invalid: at least one machine is required");
  }
  const machineIds = registry.machines.map((entry) => String(entry?.machineId || "").trim());
  if (machineIds.some((machineId) => !machineId) || new Set(machineIds).size !== machineIds.length) {
    throw new Error("State machine integrity registry is invalid: machineId values must be non-empty and unique");
  }
  return {
    registry,
    index: new Map(registry.machines.map((entry) => [entry.machineId, entry]))
  };
}

function listDefinitionFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return listDefinitionFiles(fullPath);
      }
      return entry.isFile() && entry.name.endsWith(".json") ? [fullPath] : [];
    })
    .sort((left, right) => toPosixRelative(left).localeCompare(toPosixRelative(right)));
}

function appendIntegrityChecks(result, definition, filePath, integrityIndex) {
  const machineId = definition.machineId || "";
  const expected = integrityIndex.get(machineId);
  const actualHash = computeStateMachineDefinitionHash(definition);
  result.definitionHash = actualHash;
  const addFailed = (id, error) => {
    result.ok = false;
    result.checks = Array.isArray(result.checks) ? result.checks : [];
    result.checks.push({ id, status: "failed", error });
  };
  const addPassed = (id) => {
    result.checks = Array.isArray(result.checks) ? result.checks : [];
    result.checks.push({ id, status: "passed" });
  };
  if (!expected) {
    addFailed("C3-integrity-registry-entry", `Missing integrity registry entry for ${machineId}`);
    return;
  }
  addPassed("C3-integrity-registry-entry");
  if (expected.canonicalSha256 !== actualHash) {
    addFailed("C3-integrity-canonical-sha256", `Expected ${expected.canonicalSha256}, got ${actualHash}`);
  } else {
    addPassed("C3-integrity-canonical-sha256");
  }
  const relativePath = toPosixRelative(filePath);
  if (expected.path !== relativePath) {
    addFailed("C3-integrity-definition-path", `Expected ${expected.path}, got ${relativePath}`);
  } else {
    addPassed("C3-integrity-definition-path");
  }
  if (expected.version !== (definition.version || "")) {
    addFailed("C3-integrity-version", `Expected ${expected.version}, got ${definition.version || ""}`);
  } else {
    addPassed("C3-integrity-version");
  }
  const counts = {
    stateCount: (definition.states || []).length,
    eventCount: (definition.events || []).length,
    matrixCellCount: (definition.totalMatrix || []).length
  };
  for (const [key, actual] of Object.entries(counts)) {
    if (expected[key] !== actual) {
      addFailed(`C3-integrity-${key}`, `Expected ${expected[key]}, got ${actual}`);
    } else {
      addPassed(`C3-integrity-${key}`);
    }
  }
}

export function runVerifier(definitionsDir, reportsDir, {
  integrityRegistryPath = DEFAULT_INTEGRITY_REGISTRY_PATH,
  assertNoSensitiveLeak = assertNoLeak
} = {}) {
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }
  const checkedAt = new Date().toISOString();
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    verifier: REPORT_VERIFIER,
    ok: true,
    releaseReady: true,
    coverageReady: true,
    checkedAt,
    generatedAt: checkedAt,
    machines: []
  };
  const files = listDefinitionFiles(definitionsDir);
  const integrity = loadIntegrityRegistry(integrityRegistryPath);
  const seenMachineIds = new Set();

  for (const filePath of files) {
    const relativePath = toPosixRelative(filePath);
    try {
      const def = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const res = verifyMachineDefinition(def, { throwOnError: false, relativePath });
      seenMachineIds.add(def.machineId);
      appendIntegrityChecks(res, def, filePath, integrity.index);
      report.machines.push(res);
      if (!res.ok) report.ok = false;
    } catch (err) {
      report.ok = false;
      report.machines.push({ machineId: relativePath, ok: false, error: err.message, completenessLevel: "FAIL" });
    }
  }
  for (const machine of integrity.registry.machines) {
    if (!seenMachineIds.has(machine.machineId)) {
      report.ok = false;
      report.machines.push({
        machineId: machine.machineId,
        ok: false,
        completenessLevel: "FAIL",
        checks: [{
          id: "C3-integrity-definition-present",
          status: "failed",
          error: `Integrity registry entry has no definition file: ${machine.machineId}`
        }]
      });
    }
  }
  const failedCount = report.machines.filter((machine) => machine.ok !== true).length;
  report.releaseReady = report.ok === true;
  report.coverageReady = report.ok === true;
  report.summary = {
    releaseReady: report.releaseReady,
    coverageReady: report.coverageReady,
    reportLeakScan: false,
    machineCount: report.machines.length,
    failedCount
  };
  assertNoSensitiveLeak(report, "state machine verification report");
  report.summary.reportLeakScan = true;
  assertNoSensitiveLeak(report, "state machine verification report");
  fs.writeFileSync(path.join(reportsDir, 'latest.json'), JSON.stringify(report, null, 2));

  let mdContent = `# State Machine Verification Report\n\nChecked At: ${report.checkedAt}\nStatus: ${report.ok ? '✅ PASS' : '❌ FAIL'}\n\n## Machines\n\n`;
  for (const machine of report.machines) {
    mdContent += `### ${machine.machineId}\n`;
    mdContent += `- OK: ${machine.ok}\n`;
    mdContent += `- Completeness: ${machine.completenessLevel || "FAIL"}\n`;
    if (!machine.ok) {
      mdContent += `- **Errors**:\n`;
      if (machine.checks) {
        for (const check of machine.checks.filter(c => c.status !== 'passed')) {
          mdContent += `  - [${check.id}] ${check.error}\n`;
        }
      } else {
        mdContent += `  - ${machine.error}\n`;
      }
    }
    mdContent += `\n`;
  }
  fs.writeFileSync(path.join(reportsDir, 'latest.md'), mdContent);
  return report;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const defs = DEFAULT_DEFINITIONS_DIR;
  const reps = path.join(process.cwd(), "build/reports/state-machines");
  const r = runVerifier(defs, reps);
  if (!r.ok) {
    console.error("Verification FAILED");
    process.exit(1);
  }
  console.log("Verification PASSED");
}
