import { createSandboxExecutionBroker } from "../execution-sandbox/broker.mjs";
import { createQueuedSandboxExecutionPort } from "../execution-sandbox/queued-execution-port.mjs";
import { createTrustedOciProviderAdapters } from "../execution-sandbox/trusted-oci-provider-adapters.mjs";
import { createTrustedSandboxProviderResolver } from "../execution-sandbox/trusted-provider-resolver.mjs";
import { loadTrustedSandboxProviderReceipts } from "../execution-sandbox/trusted-provider-receipt-store.mjs";

function selection(settings) {
  if (!settings) return null;
  return {
    enabled: settings.enabled === true,
    providerMode: String(settings.providerMode || "").trim(),
    providerId: String(settings.providerId || "").trim(),
    profileId: String(settings.profileId || "").trim(),
    policyRevision: String(settings.policyRevision || "").trim(),
    allowedProviderClasses: Array.isArray(settings.allowedProviderClasses)
      ? settings.allowedProviderClasses.map((entry) => String(entry || "").trim()).filter(Boolean)
      : [],
    receiptRequirement: String(settings.receiptRequirement || "").trim()
  };
}

export async function createConfiguredSandboxExecution({
  userDataPath,
  settings = null,
  trustedProviderAdapters = null,
  opaqueArtifactCustody = null,
  audit = null,
  queueApplicationPort = null
} = {}) {
  const configuration = selection(settings);
  const profiles = Object.fromEntries(
    (Array.isArray(settings?.profiles) ? settings.profiles : [])
      .map((profile) => [String(profile?.id || "").trim(), profile])
      .filter(([id]) => id)
  );
  const conformanceReceipts = loadTrustedSandboxProviderReceipts({ userDataPath });
  const providerResolver = createTrustedSandboxProviderResolver({
    configuration,
    adapters: Array.isArray(trustedProviderAdapters)
      ? trustedProviderAdapters
      : createTrustedOciProviderAdapters({ conformanceReceipts })
  });
  const broker = createSandboxExecutionBroker({
    configuration,
    profiles,
    providerResolver,
    opaqueArtifactCustody,
    userDataPath,
    audit
  });
  await broker.recover();
  return createQueuedSandboxExecutionPort({ broker, queueApplicationPort });
}
