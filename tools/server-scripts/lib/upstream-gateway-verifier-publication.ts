import { createHash } from "node:crypto";

import { createServiceManifestStore } from "../../../packages/foundation/src/storage/service-manifest-store.ts";
import { SERVICE_MANIFEST_SCHEMA_VERSION } from "../../../packages/foundation/src/storage/storage-ports.ts";
import { initializeLocalSecret } from "../../../packages/foundation/src/security/secrets/local-secret-store.ts";
import { createUpstreamManifestObserver } from "../../../packages/agents/src/upstream-gateway/manifest-observer.ts";

function digest(value?: any) : any {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function verifierOpaqueServiceId(scenarioKey?: any) : any {
  return `svc_${createHash("sha256").update(`upstream-verifier\0${scenarioKey}`).digest("base64url")}`;
}

function typedReferences(service?: any) : any {
  const explicit: any = Array.isArray(service.references) ? service.references : [];
  const credentials: any = [
    ...(Array.isArray(service.credentialRefs) ? service.credentialRefs : []),
    ...(typeof service.credentialRef === "string" ? [service.credentialRef] : [])
  ].map((reference?: any) : any => ({
    type: "credential",
    reference,
    revision: 1,
    use: "request-auth"
  }));
  return [...explicit, ...credentials];
}

function descriptorFor(service?: any) : any {
  const descriptor: Record<string, any> = { allowLocalNetwork: true, ...service };
  delete descriptor.serviceId;
  delete descriptor.references;
  delete descriptor.credentialRefs;
  delete descriptor.credentialRef;
  delete descriptor.disabled;
  return descriptor;
}

export async function seedVerifierUpstreamServices({ userDataPath, services = [] }: Record<string, any> = {}) : Promise<any> {
  const store: any = createServiceManifestStore({ storageRoot: userDataPath });
  let setRevision: any = (await store.readerPort.getSnapshot()).setRevision;
  let setDigest: any = "";
  for (const [index, service] of services.entries()) {
    const serviceId: any = String(service?.serviceId || "");
    const manifest: Record<string, any> = {
      schemaVersion: SERVICE_MANIFEST_SCHEMA_VERSION,
      references: typedReferences(service),
      payload: {
        state: service.disabled === true ? "disabled" : "publishing",
        descriptor: descriptorFor(service)
      },
      metadata: {
        ownerRef: "urn:meshrix:subject:upstream-verifier",
        serviceKeyRef: `urn:meshrix:service-key:${digest(serviceId)}`,
        action: "verifier-seed"
      }
    };
    const outcome: any = await store.writerPort.commitManifestSet({
      serviceId,
      expectedServiceRevision: 0,
      expectedSetRevision: setRevision,
      manifest,
      requestDigest: digest(`upstream-verifier-seed\0${index}\0${serviceId}`)
    });
    setRevision = outcome.setRevision;
    setDigest = outcome.setDigest;
  }
  if (services.length > 0) {
    await store.acknowledgePublished({ setRevision, setDigest });
  }
  return Object.freeze({ setRevision, serviceCount: services.length });
}

export async function loadVerifierPublishedServices({ userDataPath, registry }: Record<string, any> = {}) : Promise<any> {
  if (typeof registry?.replaceFromManifestSnapshot !== "function") {
    throw new TypeError("Verifier upstream runtime registry is required.");
  }
  const store: any = createServiceManifestStore({ storageRoot: userDataPath });
  let acceptedSnapshot: any = null;
  const observer: any = createUpstreamManifestObserver({
    readerPort: store.readerPort,
    onSnapshot: (snapshot?: any) : any => {
      acceptedSnapshot = snapshot;
      return registry.replaceFromManifestSnapshot(snapshot);
    },
    pollIntervalMs: 60_000
  });
  try {
    const outcome: any = await observer.start();
    if (outcome.outcome !== "accepted") {
      throw new Error("Verifier upstream publication was not accepted.");
    }
    return Object.freeze({ ...outcome, snapshot: acceptedSnapshot });
  } finally {
    observer.close();
  }
}

export async function writeVerifierLocalUpstreamSecret({
  userDataPath,
  fixtureUrl,
  secretRef,
  resolvedSecretToken,
  serviceId,
  provider,
  family,
  authType,
  scopes,
  bindNetworkTarget = true,
  trackSecret = () : any => {},
  payload = null
}: Record<string, any> = {}) : Promise<any> {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error("Verifier local secret scopes must be explicit.");
  }
  const endpoint: any = new URL(fixtureUrl);
  const secretPayload: any = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload
    : { token: resolvedSecretToken };
  trackSecret(resolvedSecretToken);
  await initializeLocalSecret({
    dataDir: userDataPath,
    target: {
      provider,
      family,
      authType,
      secretRef,
      scope: {
        serviceId,
        scopes,
        allowedHosts: bindNetworkTarget ? [endpoint.hostname] : [],
        allowedProtocols: bindNetworkTarget ? [endpoint.protocol.replace(/:$/, "")] : []
      }
    },
    payload: secretPayload
  });
}
