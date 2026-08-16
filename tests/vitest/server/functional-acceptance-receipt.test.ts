import { describe, expect, it } from "vitest";

import { containsSensitiveReportData, reportPayloadDigest } from "../../../packages/foundation/src/observability/sensitive-report-scan.ts";
import {
  FUNCTIONAL_FINAL_EVIDENCE_PATHS,
  FUNCTIONAL_FINAL_NODE,
  FUNCTIONAL_FINAL_PREFERRED_VM_FAMILY,
  FUNCTIONAL_FINAL_PROFILE,
  FUNCTIONAL_FINAL_REPORT_SCHEMA,
  FUNCTIONAL_FINAL_VM_FAMILIES,
  inspectFunctionalFinalEvidence,
  probeLinuxVmFamily,
  reduceFunctionalFinal,
} from "../../../tools/server-scripts/functional-final.ts";

const ABSOLUTE_PATH_PATTERN: any = /(?:\/(?:Users|home|private|var\/folders|root)\/|[A-Za-z]:\\)/u;

function sealed(value?: any) : any {
  const report: any = { ...value };
  report.payloadDigest = reportPayloadDigest(report);
  return report;
}

function validReports(overrides: Record<string, any> = {}) : any {
  return {
    efficiency: sealed({
      schemaVersion: "v0.0.1:efficiency:named-profile-report-1",
      producer: "efficiency",
      commandId: "efficiency",
      sourceRevision: "sha256:aa",
      summary: {
        completenessPassed: true,
        privacyPassed: true,
        safetyPassed: true,
        recoveryPassed: true,
        warmThresholdsPassed: true,
        ownerProfile: FUNCTIONAL_FINAL_PROFILE,
        capacityCertified: true,
      },
      ...overrides.efficiency,
    }),
    pluginIsolation: sealed({
      schemaVersion: "v0.0.1:plugin:console-isolation-closure-1",
      producer: "plugin",
      commandId: "plugin",
      sourceRevision: "sha256:bb",
      summary: { acceptancePassed: true },
      ...overrides.pluginIsolation,
    }),
    enterpriseOperations: sealed({
      schemaVersion: "v0.0.1:meshrix:enterprise-operations-closure-report-1",
      producer: "operations",
      commandId: "operations",
      sourceRevision: "sha256:cc",
      environmentSupportClaimed: false,
      productionReady: false,
      summary: {
        scenarioAccepted: true,
        environmentSupportClaimed: false,
        productionReady: false,
      },
      ...overrides.enterpriseOperations,
    }),
    offlineDelivery: sealed({
      schemaVersion: "v0.0.1:meshrix:enterprise-single-node-offline-bundle-1",
      producer: "offline",
      commandId: "offline",
      sourceRevision: "sha256:dd",
      verdict: "accepted",
      environment: {
        blocked: false,
        linuxHost: false,
        linuxVmTargetAvailable: true,
      },
      summary: {
        acceptanceMet: true,
        contractFixtureUsed: false,
        rebuilt: false,
        nativeLinuxSupportClaimed: false,
        publicationClaimed: false,
      },
      ...overrides.offlineDelivery,
    }),
  };
}

describe("functional final closure", () : any => {
  it("prefers Ubuntu and still accepts Debian inside a Linux VM", () : any => {
    expect(FUNCTIONAL_FINAL_PREFERRED_VM_FAMILY).toBe("ubuntu");
    expect([...FUNCTIONAL_FINAL_VM_FAMILIES]).toEqual(["ubuntu", "debian"]);
    const ubuntu: any = reduceFunctionalFinal({
      reports: validReports(),
      environment: {
        operatorPlatform: "darwin",
        linuxHost: false,
        linuxVmTargetAvailable: true,
        linuxVmFamily: "ubuntu",
      },
    });
    expect(ubuntu.schemaVersion).toBe(FUNCTIONAL_FINAL_REPORT_SCHEMA);
    expect(ubuntu.node).toBe(FUNCTIONAL_FINAL_NODE);
    expect(ubuntu.verdict).toBe("accepted");
    expect(ubuntu.environment.linuxVmFamily).toBe("ubuntu");
    expect(ubuntu.environment.preferredLinuxVmFamily).toBe("ubuntu");
    expect(ubuntu.summary.linuxVmFamilyAccepted).toBe(true);
    const debian: any = reduceFunctionalFinal({
      reports: validReports(),
      environment: {
        operatorPlatform: "darwin",
        linuxVmTargetAvailable: true,
        linuxVmFamily: "debian",
      },
    });
    expect(debian.verdict).toBe("accepted");
    expect(debian.environment.linuxVmFamily).toBe("debian");
    expect(debian.claims).toEqual({
      planCandidateAccepted: true,
      projectLevelFunctionalAcceptance: false,
      publication: false,
      productionReady: false,
      environmentSupport: false,
      nativeLinuxSupport: false,
      ubuntuSupport: false,
      debianSupport: false,
      capacityCertified: false,
    });
    expect(containsSensitiveReportData(ubuntu)).toBe(false);
    expect(JSON.stringify(ubuntu)).not.toMatch(ABSOLUTE_PATH_PATTERN);
    expect(ubuntu.evidence.efficiency.path).toBe(FUNCTIONAL_FINAL_EVIDENCE_PATHS.efficiency);
  });

  it("rejects missing, substituted, fixture, unsupported family, and inflated evidence", () : any => {
    expect(() : any => inspectFunctionalFinalEvidence({})).toThrow(/exact current evidence set/);
    const substituted: any = validReports();
    substituted.offlineDelivery.payloadDigest = "sha256:deadbeef";
    expect(() : any => inspectFunctionalFinalEvidence(substituted)).toThrow(/substituted/);
    expect(() : any => inspectFunctionalFinalEvidence(validReports({
      offlineDelivery: {
        verdict: "accepted",
        environment: { linuxHost: false, linuxVmTargetAvailable: true },
        summary: {
          acceptanceMet: true,
          contractFixtureUsed: true,
          rebuilt: false,
          nativeLinuxSupportClaimed: false,
          publicationClaimed: false,
        },
      },
    }))).toThrow(/fixture/);
    expect(() : any => reduceFunctionalFinal({
      reports: validReports(),
      environment: { linuxVmTargetAvailable: true, linuxVmFamily: "fedora" },
    })).toThrow(/Ubuntu or Debian/);
    expect(() : any => reduceFunctionalFinal({
      reports: validReports(),
      environment: { linuxVmTargetAvailable: true, linuxVmFamily: "ubuntu" },
      extras: { publicationClaimed: true },
    })).toThrow(/publication/);
  });

  it("fails closed when a Linux VM is unavailable", () : any => {
    expect(() : any => inspectFunctionalFinalEvidence(validReports({
      offlineDelivery: {
        verdict: "accepted",
        environment: { linuxHost: false, linuxVmTargetAvailable: false },
        summary: {
          acceptanceMet: true,
          contractFixtureUsed: false,
          rebuilt: false,
          nativeLinuxSupportClaimed: false,
          publicationClaimed: false,
        },
      },
    }))).toThrow(/Linux VM evidence/);
  });

  it("accepts Ubuntu or Debian os-release probes and prefers Ubuntu", () : any => {
    expect(probeLinuxVmFamily({
      image: "local.example/meshrix-js/runtime-ui:offline-arm64",
      commandRunner: () : any => ({
        status: 0,
        stdout: "ID=ubuntu\nVERSION_ID=\"24.04\"\n",
      }),
    })).toEqual({
      available: true,
      family: "ubuntu",
      preferredFamily: "ubuntu",
      versionId: "24.04",
    });
    expect(probeLinuxVmFamily({
      commandRunner: () : any => ({
        status: 0,
        stdout: "ID=debian\nVERSION_ID=\"12\"\n",
      }),
    })).toEqual({
      available: true,
      family: "debian",
      preferredFamily: "ubuntu",
      versionId: "12",
    });
  });
});
