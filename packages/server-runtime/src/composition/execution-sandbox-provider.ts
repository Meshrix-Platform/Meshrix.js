import { createSandboxExecutionBroker } from "../execution-sandbox/broker.ts";
import { createQueuedSandboxExecutionPort } from "../execution-sandbox/queued-execution-port.ts";
import { createTrustedOciProviderAdapters } from "../execution-sandbox/trusted-oci-provider-adapters.ts";
import { createTrustedSandboxProviderResolver } from "../execution-sandbox/trusted-provider-resolver.ts";
import { loadTrustedSandboxProviderReceipts } from "../execution-sandbox/trusted-provider-receipt-store.ts";

function selection(settings?: any) : any {
  if (!settings) return null;
  return {
    enabled: settings.enabled === true,
    providerMode: String(settings.providerMode || "").trim(),
    providerId: String(settings.providerId || "").trim(),
    profileId: String(settings.profileId || "").trim(),
    policyRevision: String(settings.policyRevision || "").trim(),
    allowedProviderClasses: Array.isArray(settings.allowedProviderClasses)
      ? settings.allowedProviderClasses.map((entry?: any) : any => String(entry || "").trim()).filter(Boolean)
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
}: Record<string, any> = {}) : Promise<any> {
  const configuration: any = selection(settings);
  const profiles: any = Object.fromEntries(
    (Array.isArray(settings?.profiles) ? settings.profiles : [])
      .map((profile?: any) : any => [String(profile?.id || "").trim(), profile])
      .filter(([id]: any[]) : any => id)
  );
  const conformanceReceipts: any = loadTrustedSandboxProviderReceipts({ userDataPath });
  const providerResolver: any = createTrustedSandboxProviderResolver({
    configuration,
    adapters: Array.isArray(trustedProviderAdapters)
      ? trustedProviderAdapters
      : createTrustedOciProviderAdapters({ conformanceReceipts })
  });
  const broker: any = createSandboxExecutionBroker({
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
