import type { PactiumProofBundle, PactiumProofEnvelope, PactiumRecord } from "pactium";

interface PlatformServiceEntry {
  id: string;
  platform: string;
  label: string;
  kind: string;
  ownerFeatureId: string;
  value: unknown;
  metadata: PactiumRecord;
}

interface PlatformRegistry {
  register(entry: PlatformServiceEntry): unknown;
}

interface OperationProofSubstrateFacade {
  protocolVersion: string;
  provider: string;
  mode: string;
  productionVerifiable: boolean;
  listCapabilities(): { capabilities: Array<{ id: string }> };
  beginLifecycle(input?: PactiumRecord): unknown;
  finishLifecycle(input?: PactiumRecord): unknown;
  denyLifecycle(input?: PactiumRecord): unknown;
  recordReceipt(input?: PactiumRecord): unknown;
  verifyReceipt(input?: PactiumRecord): unknown;
  verifyEnvelope(envelope?: PactiumProofEnvelope, options?: PactiumRecord): unknown;
  verifyBundle(bundle?: PactiumProofBundle, options?: PactiumRecord): unknown;
  exportProofBundle(input?: PactiumRecord): unknown;
  planRecovery(input?: PactiumRecord): unknown;
  getWorkspaceProjection(workspaceId?: string): unknown;
  proveWorkspaceMembership(input?: PactiumRecord): unknown;
  recordAcceptanceEvidence(input?: PactiumRecord): unknown;
}

interface RegistrationOptions {
  operationProofSubstrate?: OperationProofSubstrateFacade | null;
  registerPlatformService?: ((registry: PlatformRegistry | undefined, entry: PlatformServiceEntry) => unknown) | null;
}

export function registerOperationProofSubstratePlatformServices(
  registry?: PlatformRegistry,
  {
    operationProofSubstrate = null,
    registerPlatformService = null
  }: RegistrationOptions = {}
): unknown[] {
  const register = registerPlatformService ?? ((
    targetRegistry: PlatformRegistry | undefined,
    entry: PlatformServiceEntry
  ): unknown => {
    if (!targetRegistry) throw new Error("A PlatformRegistry instance is required.");
    return targetRegistry.register(entry);
  });
  const capabilities = operationProofSubstrate?.listCapabilities().capabilities ?? [];
  const metadata = (extra: PactiumRecord = {}): PactiumRecord => ({
    protocolVersion: operationProofSubstrate?.protocolVersion || "",
    provider: operationProofSubstrate?.provider || "",
    mode: operationProofSubstrate?.mode || "",
    ...extra
  });
  const entry = (
    id: string,
    label: string,
    kind: string,
    value: unknown,
    entryMetadata: PactiumRecord = {}
  ): PlatformServiceEntry => ({
    id,
    platform: "operation-proof-substrate",
    label,
    kind,
    ownerFeatureId: "operation-proof-substrate",
    value,
    metadata: metadata(entryMetadata)
  });

  return [
    register(registry, entry("operation-proof-substrate.provider", "Operation Proof Substrate provider", "provider", operationProofSubstrate, {
      productionVerifiable: operationProofSubstrate?.productionVerifiable === true,
      capabilityIds: capabilities.map(({ id }) => id)
    })),
    register(registry, entry("operation-proof-substrate.lifecycle", "Operation proof lifecycle", "proof-lifecycle", {
      beginLifecycle: (input: PactiumRecord = {}) => operationProofSubstrate?.beginLifecycle(input),
      finishLifecycle: (input: PactiumRecord = {}) => operationProofSubstrate?.finishLifecycle(input),
      denyLifecycle: (input: PactiumRecord = {}) => operationProofSubstrate?.denyLifecycle(input),
      recordReceipt: (input: PactiumRecord = {}) => operationProofSubstrate?.recordReceipt(input)
    })),
    register(registry, entry("operation-proof-substrate.verify", "Operation proof verification", "proof-verifier", {
      verifyReceipt: (input: PactiumRecord = {}) => operationProofSubstrate?.verifyReceipt(input),
      verifyEnvelope: (envelope?: PactiumProofEnvelope, options: PactiumRecord = {}) => operationProofSubstrate?.verifyEnvelope(envelope, options),
      verifyBundle: (bundle?: PactiumProofBundle, options: PactiumRecord = {}) => operationProofSubstrate?.verifyBundle(bundle, options)
    })),
    register(registry, entry("operation-proof-substrate.export", "Proof Bundle Export", "proof-export",
      (input: PactiumRecord = {}) => operationProofSubstrate?.exportProofBundle(input))),
    register(registry, entry("operation-proof-substrate.recover", "Operation proof recovery", "proof-recovery",
      (input: PactiumRecord = {}) => operationProofSubstrate?.planRecovery(input))),
    register(registry, entry("operation-proof-substrate.project", "Workspace proof projection", "proof-projection", {
      getWorkspaceProjection: (workspaceId = "default") => operationProofSubstrate?.getWorkspaceProjection(workspaceId),
      proveWorkspaceMembership: (input: PactiumRecord = {}) => operationProofSubstrate?.proveWorkspaceMembership(input)
    })),
    register(registry, entry("operation-proof-substrate.acceptance-evidence", "Acceptance evidence ledger anchoring", "proof-acceptance-evidence", {
      recordAcceptanceEvidence: (input: PactiumRecord = {}) => operationProofSubstrate?.recordAcceptanceEvidence(input)
    }, { digestOnly: true }))
  ];
}
