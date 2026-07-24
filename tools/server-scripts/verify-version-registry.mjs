#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectGovernedVersionOccurrences,
  GOVERNED_VERSION_PATTERN,
  VERSION_SCAN_ROOTS
} from "../../packages/foundation/src/version-control/version-scan.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const registryRelativePath = "packages/foundation/src/version-control/version-registry.json";
const schemaRelativePath = "packages/foundation/src/version-control/version-registry.schema.json";
const artifactLifecycleRelativePath = "packages/foundation/src/workflow/state-machine/definitions/version.artifact.lifecycle.json";
const transitionLifecycleRelativePath = "packages/foundation/src/workflow/state-machine/definitions/version.transition.lifecycle.json";
const reportRelativePath = "build/reports/version-registry/latest.json";

const ARTIFACT_ID_PATTERN = /^meshrix(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const VERSION_NAME_PATTERN = /^(?![a-z0-9-]*(?:legacy|compat|v[0-9]+))[a-z](?:[a-z0-9-]*[a-z0-9])?$/;
const VERSION_SUBSECTION_PATTERN = /^(?![a-z0-9-]*(?:legacy|compat|v[0-9]+))[a-z](?:[a-z0-9-]*[a-z0-9])?-[0-9]+(\.[0-9]+)*$/;
const ARTIFACT_REF_PATTERN = new RegExp(
  `^meshrix(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+@${GOVERNED_VERSION_PATTERN.source.slice(1, -1)}$`
);
const ABSOLUTE_PATH_PATTERNS = [
  /\/Users\//i,
  /\/home\//i,
  /^[a-zA-Z]:\\/
];
const SECRET_PATTERNS = [
  /api[_-]?key\s*[:=]/i,
  /secret\s*[:=]/i,
  /token\s*[:=]/i,
  /cookie\s*[:=]/i,
  /Bearer\s+[A-Za-z0-9._-]+/i,
  /-----BEGIN/i
];

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(repoRoot, relativePath), "utf8"));
}

function normalizePath(value) {
  return String(value || "").split(path.sep).join("/");
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function assertOnlyKeys(object, allowedKeys, label) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(object || {})) {
    assert.equal(allowed.has(key), true, `${label} contains unsupported key: ${key}`);
  }
}

function assertNoSensitiveStrings(value, pathLabel = "registry") {
  if (typeof value === "string") {
    for (const pattern of ABSOLUTE_PATH_PATTERNS) {
      assert.equal(pattern.test(value), false, `${pathLabel} contains local absolute path: ${value}`);
    }
    for (const pattern of SECRET_PATTERNS) {
      assert.equal(pattern.test(value), false, `${pathLabel} contains secret-like content: ${value}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveStrings(item, `${pathLabel}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      assertNoSensitiveStrings(child, `${pathLabel}.${key}`);
    }
  }
}

function assertRefShape(ref, label, platformVersionBaseline) {
  assert.match(ref, ARTIFACT_REF_PATTERN, `${label} must use artifactId@version`);
  assertGovernedVersion(ref.slice(ref.indexOf("@") + 1), `${label} version segment`, platformVersionBaseline);
}

function assertArtifactId(value, label) {
  assert.match(value, ARTIFACT_ID_PATTERN, `${label} must be a stable dotted meshrix.* identity`);
}

function assertGovernedVersion(value, label, platformVersionBaseline = "v0.0.1") {
  assert.match(
    value,
    GOVERNED_VERSION_PATTERN,
    `${label} must use Governed Version String: v<platform-version>:<domain>:<subsection>-<version>`
  );
  const parts = value.split(":");
  assert.equal(parts.length, 3, `${label} must contain exactly platform, domain, and subsection segments`);
  const [platformVersion, domain, subsection] = parts;
  assert.equal(platformVersion, platformVersionBaseline, `${label} must use platform version baseline ${platformVersionBaseline}`);
  assert.match(domain, VERSION_NAME_PATTERN, `${label} domain must be kebab-case`);
  assert.match(subsection, VERSION_SUBSECTION_PATTERN, `${label} subsection must end with a numeric version suffix`);
}

function expectedRef(artifactId, version) {
  return `${artifactId}@${version}`;
}

function isFixtureEvidenceUri(uri = "") {
  const normalized = normalizePath(uri);
  return normalized.startsWith("tests/") || /(?:^|[-/])fixture(?:[-./]|$)/u.test(normalized);
}

function isVerifierEntrypointUri(uri = "") {
  const normalized = normalizePath(uri);
  return /^tools\/(?:server-scripts\/verify-|verifiers\/)/u.test(normalized);
}

function verifierOwnedVersion(version = "") {
  const subsection = String(version || "").split(":").at(-1) || "";
  return /(?:report|audit|verification|readiness|conformance|evidence|proof|manifest|checkpoint|boundary|profile)(?:-|$)/u
    .test(subsection);
}

function assertActiveVersionAuthority(artifact, versionRecord) {
  assert.equal(
    artifact.artifactId.startsWith("meshrix.test."),
    false,
    `${artifact.artifactId} must not register test-fixture identity as a governed artifact`
  );
  assert.notEqual(
    String(versionRecord.version || "").split(":")[1],
    "test",
    `${artifact.artifactId} active version must use a runtime or schema domain`
  );
  const evidenceUris = versionRecord.evidenceRefs.map((ref) => normalizePath(ref.uri));
  const authorityUris = evidenceUris.filter((uri) => !isFixtureEvidenceUri(uri));
  assert.ok(
    authorityUris.length > 0,
    `${artifact.artifactId} active version requires a non-test, non-fixture authority source`
  );
  assert.equal(
    verifierOwnedVersion(versionRecord.version) || authorityUris.some((uri) => !isVerifierEntrypointUri(uri)),
    true,
    `${artifact.artifactId} non-report version requires runtime, schema, registry, or generator authority`
  );
}

async function assertReferenceExists(uri, label) {
  assert.equal(typeof uri, "string", `${label} uri must be a string`);
  assert.equal(uri.startsWith("/"), false, `${label} must not use an absolute path`);
  assert.equal(uri.includes(".."), false, `${label} must not escape its declared boundary`);
  if (!uri.startsWith(".meshrix-server-data/")) {
    await fs.access(path.join(repoRoot, uri));
  }
}

async function verifyEvidenceRefs(refs, label) {
  assert.ok(Array.isArray(refs), `${label} evidenceRefs must be an array`);
  const seen = new Set();
  for (const ref of refs) {
    assertOnlyKeys(ref, ["evidenceId", "kind", "uri", "digest"], `${label} evidenceRef`);
    assert.equal(typeof ref.evidenceId, "string", `${label} evidenceId must be a string`);
    assert.notEqual(ref.evidenceId.trim(), "", `${label} evidenceId must be non-empty`);
    assert.equal(seen.has(ref.evidenceId), false, `${label} duplicate evidenceId: ${ref.evidenceId}`);
    seen.add(ref.evidenceId);
    await assertReferenceExists(ref.uri, `${label} evidenceRef ${ref.evidenceId}`);
    if (ref.uri.startsWith(".meshrix-server-data/")) {
      assert.equal(
        ref.uri.startsWith(".meshrix-server-data/artifacts/"),
        true,
        `${label} runtime evidence must stay under .meshrix-server-data/artifacts`
      );
    }
  }
}

function verifyArtifactRefs(refs, label) {
  assert.ok(Array.isArray(refs), `${label} artifactRefs must be an array`);
  const seen = new Set();
  for (const ref of refs) {
    assertOnlyKeys(ref, ["refId", "kind", "uri", "digest"], `${label} artifactRef`);
    assert.equal(typeof ref.refId, "string", `${label} refId must be a string`);
    assert.notEqual(ref.refId.trim(), "", `${label} refId must be non-empty`);
    assert.equal(seen.has(ref.refId), false, `${label} duplicate refId: ${ref.refId}`);
    seen.add(ref.refId);
    assert.equal(
      ref.uri.startsWith(".meshrix-server-data/artifacts/"),
      true,
      `${label} artifact payload uri must stay under .meshrix-server-data/artifacts`
    );
    assert.equal(ref.uri.includes(".."), false, `${label} artifact payload uri must not escape artifact store`);
  }
}

async function verifyRegistry() {
  const [registry, schema, artifactLifecycleDef, transitionLifecycleDef] = await Promise.all([
    readJson(registryRelativePath),
    readJson(schemaRelativePath),
    readJson(artifactLifecycleRelativePath),
    readJson(transitionLifecycleRelativePath)
  ]);

  assertNoSensitiveStrings(registry);

  assert.equal(schema.$id, "https://meshrix.local/packages/foundation/src/version-control/version-registry.schema.json");
  assert.deepEqual(
    sorted(schema.$defs.artifactLifecycle.enum),
    sorted(artifactLifecycleDef.states.map((state) => state.id)),
    "Version Registry schema artifact lifecycle must match version.artifact.lifecycle"
  );
  assert.deepEqual(
    sorted(schema.$defs.transitionLifecycle.enum),
    sorted(transitionLifecycleDef.states.map((state) => state.id)),
    "Version Registry schema transition lifecycle must match version.transition.lifecycle"
  );

  assertOnlyKeys(
    registry,
    ["$schema", "schemaVersion", "registryId", "protocolVersion", "updatedAt", "authority", "artifacts", "compatibilityTable", "transitions", "assemblies"],
    "Version Registry"
  );
  assert.equal(registry.$schema, "./version-registry.schema.json");
  assert.equal(registry.schemaVersion, "v0.0.1:version-governance:registry-schema-1");
  assertGovernedVersion(registry.schemaVersion, "Version Registry schemaVersion");
  assert.equal(registry.registryId, "meshrix.version-registry");
  assert.equal(registry.protocolVersion, "v0.0.1:version-governance:protocol-1");
  assertGovernedVersion(registry.protocolVersion, "Version Registry protocolVersion");
  assert.match(registry.updatedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(registry.authority, {
    mode: "source-controlled-singleton",
    artifactStoreRoot: ".meshrix-server-data/artifacts",
    platformVersionBaseline: "v0.0.1",
    governedVersionFormat: "v<platform-version>:<domain>:<subsection>-<version>"
  });
  const platformVersionBaseline = registry.authority.platformVersionBaseline;

  const artifactIds = new Set();
  const artifactRefs = new Set();
  const activeRefs = new Map();
  const activeVersionEvidence = new Map();

  assert.ok(Array.isArray(registry.artifacts) && registry.artifacts.length > 0, "Version Registry must contain artifacts");
  for (const artifact of registry.artifacts) {
    assertOnlyKeys(artifact, ["artifactId", "kind", "description", "activeVersion", "versions"], "artifact");
    assertArtifactId(artifact.artifactId, `artifact ${artifact.artifactId}`);
    assertGovernedVersion(artifact.activeVersion, `${artifact.artifactId} activeVersion`, platformVersionBaseline);
    assert.equal(artifactIds.has(artifact.artifactId), false, `duplicate artifactId: ${artifact.artifactId}`);
    artifactIds.add(artifact.artifactId);
    assert.ok(Array.isArray(artifact.versions) && artifact.versions.length > 0, `${artifact.artifactId} must contain versions`);

    const versions = new Set();
    const activeVersions = [];
    for (const versionRecord of artifact.versions) {
      assertOnlyKeys(versionRecord, ["version", "ref", "lifecycle", "compatibility", "artifactRefs", "evidenceRefs"], `${artifact.artifactId} version`);
      assert.equal(typeof versionRecord.version, "string", `${artifact.artifactId} version must be a string`);
      assert.notEqual(versionRecord.version.trim(), "", `${artifact.artifactId} version must be non-empty`);
      assertGovernedVersion(versionRecord.version, `${artifact.artifactId} version`, platformVersionBaseline);
      assert.equal(versions.has(versionRecord.version), false, `${artifact.artifactId} duplicate version: ${versionRecord.version}`);
      versions.add(versionRecord.version);
      assert.equal(versionRecord.ref, expectedRef(artifact.artifactId, versionRecord.version), `${artifact.artifactId} ref mismatch`);
      assertRefShape(versionRecord.ref, `${artifact.artifactId} version ref`, platformVersionBaseline);
      assert.equal(artifactRefs.has(versionRecord.ref), false, `duplicate artifact ref: ${versionRecord.ref}`);
      artifactRefs.add(versionRecord.ref);
      if (versionRecord.lifecycle === "active") {
        activeVersions.push(versionRecord.version);
        activeRefs.set(artifact.artifactId, versionRecord.ref);
        activeVersionEvidence.set(
          versionRecord.version,
          new Set(versionRecord.evidenceRefs.map((evidenceRef) => normalizePath(evidenceRef.uri)))
        );
        assert.equal(versionRecord.compatibility.newBindingsAllowed, true, `${versionRecord.ref} active versions must allow new bindings`);
        assertActiveVersionAuthority(artifact, versionRecord);
      }
      if (versionRecord.lifecycle === "deprecated" || versionRecord.lifecycle === "retired") {
        assert.equal(versionRecord.compatibility.newBindingsAllowed, false, `${versionRecord.ref} cannot accept new bindings`);
      }
      await verifyEvidenceRefs(versionRecord.evidenceRefs, versionRecord.ref);
      verifyArtifactRefs(versionRecord.artifactRefs, versionRecord.ref);
    }

    assert.equal(versions.has(artifact.activeVersion), true, `${artifact.artifactId} activeVersion must reference a known version`);
    assert.deepEqual(activeVersions, [artifact.activeVersion], `${artifact.artifactId} must have exactly one active version matching activeVersion`);
  }

  const compatibilityIds = new Set();
  assert.ok(Array.isArray(registry.compatibilityTable), "compatibilityTable must be an array");
  for (const row of registry.compatibilityTable) {
    assertOnlyKeys(
      row,
      ["compatibilityId", "consumerRef", "providerRef", "status", "newBindingsAllowed", "historicalResolutionAllowed", "reason", "evidenceRefs"],
      "compatibilityTable row"
    );
    assert.equal(typeof row.compatibilityId, "string", "compatibilityId must be a string");
    assert.notEqual(row.compatibilityId.trim(), "", "compatibilityId must be non-empty");
    assert.equal(compatibilityIds.has(row.compatibilityId), false, `duplicate compatibilityId: ${row.compatibilityId}`);
    compatibilityIds.add(row.compatibilityId);
    assert.equal(artifactRefs.has(row.consumerRef), true, `${row.compatibilityId} consumerRef must resolve: ${row.consumerRef}`);
    assert.equal(artifactRefs.has(row.providerRef), true, `${row.compatibilityId} providerRef must resolve: ${row.providerRef}`);
    if (row.status === "compatible") {
      assert.equal(row.newBindingsAllowed, true, `${row.compatibilityId} compatible rows must allow new bindings`);
      assert.equal(row.historicalResolutionAllowed, true, `${row.compatibilityId} compatible rows must allow historical resolution`);
    }
    if (row.status === "deprecated" || row.status === "historical_only" || row.status === "blocked") {
      assert.equal(row.newBindingsAllowed, false, `${row.compatibilityId} non-compatible rows must not allow new bindings`);
    }
    if (row.status === "blocked") {
      assert.equal(row.historicalResolutionAllowed, false, `${row.compatibilityId} blocked rows must not allow historical resolution`);
    }
    await verifyEvidenceRefs(row.evidenceRefs, row.compatibilityId);
  }

  const transitionIds = new Set();
  assert.ok(Array.isArray(registry.transitions), "transitions must be an array");
  for (const transition of registry.transitions) {
    assertOnlyKeys(
      transition,
      ["transitionId", "artifactId", "fromVersion", "toVersion", "fromRef", "toRef", "lifecycle", "adjacent", "migrationPathConfigRef", "evidenceRefs"],
      "transition"
    );
    assert.equal(transitionIds.has(transition.transitionId), false, `duplicate transitionId: ${transition.transitionId}`);
    transitionIds.add(transition.transitionId);
    assert.equal(artifactIds.has(transition.artifactId), true, `${transition.transitionId} references unknown artifactId`);
    assertGovernedVersion(transition.fromVersion, `${transition.transitionId} fromVersion`, platformVersionBaseline);
    assertGovernedVersion(transition.toVersion, `${transition.transitionId} toVersion`, platformVersionBaseline);
    assert.equal(transition.fromRef, expectedRef(transition.artifactId, transition.fromVersion), `${transition.transitionId} fromRef mismatch`);
    assert.equal(transition.toRef, expectedRef(transition.artifactId, transition.toVersion), `${transition.transitionId} toRef mismatch`);
    assert.equal(artifactRefs.has(transition.fromRef), true, `${transition.transitionId} fromRef must resolve to a registered artifact version`);
    assert.equal(artifactRefs.has(transition.toRef), true, `${transition.transitionId} toRef must resolve to a registered artifact version`);
    assert.equal(transition.adjacent, true, `${transition.transitionId} must be an adjacent version migration`);
    if (transition.migrationPathConfigRef) {
      await assertReferenceExists(transition.migrationPathConfigRef, `${transition.transitionId} migrationPathConfigRef`);
    }
    await verifyEvidenceRefs(transition.evidenceRefs, transition.transitionId);
  }

  assert.ok(Array.isArray(registry.assemblies), "assemblies must be an array");
  const assemblyIds = new Set();
  for (const assembly of registry.assemblies) {
    assertOnlyKeys(assembly, ["assemblyId", "artifactRef", "lifecycle", "componentRefs", "evidenceRefs"], "assembly");
    assert.equal(assemblyIds.has(assembly.assemblyId), false, `duplicate assemblyId: ${assembly.assemblyId}`);
    assemblyIds.add(assembly.assemblyId);
    assertRefShape(assembly.assemblyId, "assemblyId", platformVersionBaseline);
    assert.equal(assembly.assemblyId, assembly.artifactRef, `${assembly.assemblyId} assemblyId must equal artifactRef`);
    assert.equal(artifactRefs.has(assembly.artifactRef), true, `${assembly.assemblyId} artifactRef must resolve`);
    assert.ok(Array.isArray(assembly.componentRefs) && assembly.componentRefs.length > 0, `${assembly.assemblyId} must list componentRefs`);
    for (const componentRef of assembly.componentRefs) {
      assert.equal(artifactRefs.has(componentRef), true, `${assembly.assemblyId} componentRef must resolve: ${componentRef}`);
    }
    await verifyEvidenceRefs(assembly.evidenceRefs, assembly.assemblyId);
  }

  const scannedOccurrences = collectGovernedVersionOccurrences({
    repoRoot,
    scanRoots: VERSION_SCAN_ROOTS,
    excludedRelativePaths: [registryRelativePath]
  });
  const unregisteredVersionFindings = [];
  const malformedVersionFindings = [];
  for (const [version, occurrences] of scannedOccurrences) {
    if (!GOVERNED_VERSION_PATTERN.test(version)) {
      malformedVersionFindings.push(...occurrences);
      continue;
    }
    if (!artifactRefsHasVersion(artifactRefs, version)) {
      unregisteredVersionFindings.push({
        version,
        occurrences: occurrences.slice(0, 5)
      });
    }
  }
  assert.deepEqual(
    malformedVersionFindings,
    [],
    `scanned governed version tokens must be well formed before registry validation`
  );
  assert.deepEqual(
    unregisteredVersionFindings,
    [],
    `all scanned governed version tokens must be registered in Version Registry`
  );
  const unbackedActiveVersionFindings = [];
  for (const [version, evidenceUris] of activeVersionEvidence) {
    const occurrences = scannedOccurrences.get(version) || [];
    const sourcePaths = new Set(occurrences.map((occurrence) => occurrence.relativePath));
    if (sourcePaths.size === 0 || ![...evidenceUris].some((uri) => sourcePaths.has(uri))) {
      unbackedActiveVersionFindings.push({
        version,
        evidenceUris: [...evidenceUris].sort(),
        sourcePaths: [...sourcePaths].sort()
      });
    }
  }
  assert.deepEqual(
    unbackedActiveVersionFindings,
    [],
    `every active registry version must be backed by a scanned non-registry source and matching evidence URI`
  );

  const report = {
    ok: true,
    checkedAt: new Date().toISOString(),
    registryPath: registryRelativePath,
    schemaPath: schemaRelativePath,
    artifactCount: artifactIds.size,
    artifactVersionCount: artifactRefs.size,
    activeRefs: Object.fromEntries([...activeRefs.entries()]),
    compatibilityRowCount: compatibilityIds.size,
    transitionCount: transitionIds.size,
    assemblyCount: assemblyIds.size,
    scannedVersionCount: scannedOccurrences.size
  };
  const reportPath = path.join(repoRoot, reportRelativePath);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

function artifactRefsHasVersion(artifactRefs, version) {
  for (const ref of artifactRefs) {
    if (ref.endsWith(`@${version}`)) return true;
  }
  return false;
}

verifyRegistry()
  .then((report) => {
    console.log(`[version-registry] ok (${report.artifactVersionCount} artifact versions, ${report.compatibilityRowCount} compatibility rows, ${report.transitionCount} transitions, ${report.scannedVersionCount} scanned versions)`);
  })
  .catch((error) => {
    console.error(`[version-registry] failed: ${error.message}`);
    process.exitCode = 1;
  });
