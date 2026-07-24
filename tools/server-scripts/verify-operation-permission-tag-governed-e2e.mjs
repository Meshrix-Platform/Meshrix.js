#!/usr/bin/env node
import assert from "node:assert/strict";

import { startHttpServer } from "../../apps/server/runtime/http-server.mjs";
import { installAuthenticatedFetch } from "./test-auth-helper.mjs";
import { useIsolatedCapabilityKernelForVerifier } from "./capability-kernel-test-env.mjs";
import { createOperationPermissionTagGovernedWorkflows } from "./lib/operation-permission-tag-governed-workflows.mjs";
import {
  createOperationPermissionTagGovernedE2eHarness,
  OPERATION_PERMISSION_TAG_GOVERNED_E2E,
  TAG_GOVERNED_ENTITY_REFS
} from "./lib/operation-permission-tag-governed-e2e-harness.mjs";

const {
  reportPath: REPORT_PATH,
  allowTag: ALLOW_TAG,
  denyTag: DENY_TAG,
  serviceId: SERVICE_ID,
  approvalTool: APPROVAL_TOOL
} = OPERATION_PERMISSION_TAG_GOVERNED_E2E;
const ENTITY_REFS = TAG_GOVERNED_ENTITY_REFS;

const restoreCapabilityKernelEnv = useIsolatedCapabilityKernelForVerifier();
const harness = await createOperationPermissionTagGovernedE2eHarness();
const {
  fixtureState,
  createdGrantIds,
  trackSecret,
  redactText,
  safeEvidence,
  writeReport,
  test,
  destructiveTest,
  startFixture,
  writeUpstreamGatewayConfig,
  setServer,
  setPrimaryGrant,
  getMcpGrantId,
  getMcpToken,
  api,
  assertMcpDenied,
  assertMcpOk,
  callMcp,
  callMcpWithToolName,
  capabilitiesForToken,
  createLocalGrant,
  denialSummary,
  mcpPayload,
  openMcpSse,
  operationNames,
  rebuildTagProjections,
  registerGatewayFixture,
  refreshCapabilities,
  tagPolicy,
  tagProjections,
  upsertTag,
  cleanup
} = harness;

const workflows = createOperationPermissionTagGovernedWorkflows({
  ALLOW_TAG,
  APPROVAL_TOOL,
  DENY_TAG,
  ENTITY_REFS,
  SERVICE_ID,
  api,
  assertMcpDenied,
  assertMcpOk,
  callMcp,
  callMcpWithToolName,
  capabilitiesForToken,
  createLocalGrant,
  createdGrantIds,
  denialSummary,
  fixtureState,
  getMcpToken,
  mcpPayload,
  openMcpSse,
  operationNames,
  rebuildTagProjections,
  safeEvidence,
  tagPolicy,
  tagProjections,
  trackSecret,
  upsertTag
});

let exitCode = 0;

try {
  await startFixture();
  await writeUpstreamGatewayConfig();

  const serverStarted = await startHttpServer({
    userDataPath: harness.userDataPath,
    distPath: "",
    port: 0,
    runtimeOptions: {
      profile: "minimal",
      enableFeatures: ["operation-permission-core", "upstream-gateway"],
      enabledPlugins: []
    }
  });
  setServer(serverStarted);
  await installAuthenticatedFetch(serverStarted);

  console.log("\n=== Operation Permission Tag-Governed E2E ===\n");

  await test("setup tags projections grant and upstream fixture", async () => {
    await upsertTag(ALLOW_TAG, "Tag governed E2E allow", tagProjections());
    const rebuild = await rebuildTagProjections();
    assert.equal(Number(rebuild.count || 0) >= Object.keys(ENTITY_REFS).length, true);
    const gateway = await registerGatewayFixture();
    const grant = await createLocalGrant();
    assert.equal(grant.grant?.toolsets?.includes("meshrix.gateway.read"), true);
    assert.equal(grant.grant?.toolsets?.includes("meshrix.gateway.write"), true);
    setPrimaryGrant(grant);
    const capabilities = await refreshCapabilities();
    return {
      projectedEntityCount: Object.keys(ENTITY_REFS).length,
      rebuildCount: rebuild.count,
      gateway,
      grantCreated: Boolean(getMcpGrantId()),
      capabilities
    };
  });

  await test("allow-tag admission executes governed Core operations", workflows.verifyAllowAcrossDomains);
  await test("MCP discovery refreshes after grant and tag policy changes", workflows.verifyMcpDiscoveryAuthorizationRefresh);
  await test("approval queue records stale Operation Permission policy", workflows.verifyApprovalEvidence);
  await test("wrong outlet and insufficient grant attempts are denied", workflows.verifyBypassPrevention);
  await destructiveTest("deny-tag rejection blocks governed Core operations", workflows.verifyDenyAcrossDomains);
  await test("audit metrics and cleanup close the tag-governed E2E loop", workflows.verifyAuditMetricsAndCleanup);
} catch (error) {
  console.error(`FAIL: ${redactText(error?.message || String(error))}`);
  if (process.env.MESHRIX_VERIFY_VERBOSE) {
    console.error(`stage=${redactText(error?.stage || "unknown")} reason=${redactText(error?.reasonCode || "unknown")}`);
    console.error(redactText(error?.stack || String(error)));
    if (error?.cause) console.error(redactText(error.cause?.stack || error.cause?.message || String(error.cause)));
  }
  exitCode = 1;
} finally {
  try {
    await writeReport();
  } catch (error) {
    console.error(`FAIL: could not write report: ${redactText(error?.message || String(error))}`);
    exitCode = 1;
  }
  await cleanup({ restoreCapabilityKernelEnv });
}

if (exitCode === 0) {
  console.log(`PASS: operation permission tag-governed E2E verified; report: ${REPORT_PATH}`);
}

process.exit(exitCode);
