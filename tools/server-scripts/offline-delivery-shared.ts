#!/usr/bin/env node
import { spawnSync } from "node:child_process";

import {
  ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS,
  ENTERPRISE_OFFLINE_BUNDLE_SCHEMA,
} from "./enterprise-single-node-offline-bundle.ts";

export const OFFLINE_DELIVERY_CLOSURE_VERIFIER: any =
  "tools/server-scripts/offline-delivery-closure.ts";
export const OFFLINE_DELIVERY_PRODUCER: any =
  "tools/server-scripts/offline-delivery-producer.ts";
export const OFFLINE_DELIVERY_DISCONNECTED_VERIFIER: any =
  "tools/server-scripts/offline-delivery-disconnected-verifier.ts";
export const OFFLINE_DELIVERY_SHARED: any =
  "tools/server-scripts/offline-delivery-shared.ts";
export const OFFLINE_DELIVERY_VM_TARGET: any =
  "tools/server-scripts/offline-delivery-vm-target.ts";
export const OFFLINE_DELIVERY_CLOSURE_REPORT_RELATIVE_PATH: any =
  "build/reports/offline-delivery-closure.json";
export const OFFLINE_DELIVERY_FOCUSED_SUITE: any =
  "tests/vitest/server/offline-delivery-closure.test.ts";
export const OFFLINE_DELIVERY_INSTRUCTIONS_RELATIVE_PATH: any =
  "docker/offline-delivery-instructions.md";
export const OFFLINE_DELIVERY_CLOSURE_REPORT_SCHEMA: any =
  ENTERPRISE_OFFLINE_BUNDLE_SCHEMA;
export const OFFLINE_DELIVERY_BUNDLE_SCHEMA: any = ENTERPRISE_OFFLINE_BUNDLE_SCHEMA;
export const OFFLINE_DELIVERY_PLATFORMS: readonly any[] = ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS;
export const OFFLINE_DELIVERY_FIRST_GOVERNED_CALL: Readonly<Record<string, any>> = Object.freeze({
  protocol: "mcp",
  method: "tools/call",
  tool: "meshrix.discovery",
  operation: "system.health",
});
export const OFFLINE_DELIVERY_LIFECYCLE_STEPS: readonly any[] = Object.freeze([
  "import",
  "start",
  "first_governed_call",
  "stop",
  "cleanup",
]);
export const OFFLINE_DELIVERY_ENVIRONMENT_BLOCK_REASONS: readonly any[] = Object.freeze([
  "linux_vm_target_unavailable",
  "candidate_oci_layout_unavailable",
  "linux_dual_arch_builder_unavailable",
  "oci_importer_unavailable",
  "container_engine_unavailable",
  "operator_secret_custody_unavailable",
]);
export const OFFLINE_DELIVERY_VERDICTS: readonly any[] = Object.freeze([
  "accepted",
  "blocked_by_environment",
  "failed",
]);
export const OFFLINE_DELIVERY_EXIT: Readonly<Record<string, any>> = Object.freeze({
  accepted: 0,
  failed: 1,
  blocked_by_environment: 2,
});

export function failOfflineDelivery(code?: any, message?: any) : any {
  const error: Error & Record<string, any> = new Error(message);
  error.code = code;
  throw error;
}

export function isRecord(value?: any) : any {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function classifyOfflineDeliveryEnvironment({
  platform = process.platform,
  linuxVmTargetAvailable,
  candidateLayoutConfigured = false,
  dualArchBuilderAvailable,
  importerAvailable = false,
  engineAvailable = false,
  secretCustodyConfigured = false,
}: Record<string, any> = {}) : any {
  const vmAvailable: any = linuxVmTargetAvailable === true
    || (linuxVmTargetAvailable !== false && platform === "linux");
  const builderAvailable: any = dualArchBuilderAvailable === true
    || (dualArchBuilderAvailable !== false && candidateLayoutConfigured === true);
  const reasons: any[] = [];
  if (vmAvailable !== true) {
    reasons.push("linux_vm_target_unavailable");
  }
  if (candidateLayoutConfigured !== true) {
    reasons.push("candidate_oci_layout_unavailable");
  }
  if (builderAvailable !== true) {
    reasons.push("linux_dual_arch_builder_unavailable");
  }
  if (importerAvailable !== true) {
    reasons.push("oci_importer_unavailable");
  }
  if (engineAvailable !== true) {
    reasons.push("container_engine_unavailable");
  }
  if (secretCustodyConfigured !== true) {
    reasons.push("operator_secret_custody_unavailable");
  }
  const blocked: any = reasons.length > 0;
  const reason: any = blocked ? reasons[0] : null;
  if (
    reason !== null
    && !OFFLINE_DELIVERY_ENVIRONMENT_BLOCK_REASONS.includes(reason)
  ) {
    failOfflineDelivery(
      "offline_delivery_environment_reason_invalid",
      "Environment block reason is not finite.",
    );
  }
  return Object.freeze({
    blocked,
    reason,
    reasons: Object.freeze([...reasons]),
    linuxHost: platform === "linux",
    linuxVmTargetAvailable: vmAvailable === true,
    candidateLayoutConfigured: candidateLayoutConfigured === true,
    dualArchBuilderAvailable: builderAvailable === true,
    importerAvailable: importerAvailable === true,
    engineAvailable: engineAvailable === true,
    secretCustodyConfigured: secretCustodyConfigured === true,
    nativeLinuxSupportClaimed: false,
  });
}

export function probeLinuxVmTarget({
  spawn = spawnSync,
  platform = process.platform,
}: Record<string, any> = {}) : any {
  if (platform === "linux") {
    return Object.freeze({
      available: true,
      kind: "linux_host",
    });
  }
  const docker: any = spawn("docker", ["version", "--format", "{{.Server.Os}}"], {
    encoding: "utf8",
    timeout: 8000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const dockerOs: any = String(docker?.stdout || "").trim().toLowerCase();
  if (docker?.status === 0 && dockerOs === "linux") {
    return Object.freeze({
      available: true,
      kind: "linux_vm_container_engine",
    });
  }
  const orb: any = spawn("orb", ["uname", "-s"], {
    encoding: "utf8",
    timeout: 8000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (orb?.status === 0 && String(orb?.stdout || "").trim() === "Linux") {
    return Object.freeze({
      available: true,
      kind: "linux_vm",
    });
  }
  return Object.freeze({
    available: false,
    kind: null,
  });
}

export function probeDualArchLinuxBuilder({
  spawn = spawnSync,
}: Record<string, any> = {}) : any {
  const result: any = spawn("docker", ["buildx", "ls"], {
    encoding: "utf8",
    timeout: 8000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const text: any = `${result?.stdout || ""}\n${result?.stderr || ""}`;
  const available: any = result?.status === 0
    && text.includes("linux/amd64")
    && text.includes("linux/arm64");
  return Object.freeze({ available });
}

export function probeContainerEngineAvailability({
  spawn = spawnSync,
}: Record<string, any> = {}) : any {
  const docker: any = spawn("docker", ["version"], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const podman: any = spawn("podman", ["version"], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const skopeo: any = spawn("skopeo", ["--version"], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const engineAvailable: any = docker?.status === 0 || podman?.status === 0;
  const importerAvailable: any = skopeo?.status === 0 || engineAvailable === true;
  return Object.freeze({
    engineAvailable,
    importerAvailable,
    dockerAvailable: docker?.status === 0,
    podmanAvailable: podman?.status === 0,
    skopeoAvailable: skopeo?.status === 0,
  });
}

export function createOneShotReplayGuard() : any {
  const seen: any = new Set<any>();
  return Object.freeze({
    async consume({ signatureId }: Record<string, any> = {}) : Promise<any> {
      const id: any = String(signatureId || "");
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    },
  });
}

export function assertLifecycleCommandOffline(step?: any) : any {
  if (!isRecord(step) || typeof step.id !== "string" || typeof step.executable !== "string") {
    failOfflineDelivery(
      "offline_delivery_lifecycle_step_invalid",
      "Lifecycle step is invalid.",
    );
  }
  if (step.networkRequired === true) {
    failOfflineDelivery(
      "offline_delivery_network_forbidden",
      "Disconnected lifecycle must not require network access.",
    );
  }
  if (step.rebuild === true) {
    failOfflineDelivery(
      "offline_delivery_rebuild_forbidden",
      "Disconnected lifecycle must not rebuild.",
    );
  }
  const args: any = Array.isArray(step.args) ? step.args.map(String) : [];
  const joined: any = args.join(" ");
  if (
    (args.includes("build") && !args.includes("--no-build"))
    || args.includes("--build")
    || /(^|\s)--build(\s|$)/u.test(joined)
  ) {
    failOfflineDelivery(
      "offline_delivery_rebuild_forbidden",
      "Disconnected lifecycle must not rebuild.",
    );
  }
  if (step.executable === "docker" && args[0] === "pull") {
    failOfflineDelivery(
      "offline_delivery_network_forbidden",
      "Disconnected lifecycle must not pull images.",
    );
  }
  if (args.includes("pull") && !args.includes("never")) {
    failOfflineDelivery(
      "offline_delivery_network_forbidden",
      "Disconnected lifecycle must not pull images.",
    );
  }
  return true;
}

export function assertOfflineDeliveryVerdictHonest(report?: any) : any {
  if (!isRecord(report) || !isRecord(report.summary)) {
    failOfflineDelivery(
      "offline_delivery_report_invalid",
      "Offline delivery report is invalid.",
    );
  }
  const summary: any = report.summary;
  if (summary.capacityCertified === true) {
    failOfflineDelivery(
      "offline_delivery_capacity_claim_forbidden",
      "Offline delivery must not certify capacity.",
    );
  }
  if (summary.publicationClaimed === true) {
    failOfflineDelivery(
      "offline_delivery_publication_claim_forbidden",
      "Offline delivery must not claim publication.",
    );
  }
  if (summary.nativeLinuxSupportClaimed === true) {
    failOfflineDelivery(
      "offline_delivery_linux_support_claim_forbidden",
      "Offline Linux artifacts must not claim native Linux support.",
    );
  }
  if (summary.networkUsed === true || summary.rebuilt === true) {
    failOfflineDelivery(
      "offline_delivery_network_or_rebuild_forbidden",
      "Offline delivery must not use network access or rebuild.",
    );
  }
  if (
    report.verdict === "accepted"
    || summary.acceptanceMet === true
  ) {
    if (summary.contractFixtureUsed === true) {
      failOfflineDelivery(
        "offline_delivery_mock_success_forbidden",
        "Contract fixture bytes cannot satisfy disconnected delivery acceptance.",
      );
    }
    if (report.verdict === "blocked_by_environment" || summary.blockedByEnvironment === true) {
      failOfflineDelivery(
        "offline_delivery_mock_success_forbidden",
        "Blocked environment evidence cannot be reported as accepted.",
      );
    }
    if (
      summary.disconnectedTargetRan !== true
      || summary.imported !== true
      || summary.started !== true
      || summary.firstGovernedCall !== true
      || summary.stopped !== true
      || summary.cleanedUp !== true
      || summary.exactBytesVerified !== true
    ) {
      failOfflineDelivery(
        "offline_delivery_mock_success_forbidden",
        "Acceptance requires import, start, first governed call, stop, cleanup, and exact bytes.",
      );
    }
  }
  if (
    report.verdict === "blocked_by_environment"
    && (
      !OFFLINE_DELIVERY_ENVIRONMENT_BLOCK_REASONS.includes(report.environmentBlockReason)
      || summary.acceptanceMet === true
    )
  ) {
    failOfflineDelivery(
      "offline_delivery_environment_reason_invalid",
      "blocked_by_environment requires a finite reason and must not claim acceptance.",
    );
  }
  if (!OFFLINE_DELIVERY_VERDICTS.includes(report.verdict)) {
    failOfflineDelivery(
      "offline_delivery_verdict_invalid",
      "Offline delivery verdict is invalid.",
    );
  }
  return true;
}
