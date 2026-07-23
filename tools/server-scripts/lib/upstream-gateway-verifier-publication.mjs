import { createHash } from "node:crypto";

import { createServiceManifestStore } from "../../../packages/foundation/src/storage/service-manifest-store.mjs";
import { SERVICE_MANIFEST_SCHEMA_VERSION } from "../../../packages/foundation/src/storage/storage-ports.mjs";
import { initializeLocalSecret } from "../../../packages/foundation/src/security/secrets/local-secret-store.mjs";
import { createUpstreamManifestObserver } from "../../../packages/agents/src/upstream-gateway/manifest-observer.mjs";

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function verifierOpaqueServiceId(scenarioKey) {
  return `svc_${createHash("sha256").update(`upstream-verifier\0${scenarioKey}`).digest("base64url")}`;
}

function typedReferences(service) {
  const explicit = Array.isArray(service.references) ? service.references : [];
  const credentials = [
    ...(Array.isArray(service.credentialRefs) ? service.credentialRefs : []),
    ...(typeof service.credentialRef === "string" ? [service.credentialRef] : [])
  ].map((reference) => ({
    type: "credential",
    reference,
    revision: 1,
    use: "request-auth"
  }));
  return [...explicit, ...credentials];
}

function descriptorFor(service) {
  const descriptor = { allowLocalNetwork: true, ...service };
  delete descriptor.serviceId;
  delete descriptor.references;
  delete descriptor.credentialRefs;
  delete descriptor.credentialRef;
  delete descriptor.disabled;
  return descriptor;
}

export async function seedVerifierUpstreamServices({ userDataPath, services = [] } = {}) {
  const store = createServiceManifestStore({ storageRoot: userDataPath });
  let setRevision = (await store.readerPort.getSnapshot()).setRevision;
  let setDigest = "";
  for (const [index, service] of services.entries()) {
    const serviceId = String(service?.serviceId || "");
    const manifest = {
      schemaVersion: SERVICE_MANIFEST_SCHEMA_VERSION,
      references: typedReferences(service),
      payload: {
        state: service.disabled === true ? "disabled" : "publishing",
        descriptor: descriptorFor(service)
      },
      metadata: {
        ownerRef: "urn:lico:subject:upstream-verifier",
        serviceKeyRef: `urn:lico:service-key:${digest(serviceId)}`,
        action: "verifier-seed"
      }
    };
    const outcome = await store.writerPort.commitManifestSet({
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

export async function loadVerifierPublishedServices({ userDataPath, registry } = {}) {
  if (typeof registry?.replaceFromManifestSnapshot !== "function") {
    throw new TypeError("Verifier upstream runtime registry is required.");
  }
  const store = createServiceManifestStore({ storageRoot: userDataPath });
  let acceptedSnapshot = null;
  const observer = createUpstreamManifestObserver({
    readerPort: store.readerPort,
    onSnapshot: (snapshot) => {
      acceptedSnapshot = snapshot;
      return registry.replaceFromManifestSnapshot(snapshot);
    },
    pollIntervalMs: 60_000
  });
  try {
    const outcome = await observer.start();
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
  trackSecret = () => {},
  payload = null
} = {}) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error("Verifier local secret scopes must be explicit.");
  }
  const endpoint = new URL(fixtureUrl);
  const secretPayload = payload && typeof payload === "object" && !Array.isArray(payload)
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
