// Loads declarative remote services into the gateway. Service identity and
// manifest authority stay in the publishing application; credential custody
// stays in the local secret store; this composition owns polling and joins.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type {
  UpstreamConfigServicePreparation,
  UpstreamPublishingApplication,
  UpstreamPublishingSubject
} from "#meshrix/agents/upstream-gateway/index";
import { UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION } from "#meshrix/agents/upstream-gateway/index";
import {
  initializeLocalSecret,
  listLocalSecretEntries,
  resolveLocalSecretPayload,
  revokeLocalSecret,
  rotateLocalSecret
} from "@meshrix/foundation/security/secrets/local-secret-store";
import { assertLocalSecretKeyReady } from "@meshrix/foundation/security/secrets/local-secret-key-provider";
import type { LocalSecretKeyProvider } from "@meshrix/foundation/security/secrets/local-secret-key-provider";

const CONFIG_DIRECTORY = "upstream-config";
const CONFIG_FILENAME = "services.json";
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_SERVICES = 256;
const MAX_HEADER_COUNT = 64;
const MAX_HEADER_VALUE_BYTES = 8 * 1024;
const POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}(?:\/[A-Za-z][A-Za-z0-9_.-]{0,63}){0,3}$/u;
const SAFE_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u;
const SAFE_BEARER_TOKEN = /^[A-Za-z0-9._~+/-]+=*$/u;
const SENSITIVE_HEADER_NAME = /(?:^|[-_])(?:authorization|proxy-authorization|auth|cookie|set-cookie|session|api[-_]?key|private[-_]?key|client[-_]?secret|access[-_]?token|refresh[-_]?token|token|credential|secret|password|bearer)(?:$|[-_])/iu;
const CONFIG_SECRET_ROOT = "secret://meshrix/upstream-config/";
const LOADER_SUBJECT: UpstreamPublishingSubject = Object.freeze({
  subjectId: "meshrix:config-file",
  scopes: ["gateway:admin", "gateway:maintain", "gateway:write", "gateway:read"]
});

type ConfigService = Readonly<{
  name: string;
  type: "http" | "json-rpc" | "mcp";
  url: string;
  auth: Readonly<{ type: "bearer"; token: string }> | null;
  headers: Readonly<Record<string, string>>;
}>;

type SafeLoaderError = Readonly<{ code: string; message: string }>;
type LoaderResult = Readonly<{ ok: true; applied: number }>;
type SecretEntry = Awaited<ReturnType<typeof listLocalSecretEntries>>[number];
type TypedReference = UpstreamConfigServicePreparation["currentReferences"][number];

interface LoaderOptions {
  userDataPath?: string;
  publishingApplication?: UpstreamPublishingApplication | null;
  localSecretKeyProvider?: LocalSecretKeyProvider | null;
  onError?: ((error: SafeLoaderError | null, result: LoaderResult | null) => void) | null;
  pollIntervalMs?: number;
}

class ConfigLoaderFailure extends Error {
  readonly safeCode: string;

  constructor(safeCode: string, message: string) {
    super(message);
    this.name = "ConfigLoaderFailure";
    this.safeCode = safeCode;
  }
}

const SAFE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  "config.invalid": "Upstream service configuration is invalid.",
  "config.read_failed": "Upstream service configuration could not be read.",
  "credential.provider_required": "An external credential key provider is required for authenticated upstream services.",
  "credential.custody_unavailable": "External credential custody is unavailable.",
  "credential.reference_conflict": "Credential state changed concurrently; the configuration will be retried.",
  "publication.conflict": "Upstream service publication changed concurrently; the configuration will be retried.",
  "publication.failed": "Upstream service configuration could not be published."
});

function fail(code: keyof typeof SAFE_MESSAGES): never {
  throw new ConfigLoaderFailure(code, SAFE_MESSAGES[code]);
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "";
}

function publicFailure(error: unknown): SafeLoaderError {
  if (error instanceof ConfigLoaderFailure) {
    return Object.freeze({ code: error.safeCode, message: error.message });
  }
  const code = errorCode(error);
  if (code.startsWith("local_secret_") || code.startsWith("upstream_credential_")) {
    return Object.freeze({
      code: "credential.custody_unavailable",
      message: SAFE_MESSAGES["credential.custody_unavailable"]
    });
  }
  const statusCode = error && typeof error === "object" && "statusCode" in error
    ? Number((error as { statusCode?: unknown }).statusCode)
    : 0;
  if (
    statusCode === 409 ||
    code === "storage_manifest_replay_conflict" ||
    code === "storage_manifest_service_revision_stale" ||
    code === "storage_manifest_set_revision_stale"
  ) {
    return Object.freeze({ code: "publication.conflict", message: SAFE_MESSAGES["publication.conflict"] });
  }
  if (code.startsWith("upstream_publishing_")) {
    return Object.freeze({ code: "publication.failed", message: SAFE_MESSAGES["publication.failed"] });
  }
  if (code.startsWith("E")) {
    return Object.freeze({ code: "config.read_failed", message: SAFE_MESSAGES["config.read_failed"] });
  }
  return Object.freeze({ code: "publication.failed", message: SAFE_MESSAGES["publication.failed"] });
}

function notify(
  onError: LoaderOptions["onError"],
  error: SafeLoaderError | null,
  result: LoaderResult | null
): void {
  try {
    onError?.(error, result);
  } catch {
    // Diagnostic consumers cannot change publication or lifecycle outcomes.
  }
}

function fingerprint(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function parseConfig(raw: string): readonly ConfigService[] {
  if (Buffer.byteLength(raw, "utf8") > MAX_CONFIG_BYTES) fail("config.invalid");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Parser diagnostics can echo untrusted source fragments, including secrets.
    fail("config.invalid");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("config.invalid");
  const root = parsed as Record<string, unknown>;
  if (Object.keys(root).some((key) => key !== "services") || !Array.isArray(root.services)) {
    fail("config.invalid");
  }
  if (root.services.length > MAX_SERVICES) fail("config.invalid");

  const seenNames = new Set<string>();
  const services = root.services.map((candidate): ConfigService => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) fail("config.invalid");
    const entry = candidate as Record<string, unknown>;
    if (Object.keys(entry).some((key) => !["name", "type", "url", "auth", "headers"].includes(key))) {
      fail("config.invalid");
    }
    if (typeof entry.name !== "string" || !SAFE_NAME.test(entry.name) || seenNames.has(entry.name)) {
      fail("config.invalid");
    }
    seenNames.add(entry.name);

    if (entry.type !== "http" && entry.type !== "json-rpc" && entry.type !== "mcp") fail("config.invalid");
    if (typeof entry.url !== "string") fail("config.invalid");
    const url = entry.url;
    const explicitPort = /^https?:\/\/(?:\[[0-9a-f:]+\]|[^/?#:@]+):([0-9]{1,5})(?:[/?#]|$)/iu.exec(url);
    if (!explicitPort) fail("config.invalid");
    const port = Number(explicitPort[1]);
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      fail("config.invalid");
    }
    if (
      !["http:", "https:"].includes(parsedUrl.protocol) ||
      parsedUrl.username || parsedUrl.password ||
      !parsedUrl.hostname || !Number.isInteger(port) || port < 1 || port > 65_535
    ) {
      fail("config.invalid");
    }

    let auth: ConfigService["auth"] = null;
    if (entry.auth !== undefined && entry.auth !== null) {
      if (typeof entry.auth !== "object" || Array.isArray(entry.auth)) fail("config.invalid");
      const authInput = entry.auth as Record<string, unknown>;
      if (
        Object.keys(authInput).some((key) => key !== "type" && key !== "token") ||
        authInput.type !== "bearer" || typeof authInput.token !== "string" ||
        authInput.token.length === 0 || authInput.token.length > 8 * 1024 ||
        !SAFE_BEARER_TOKEN.test(authInput.token)
      ) {
        fail("config.invalid");
      }
      auth = Object.freeze({ type: "bearer", token: authInput.token });
    }

    let headers: Record<string, string> = {};
    if (entry.headers !== undefined) {
      if (!entry.headers || typeof entry.headers !== "object" || Array.isArray(entry.headers)) fail("config.invalid");
      const input = entry.headers as Record<string, unknown>;
      const pairs = Object.entries(input);
      if (pairs.length > MAX_HEADER_COUNT) fail("config.invalid");
      headers = {};
      for (const [name, value] of pairs) {
        if (
          !SAFE_HEADER_NAME.test(name) || POLLUTION_KEYS.has(name) || SENSITIVE_HEADER_NAME.test(name) ||
          typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_HEADER_VALUE_BYTES ||
          /[\u0000-\u0008\u000a-\u001f\u007f]/u.test(value)
        ) {
          fail("config.invalid");
        }
        headers[name] = value;
      }
    }

    return Object.freeze({
      name: entry.name,
      type: entry.type,
      url,
      auth,
      headers: Object.freeze(headers)
    });
  });
  return Object.freeze(services);
}

function descriptorFor(service: ConfigService): Readonly<Record<string, unknown>> {
  const base = {
    serviceProtocol: service.type,
    label: service.name,
    description: `Declared by upstream config file (${service.name}).`,
    allowLocalNetwork: true
  };
  if (service.type === "mcp") {
    return Object.freeze({
      ...base,
      mcp: Object.freeze({
        transport: "http",
        url: service.url,
        ...(Object.keys(service.headers).length > 0 ? { headers: service.headers } : {})
      })
    });
  }
  return Object.freeze({
    ...base,
    baseUrl: service.url,
    operations: Object.freeze([Object.freeze({
      operationKey: "default",
      method: "POST",
      path: "/",
      risk: "safe_write",
      payloadTransport: Object.freeze({
        request: Object.freeze({ mode: "structured_json", maxBytes: 1_048_576, mediaTypes: Object.freeze(["application/json"]) }),
        response: Object.freeze({ mode: "structured_json", maxBytes: 1_048_576, mediaTypes: Object.freeze(["application/json"]) })
      })
    })])
  });
}

function ownerSecretNamespace(serviceId: string): string {
  const owner = createHash("sha256").update(serviceId).digest("hex").slice(0, 32);
  return `${CONFIG_SECRET_ROOT}${owner}/`;
}

function namespaceForConfigSecret(secretRef: string): string | null {
  if (!secretRef.startsWith(CONFIG_SECRET_ROOT)) return null;
  const owner = secretRef.slice(CONFIG_SECRET_ROOT.length).split("/", 1)[0];
  return /^[a-f0-9]{32}$/u.test(owner) ? `${CONFIG_SECRET_ROOT}${owner}/` : null;
}

function credentialReference(serviceId: string, serviceRevision: number): string {
  return `${ownerSecretNamespace(serviceId)}r${serviceRevision}`;
}

function isLoaderCredentialReference(reference: string, namespace: string): boolean {
  return reference.startsWith(namespace);
}

function secretTarget(serviceId: string, reference: string, url: URL) {
  return Object.freeze({
    provider: "meshrix",
    family: "http-header",
    authType: "header",
    secretRef: reference,
    scope: Object.freeze({
      serviceId,
      scopes: Object.freeze(["gateway:read", "gateway:write"]),
      allowedHosts: Object.freeze([url.hostname]),
      allowedProtocols: Object.freeze([url.protocol.slice(0, -1)])
    })
  });
}

function typedCredentialReference(reference: string, revision: number, url: URL): TypedReference {
  return Object.freeze({
    type: "credential",
    reference,
    revision,
    use: "request-auth",
    host: url.hostname,
    protocol: url.protocol.slice(0, -1),
    scopes: []
  });
}

function referencesForPublication(
  source: readonly TypedReference[],
  namespace: string,
  credential: TypedReference | null
): readonly TypedReference[] {
  const retained = source.filter((entry) => !isLoaderCredentialReference(entry.reference, namespace));
  if (credential) retained.push(credential);
  return Object.freeze(retained.sort((left, right) => left.reference.localeCompare(right.reference)));
}

function sameReferences(left: readonly TypedReference[], right: readonly TypedReference[]): boolean {
  const normalize = (values: readonly TypedReference[]) => values
    .map((entry) => ({
      type: entry.type,
      reference: entry.reference,
      revision: entry.revision,
      use: entry.use,
      operationKey: entry.operationKey || "",
      host: entry.host || "",
      protocol: entry.protocol || "",
      scopes: [...(entry.scopes || [])].sort()
    }))
    .sort((a, b) => a.reference.localeCompare(b.reference) || a.revision - b.revision);
  return isDeepStrictEqual(normalize(left), normalize(right));
}

function desiredBearer(service: ConfigService): string {
  return `Bearer ${service.auth?.token || ""}`;
}

async function resolveExistingCredential({
  userDataPath,
  secretRef,
  revision,
  serviceId,
  host,
  protocol,
  keyProvider
}: {
  userDataPath: string;
  secretRef: string;
  revision: number;
  serviceId: string;
  host: string;
  protocol: string;
  keyProvider: LocalSecretKeyProvider;
}): Promise<Readonly<{ revision: number; authorization: string }>> {
  const resolved = await resolveLocalSecretPayload({
    dataDir: userDataPath,
    secretRef,
    expectedRevision: revision,
    expectedScope: Object.freeze({
      serviceId,
      requiredScopes: Object.freeze(["gateway:read", "gateway:write"]),
      host,
      protocol
    }),
    keyProvider
  });
  const headers = resolved.payload?.headers;
  const authorization = headers && typeof headers === "object" && !Array.isArray(headers)
    ? (headers as Record<string, unknown>).authorization
    : null;
  if (typeof authorization !== "string") fail("credential.custody_unavailable");
  return Object.freeze({ revision: resolved.revision, authorization });
}

async function prepareCredential({
  service,
  preparation,
  userDataPath,
  keyProvider,
  secretEntries
}: {
  service: ConfigService;
  preparation: UpstreamConfigServicePreparation;
  userDataPath: string;
  keyProvider: LocalSecretKeyProvider | null;
  secretEntries: Map<string, SecretEntry>;
}): Promise<TypedReference | null> {
  const namespace = ownerSecretNamespace(preparation.serviceId);
  const serviceUrl = new URL(service.url);
  const currentCredentialReferences = preparation.currentReferences.filter((entry) =>
    entry.type === "credential" && isLoaderCredentialReference(entry.reference, namespace)
  );

  if (!service.auth) return null;
  if (!keyProvider) fail("credential.provider_required");

  if (currentCredentialReferences.length > 1) fail("credential.reference_conflict");
  if (currentCredentialReferences.length === 1) {
    const bound = currentCredentialReferences[0];
    const previousUrl = descriptorUrl(preparation.currentDescriptor) || serviceUrl;
    let resolved: Readonly<{ revision: number; authorization: string }>;
    try {
      resolved = await resolveExistingCredential({
        userDataPath,
        secretRef: bound.reference,
        revision: bound.revision,
        serviceId: preparation.serviceId,
        host: bound.host || previousUrl.hostname,
        protocol: bound.protocol || previousUrl.protocol.slice(0, -1),
        keyProvider
      });
    } catch {
      fail("credential.custody_unavailable");
    }
    if (
      resolved.authorization === desiredBearer(service) &&
      (bound.host || previousUrl.hostname) === serviceUrl.hostname &&
      (bound.protocol || previousUrl.protocol.slice(0, -1)) === serviceUrl.protocol.slice(0, -1)
    ) {
      return typedCredentialReference(bound.reference, resolved.revision, serviceUrl);
    }
  }

  const nextReference = credentialReference(preparation.serviceId, preparation.expectedServiceRevision + 1);
  const alreadyReferenced = [...preparation.currentReferences, ...preparation.publishedReferences]
    .some((entry) => entry.reference === nextReference);
  const existing = secretEntries.get(nextReference);
  const target = secretTarget(preparation.serviceId, nextReference, serviceUrl);
  const payload = Object.freeze({ headers: Object.freeze({ authorization: desiredBearer(service) }) });

  if (existing && existing.status !== "active") fail("credential.custody_unavailable");
  if (existing && alreadyReferenced) {
    try {
      const resolved = await resolveExistingCredential({
        userDataPath,
        secretRef: nextReference,
        revision: existing.revision,
        serviceId: preparation.serviceId,
        host: serviceUrl.hostname,
        protocol: serviceUrl.protocol.slice(0, -1),
        keyProvider
      });
      if (resolved.authorization === desiredBearer(service)) {
        return typedCredentialReference(nextReference, resolved.revision, serviceUrl);
      }
    } catch {
      fail("credential.reference_conflict");
    }
    fail("credential.reference_conflict");
  }

  if (existing) {
    try {
      const resolved = await resolveExistingCredential({
        userDataPath,
        secretRef: nextReference,
        revision: existing.revision,
        serviceId: preparation.serviceId,
        host: serviceUrl.hostname,
        protocol: serviceUrl.protocol.slice(0, -1),
        keyProvider
      });
      if (resolved.authorization === desiredBearer(service)) {
        return typedCredentialReference(nextReference, resolved.revision, serviceUrl);
      }
    } catch (error) {
      if (errorCode(error) !== "local_secret_scope_denied") {
        // Only an unbound preparation is eligible for replacement; referenced
        // entries take the conflict path above and remain untouched.
        const canRotate = existing.credentialConfigured && existing.revision > 0;
        if (!canRotate) fail("credential.custody_unavailable");
      }
    }
    try {
      const rotated = await rotateLocalSecret({
        dataDir: userDataPath,
        keyProvider,
        target,
        payload,
        expectedRevision: existing.revision
      });
      secretEntries.set(nextReference, rotated.secret as SecretEntry);
      return typedCredentialReference(nextReference, rotated.secret.revision, serviceUrl);
    } catch {
      fail("credential.custody_unavailable");
    }
  }

  try {
    const initialized = await initializeLocalSecret({
      dataDir: userDataPath,
      keyProvider,
      target,
      payload
    });
    secretEntries.set(nextReference, initialized.secret as SecretEntry);
    return typedCredentialReference(nextReference, initialized.secret.revision, serviceUrl);
  } catch {
    fail("credential.custody_unavailable");
  }
}

function commandFor({
  service,
  preparation,
  descriptor,
  references
}: {
  service: ConfigService;
  preparation: UpstreamConfigServicePreparation;
  descriptor: Readonly<Record<string, unknown>>;
  references: readonly TypedReference[];
}): Readonly<Record<string, unknown>> {
  const finalDescriptor = Object.freeze({ ...descriptor, references });
  const idempotency = createHash("sha256")
    .update(JSON.stringify({
      serviceKey: service.name,
      action: preparation.action,
      serviceRevision: preparation.expectedServiceRevision,
      setRevision: preparation.expectedSetRevision,
      descriptor: finalDescriptor
    }))
    .digest("hex")
    .slice(0, 40);
  return Object.freeze({
    schemaVersion: UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION,
    action: preparation.action,
    expectedServiceRevision: preparation.expectedServiceRevision,
    expectedSetRevision: preparation.expectedSetRevision,
    idempotencyKey: `config-file-${idempotency}`,
    ...(preparation.action === "create"
      ? { serviceKey: service.name }
      : { serviceId: preparation.serviceId }),
    descriptor: finalDescriptor
  });
}

async function authoritativePreparation(
  application: UpstreamPublishingApplication,
  service: ConfigService,
  descriptor: Readonly<Record<string, unknown>>
): Promise<UpstreamConfigServicePreparation> {
  return application.prepareConfigFileService(service.name, descriptor, LOADER_SUBJECT);
}

function descriptorUrl(descriptor: UpstreamConfigServicePreparation["currentDescriptor"]): URL | null {
  if (!descriptor) return null;
  const candidate = descriptor.serviceProtocol === "mcp"
    ? (descriptor.mcp as Record<string, unknown> | undefined)?.url
    : descriptor.baseUrl || (Array.isArray(descriptor.endpoints)
      ? (descriptor.endpoints[0] as Record<string, unknown> | undefined)?.baseUrl
      : undefined);
  if (typeof candidate !== "string") return null;
  try {
    return new URL(candidate);
  } catch {
    return null;
  }
}

function publicationMatches(
  preparation: UpstreamConfigServicePreparation,
  descriptor: Readonly<Record<string, unknown>>,
  references: readonly TypedReference[]
): boolean {
  return Boolean(
    preparation.currentDescriptor &&
    isDeepStrictEqual(preparation.currentDescriptor, descriptor) &&
    sameReferences(preparation.currentReferences, references)
  );
}

export function createUpstreamConfigFileLoader({
  userDataPath = "",
  publishingApplication = null,
  localSecretKeyProvider = null,
  onError = null,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
}: LoaderOptions = {}) {
  if (
    !userDataPath ||
    !publishingApplication ||
    typeof publishingApplication.prepareConfigFileService !== "function" ||
    typeof publishingApplication.execute !== "function"
  ) {
    throw new TypeError("Upstream config file loader requires a data path and a publishing application.");
  }
  const application: UpstreamPublishingApplication = publishingApplication;

  const configDir = path.join(userDataPath, CONFIG_DIRECTORY);
  const configPath = path.join(configDir, CONFIG_FILENAME);
  const intervalMs = Math.max(500, Math.min(Number(pollIntervalMs || DEFAULT_POLL_INTERVAL_MS), 60_000));
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  let pendingScan = false;
  let activeScan: Promise<void> | null = null;
  let startPromise: Promise<void> | null = null;
  let closePromise: Promise<void> | null = null;
  let lastAcceptedFingerprint: string | null = null;
  let lastError: SafeLoaderError | null = null;
  const cleanupTargets = new Map<string, Readonly<{ serviceKey: string; descriptor: Readonly<Record<string, unknown>> }>>();

  async function prepareService(
    service: ConfigService,
    descriptor: Readonly<Record<string, unknown>>,
    secretEntries: Map<string, SecretEntry>
  ): Promise<Readonly<{ preparation: UpstreamConfigServicePreparation; references: readonly TypedReference[] }> | null> {
    const preparation = await authoritativePreparation(application, service, descriptor);
    if (closed) return null;
    cleanupTargets.set(service.name, Object.freeze({ serviceKey: service.name, descriptor }));
    const namespace = ownerSecretNamespace(preparation.serviceId);
    const credential = await prepareCredential({
      service,
      preparation,
      userDataPath,
      keyProvider: localSecretKeyProvider,
      secretEntries
    });
    if (closed) return null;
    return Object.freeze({
      preparation,
      references: referencesForPublication(preparation.currentReferences, namespace, credential)
    });
  }

  async function applyService(
    service: ConfigService,
    secretEntries: Map<string, SecretEntry>
  ): Promise<boolean> {
    const descriptor = descriptorFor(service);
    const prepared = await prepareService(service, descriptor, secretEntries);
    if (!prepared || closed) return false;
    const { preparation, references } = prepared;

    if (!publicationMatches(preparation, descriptor, references)) {
      const command = commandFor({ service, preparation, descriptor, references });
      if (closed) return false;
      try {
        await application.execute(JSON.stringify(command), LOADER_SUBJECT);
      } catch (error) {
        if (closed) return false;
        let observed: UpstreamConfigServicePreparation;
        try {
          observed = await authoritativePreparation(application, service, descriptor);
        } catch {
          throw error;
        }
        if (!publicationMatches(observed, descriptor, references)) throw error;
      }
    }

    const latest = await authoritativePreparation(application, service, descriptor);
    if (!publicationMatches(latest, descriptor, references)) fail("publication.conflict");
    cleanupTargets.set(service.name, Object.freeze({ serviceKey: service.name, descriptor }));
    return true;
  }

  async function reconcileCleanup(secretEntries = new Map<string, SecretEntry>()): Promise<boolean> {
    if (cleanupTargets.size === 0 || closed) return true;
    let allClean = true;
    const entries = secretEntries.size > 0
      ? [...secretEntries.values()]
      : await listLocalSecretEntries({ dataDir: userDataPath });
    if (secretEntries.size === 0) {
      for (const entry of entries) secretEntries.set(entry.secretRef, entry);
    }
    const entriesByNamespace = new Map<string, SecretEntry[]>();
    for (const entry of entries) {
      const namespace = namespaceForConfigSecret(entry.secretRef);
      if (!namespace) continue;
      const group = entriesByNamespace.get(namespace);
      if (group) group.push(entry);
      else entriesByNamespace.set(namespace, [entry]);
    }

    for (const [serviceKey, target] of cleanupTargets) {
      if (closed) return false;
      const preparation = await application.prepareConfigFileService(
        target.serviceKey,
        target.descriptor,
        LOADER_SUBJECT
      );
      const namespace = ownerSecretNamespace(preparation.serviceId);
      const candidateRefs = new Set(preparation.currentReferences.map((entry) => entry.reference));
      const publishedRefs = new Set(preparation.publishedReferences.map((entry) => entry.reference));
      const pendingPreparationRef = credentialReference(
        preparation.serviceId,
        preparation.expectedServiceRevision + 1
      );
      const ownedEntries = entriesByNamespace.get(namespace) || [];
      const protectedRefs = new Set([
        ...candidateRefs,
        ...publishedRefs,
        pendingPreparationRef
      ]);
      let pending = false;
      for (const entry of ownedEntries) {
        if (entry.status !== "active") continue;
        if (protectedRefs.has(entry.secretRef)) {
          if (publishedRefs.has(entry.secretRef) && !candidateRefs.has(entry.secretRef)) pending = true;
          continue;
        }
        if (closed) return false;
        try {
          await revokeLocalSecret({
            dataDir: userDataPath,
            secretRef: entry.secretRef,
            expectedRevision: entry.revision
          });
          const revoked = Object.freeze({ ...entry, status: "revoked", credentialConfigured: false, revision: entry.revision + 1 }) as SecretEntry;
          secretEntries.set(entry.secretRef, revoked);
        } catch (error) {
          if (errorCode(error) === "local_secret_revision_conflict") {
            pending = true;
            allClean = false;
            continue;
          }
          if (errorCode(error) === "local_secret_revoked") continue;
          pending = true;
          allClean = false;
        }
      }
      if (!pending) cleanupTargets.delete(serviceKey);
    }
    return allClean;
  }

  async function applyConfig(raw: string): Promise<number | null> {
    const services = parseConfig(raw);
    if (services.some((service) => service.auth)) {
      if (!localSecretKeyProvider) fail("credential.provider_required");
      try {
        await assertLocalSecretKeyReady({ dataDir: userDataPath, keyProvider: localSecretKeyProvider });
      } catch {
        fail("credential.custody_unavailable");
      }
    }

    const secrets = services.some((service) => service.auth)
      ? await listLocalSecretEntries({ dataDir: userDataPath })
      : [];
    const secretEntries = new Map(secrets.map((entry) => [entry.secretRef, entry]));
    let applied = 0;
    for (const service of services) {
      if (closed) return null;
      if (!await applyService(service, secretEntries)) return null;
      applied += 1;
    }
    if (closed) return null;
    return applied;
  }

  async function readConfig(): Promise<string | null> {
    try {
      return await fs.readFile(configPath, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw new ConfigLoaderFailure("config.read_failed", SAFE_MESSAGES["config.read_failed"]);
    }
  }

  async function scanOnce(): Promise<void> {
    if (closed) return;
    try {
      const raw = await readConfig();
      if (closed) return;
      if (raw === null) {
        lastAcceptedFingerprint = null;
      } else {
        const currentFingerprint = fingerprint(raw);
        if (currentFingerprint !== lastAcceptedFingerprint) {
          const applied = await applyConfig(raw);
          if (applied === null || closed) return;
          lastAcceptedFingerprint = currentFingerprint;
          notify(onError, null, Object.freeze({ ok: true, applied }));
        }
      }

      if (closed) return;
      const cleanupSucceeded = await reconcileCleanup();
      if (closed) return;
      if (cleanupSucceeded) lastError = null;
      else {
        lastError = Object.freeze({ code: "credential.custody_unavailable", message: SAFE_MESSAGES["credential.custody_unavailable"] });
        notify(onError, lastError, null);
      }
    } catch (error) {
      if (closed) return;
      lastError = publicFailure(error);
      notify(onError, lastError, null);
      try {
        // Reconcile only against the authoritative candidate and published
        // reference sets. The next deterministic reference remains reusable
        // for an unchanged retry; references made stale by concurrent commits
        // can be revoked with their actual revision.
        await reconcileCleanup();
      } catch {
        // Preserve the original safe failure; the next scan retries cleanup.
      }
    }
  }

  async function runScanLoop(): Promise<void> {
    do {
      pendingScan = false;
      await scanOnce();
    } while (pendingScan && !closed);
  }

  function scan(): Promise<void> {
    if (closed) return Promise.resolve();
    if (activeScan) {
      pendingScan = true;
      return activeScan;
    }
    const operation = runScanLoop();
    activeScan = operation;
    void operation.finally(() => {
      if (activeScan === operation) activeScan = null;
    });
    return operation;
  }

  function start(): Promise<void> {
    if (startPromise) return startPromise;
    if (closed) return Promise.resolve();
    startPromise = (async () => {
      await scan();
      if (closed || timer) return;
      timer = setInterval(() => { void scan(); }, intervalMs);
      timer.unref?.();
    })();
    return startPromise;
  }

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closed = true;
    pendingScan = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    closePromise = (async () => {
      await Promise.all([activeScan || Promise.resolve(), startPromise || Promise.resolve()]);
    })();
    return closePromise;
  }

  return Object.freeze({
    start,
    close,
    scan,
    get lastError(): SafeLoaderError | null { return lastError; },
    configPath
  });
}
