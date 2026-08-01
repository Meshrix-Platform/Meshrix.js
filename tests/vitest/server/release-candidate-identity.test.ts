import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  RELEASE_SOURCE_CANDIDATE_SCHEMA,
  buildReleaseCandidateIdentity,
  validateReleaseCandidateIdentity
} from "../../../tools/server-scripts/verify-release-candidate-identity.ts";

const SOURCE_REVISION: any = "a".repeat(40);
const REPOSITORY_TREE_DIGEST: any = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const RELEASE_DEFINITION_SHA256: any = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
const PACKAGE_LOCK_SHA256: any = "sha256:3333333333333333333333333333333333333333333333333333333333333333";
const REPORT_INVENTORY_DIGEST: any = "sha256:4444444444444444444444444444444444444444444444444444444444444444";

const RELEASE_PACKAGES: readonly any[] = Object.freeze([
  {
    manifest_path: "packages/contracts/package.json",
    name: "@meshrix/contracts",
    version: "0.0.1",
    manifest_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  {
    manifest_path: "apps/server/package.json",
    name: "@meshrix/server",
    version: "0.0.1",
    manifest_sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  }
]);

function sha256(value?: any) : any {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalPackageIdentityInput(overrides: Record<string, any> = {}) : any {
  return {
    sourceRevision: SOURCE_REVISION,
    repositoryTreeDigest: REPOSITORY_TREE_DIGEST,
    releaseDefinitionSha256: RELEASE_DEFINITION_SHA256,
    packageLockSha256: PACKAGE_LOCK_SHA256,
    releasePackages: RELEASE_PACKAGES,
    supportedProfiles: ["enterprise-single-node"],
    reportInventoryDigest: REPORT_INVENTORY_DIGEST,
    ...overrides
  };
}

function expectCandidateFailure(input?: any, expectedCode: any = /candidate/i) : any {
  try {
    validateReleaseCandidateIdentity(input);
    throw new Error("expected candidate validation failure");
  } catch (error: any) {
    expect(error).toBeInstanceOf(Error);
    expect(error.code ?? error.message).toMatch(expectedCode);
  }
}

describe("release source-candidate identity", () : any => {
  it("builds deterministic snake_case identity with stable digest and stable release-set projection", () : any => {
    const normal: any = buildReleaseCandidateIdentity(canonicalPackageIdentityInput());
    const shuffled: any = buildReleaseCandidateIdentity(
      canonicalPackageIdentityInput({
        releasePackages: [...RELEASE_PACKAGES].slice().reverse()
      })
    );
    const canonicalCopy: any = buildReleaseCandidateIdentity({
      ...canonicalPackageIdentityInput(),
      releasePackages: RELEASE_PACKAGES.map((entry?: any) : any => structuredClone(entry))
    });

    expect(normal).toMatchObject({
      schema_version: RELEASE_SOURCE_CANDIDATE_SCHEMA,
      source_revision: SOURCE_REVISION,
      repository_tree_digest: REPOSITORY_TREE_DIGEST,
      release_definition_sha256: RELEASE_DEFINITION_SHA256,
      package_lock_sha256: PACKAGE_LOCK_SHA256,
      release_package_inventory_sha256: expect.any(String),
      report_inventory_digest: REPORT_INVENTORY_DIGEST,
      supported_profiles: ["enterprise-single-node"]
    });
    expect(normal.candidate_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(normal.release_package_inventory_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.keys(normal).sort()).toEqual([
      "candidate_digest",
      "package_lock_sha256",
      "release_definition_sha256",
      "release_package_inventory_sha256",
      "release_packages",
      "report_inventory_digest",
      "repository_tree_digest",
      "schema_version",
      "source_revision",
      "supported_profiles"
    ].sort());
    expect(normal).toEqual(shuffled);
    expect(normal).toEqual(canonicalCopy);
    expect(Array.isArray(normal.release_packages)).toBe(true);
    expect(normal.release_packages).toHaveLength(RELEASE_PACKAGES.length);
    expect(normal.release_packages.every((entry?: any) : any => {
      expect(entry).toEqual({
        manifest_path: expect.any(String),
        name: expect.any(String),
        version: expect.any(String),
        manifest_sha256: expect.any(String)
      });
      expect(entry).not.toHaveProperty("absoluteDirectory");
      expect(entry).not.toHaveProperty("raw_manifest");
      return true;
    })).toBe(true);
    expect(Object.isFrozen(normal)).toBe(true);
    expect(Object.isFrozen(normal.release_packages)).toBe(true);
    expect(Object.isFrozen(normal.supported_profiles)).toBe(true);

    expect(normal).not.toHaveProperty("schemaVersion");
    expect(normal).not.toHaveProperty("sourceRevision");
    expect(normal).not.toHaveProperty("repositoryTreeDigest");
    expect(normal).not.toHaveProperty("releaseDefinitionSha256");
    expect(normal).not.toHaveProperty("packageLockSha256");
    expect(normal).not.toHaveProperty("releasePackages");
    expect(normal).not.toHaveProperty("supportedProfiles");
    expect(normal).not.toHaveProperty("reportInventoryDigest");

    expect(new Set<any>(normal.release_packages.map(({ manifest_path }: Record<string, any>) : any => manifest_path)).size)
      .toBe(normal.release_packages.length);
    expect(new Set<any>(normal.release_packages.map(({ name }: Record<string, any>) : any => name)).size)
      .toBe(normal.release_packages.length);
  });

  it("enforces exact supported profile and canonical package inventory rules", () : any => {
    expect(() : any => buildReleaseCandidateIdentity(canonicalPackageIdentityInput({
      supportedProfiles: []
    }))).toThrow();

    expect(() : any => buildReleaseCandidateIdentity(canonicalPackageIdentityInput({
      supportedProfiles: ["enterprise-single-node", "enterprise-ha"]
    }))).toThrow();

    expect(() : any => buildReleaseCandidateIdentity(canonicalPackageIdentityInput({
      releasePackages: [
        {
          manifest_path: "packages/contracts/package.json",
          name: "@meshrix/contracts",
          version: "0.0.1",
          manifest_sha256: "a".repeat(64),
          extra_key: 1
        }
      ]
    }))).toThrow();

    expect(() : any => buildReleaseCandidateIdentity(canonicalPackageIdentityInput({
      releasePackages: [
        {
          manifest_path: "packages/contracts/package.json",
          name: "@meshrix/contracts",
          version: "0.0.1",
          manifest_sha256: "a".repeat(64)
        },
        {
          manifest_path: "packages/contracts/package.json",
          name: "@meshrix/server",
          version: "0.0.1",
          manifest_sha256: "b".repeat(64)
        }
      ]
    }))).toThrow();

    expect(() : any => buildReleaseCandidateIdentity(canonicalPackageIdentityInput({
      releasePackages: [
        {
          manifest_path: "packages/contracts/package.json",
          name: "@meshrix/contracts",
          version: "0.0.1",
          manifest_sha256: "a".repeat(64)
        },
        {
          manifest_path: "apps/server/package.json",
          name: "@meshrix/contracts",
          version: "0.0.1",
          manifest_sha256: "b".repeat(64)
        }
      ]
    }))).toThrow();

    expect(() : any => buildReleaseCandidateIdentity(canonicalPackageIdentityInput({
      releasePackages: [
        {
          manifest_path: "packages/contracts/package.json",
          name: "@meshrix/contracts",
          version: "0.0.1",
          manifest_sha256: "a".repeat(64),
          absoluteDirectory: "packages/contracts"
        }
      ]
    }))).toThrow();

    expect(() : any => buildReleaseCandidateIdentity(canonicalPackageIdentityInput({
      releasePackages: [
        {
          manifest_path: "packages/contracts/package.json",
          name: "@meshrix/contracts",
          version: "0.0.1",
          manifest_sha256: "a".repeat(64),
          raw_manifest: true
        }
      ]
    }))).toThrow();

    expect(() : any => buildReleaseCandidateIdentity({
      ...canonicalPackageIdentityInput(),
      unknownField: 1
    })).toThrow();

    expectCandidateFailure({
      ...buildReleaseCandidateIdentity(canonicalPackageIdentityInput()),
      unexpected_output: 1
    }, /candidate_digest/);
  });

  it("validates canonical candidate shape and rejects mutated or stale fields", () : any => {
    const candidate: any = buildReleaseCandidateIdentity(canonicalPackageIdentityInput());
    const withBadDigest: Record<string, any> = { ...candidate, candidate_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" };
    expectCandidateFailure(withBadDigest, /candidate_digest/);

    const staleSource: Record<string, any> = { ...candidate, source_revision: `${"b".repeat(40)}` };
    expectCandidateFailure(staleSource, /candidate_digest/);

    const packageTamper: any = structuredClone(candidate);
    packageTamper.release_packages[0].version = "9.9.9";
    expectCandidateFailure(packageTamper, /release_packages/);

    const missing: any = structuredClone(candidate);
    delete missing.report_inventory_digest;
    expectCandidateFailure(missing, /report_inventory_digest/);
  });

  it("changes digest for owner and package-inventory basis while remaining strictly immutable", () : any => {
    const baseline: any = buildReleaseCandidateIdentity(canonicalPackageIdentityInput());
    const alternateReportOwner: any = buildReleaseCandidateIdentity(canonicalPackageIdentityInput({
      reportInventoryDigest: sha256("alternate report owners")
    }));
    const alternateInventory: any = buildReleaseCandidateIdentity(canonicalPackageIdentityInput({
      releasePackages: [
        {
          manifest_path: "packages/contracts/package.json",
          name: "@meshrix/contracts",
          version: "0.0.2",
          manifest_sha256: "a".repeat(64)
        }
      ]
    }));

    expect(alternateReportOwner.candidate_digest).not.toBe(baseline.candidate_digest);
    expect(alternateInventory.candidate_digest).not.toBe(baseline.candidate_digest);
    expect(validateReleaseCandidateIdentity(baseline)).toMatchObject({
      candidate_digest: baseline.candidate_digest
    });
    expectCandidateFailure({
      ...baseline,
      report_inventory_digest: alternateReportOwner.report_inventory_digest
    }, /candidate_digest/);
  });
});
